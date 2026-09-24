import crypto from "node:crypto";
import https from "node:https";
import { cursorChecksum } from "./credentials.mjs";
import { AppError, hardStopStatus, rateLimitError } from "./errors.mjs";
import { parseProto, protoField, protoMessage } from "./proto.mjs";
import { SessionAgents } from "./session-agents.mjs";

const BACKEND = new URL("https://api2.cursor.sh/aiserver.v1.GrokBotService/");
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TRANSCRIPT_LIMIT = 100;

// This transport is deliberately separate from InferenceService. Grok Bot
// desktop 0.30.0 sends a prompt to this service, then renders replies from its
// durable transcript rather than from the retired inference Connect stream.
export class GrokBotServiceClient {
  constructor(config = {}) {
    this.backend = serviceBackend(config.serviceBackend || BACKEND);
    this.sessionAgents = config.sessionAgents || new SessionAgents({ path: config.sessionStorePath });
    this.timeoutMs = positiveInteger(config.timeoutMs, 90_000);
    this.pollIntervalMs = positiveInteger(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.transcriptLimit = boundedInteger(config.transcriptLimit, DEFAULT_TRANSCRIPT_LIMIT, 1, 500);
    this.maxResponseBytes = positiveInteger(config.maxResponseBytes, 8 * 1024 * 1024);
    this.randomUuid = config.randomUuid || crypto.randomUUID;
  }

  async *stream(request, credentials) {
    assertTextOnlyRequest(request);
    const prompt = latestUserPrompt(request.messages);
    const agentId = await this.sessionAgents.resolve(request.sessionKey, credentials, this, request.signal);
    const upstreamRequestId = request.requestId || this.randomUuid();
    const baselinePage = await this.listTranscriptEntries(agentId, undefined, this.transcriptLimit, credentials, upstreamRequestId, request.signal);
    const baseline = transcriptBaseline(baselinePage);
    const sentAtMs = Date.now();
    const messageId = this.randomUuid();
    const send = await this.sendUserMessage({
      agentId,
      messageId,
      text: prompt,
      sentAtMs,
      source: "desktop"
    }, credentials, upstreamRequestId, request.signal);
    if (send.delivery === "refused") {
      throw new AppError("grokbot_message_refused", "Grok Bot refused the message", 502, "api_error", {
        upstreamErrorSource: "grokbot_service",
        upstreamOriginalCode: send.refusalCode || "refused"
      });
    }

    await this.assertSendAccepted(agentId, messageId, credentials, upstreamRequestId, request.signal);
    const text = await this.waitForAssistantText({
      agentId,
      baseline,
      messageId,
      credentials,
      requestId: upstreamRequestId,
      signal: request.signal
    });
    yield { type: "text", text };
    yield {
      type: "done",
      state: {
        text,
        endFrames: 1,
        usage: null,
        extendedUsage: null,
        errors: []
      }
    };
  }

  async listAgents(credentials, requestId = crypto.randomUUID(), signal) {
    const body = protoMessage([protoField(2, 0, 1)]);
    const response = await this.unary("ListGrokBotAgents", body, credentials, requestId, signal);
    return decodeListAgentsResponse(response);
  }

  async createAgent(agentId, credentials, requestId = crypto.randomUUID(), signal) {
    const response = await this.unary("CreateGrokBotAgent", buildCreateGrokBotAgentRequest(agentId), credentials, requestId, signal);
    const agent = messageField(parseProto(response), 1);
    return { id: agent ? textField(agent, 12) : "" };
  }

  async sendUserMessage(input, credentials, requestId = crypto.randomUUID(), signal) {
    const body = buildSendGrokBotUserMessageRequest(input);
    const response = await this.unary("SendGrokBotUserMessage", body, credentials, requestId, signal);
    return decodeSendGrokBotUserMessageResponse(response);
  }

  async getSendStatus(agentId, messageId, credentials, requestId = crypto.randomUUID(), signal) {
    const body = buildGetGrokBotSendStatusRequest({ agentId, messageId });
    const response = await this.unary("GetGrokBotSendStatus", body, credentials, requestId, signal);
    return decodeGrokBotSendStatusResponse(response);
  }

  async listTranscriptEntries(agentId, generation, limit, credentials, requestId = crypto.randomUUID(), signal) {
    const body = buildListGrokBotTranscriptEntriesRequest({ agentId, generation, limit });
    const response = await this.unary("ListGrokBotTranscriptEntries", body, credentials, requestId, signal);
    return decodeListGrokBotTranscriptEntriesResponse(response);
  }

  async assertSendAccepted(agentId, messageId, credentials, requestId, signal) {
    const status = await this.getSendStatus(agentId, messageId, credentials, requestId, signal);
    if (status.status === "rejected") {
      throw new AppError("grokbot_message_rejected", "Grok Bot rejected the message", 502, "api_error", {
        upstreamErrorSource: "grokbot_service",
        upstreamOriginalCode: status.rejectionCode || "rejected"
      });
    }
    if (status.status === "not_found") {
      throw new AppError("grokbot_message_not_found", "Grok Bot did not retain the sent message", 502, "api_error", {
        upstreamErrorSource: "grokbot_service",
        upstreamOriginalCode: "not_found"
      });
    }
  }

  async waitForAssistantText({ agentId, baseline, messageId, credentials, requestId, signal }) {
    const deadline = Date.now() + this.timeoutMs;
    let lastCandidate = null;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const page = await this.listTranscriptEntries(agentId, baseline.generation, this.transcriptLimit, credentials, requestId, signal);
      if (page.generation !== baseline.generation) {
        throw new AppError(
          "grokbot_transcript_generation_changed",
          "Grok Bot transcript changed while waiting for the reply; retry the request",
          502,
          "api_error",
          { upstreamErrorSource: "grokbot_service", upstreamOriginalCode: "generation_changed" }
        );
      }
      const candidate = newestAssistantText(page.entries, baseline, messageId);
      if (candidate) {
        if (candidate.isStreaming === false) return candidate.text;
        // Older server rows did not always expose isStreaming. Require the
        // exact row/version to be stable across two reads before returning it.
        if (lastCandidate && lastCandidate.key === candidate.key && lastCandidate.text === candidate.text) return candidate.text;
        lastCandidate = candidate;
      }
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
    throw new AppError(
      "grokbot_response_timeout",
      "Timed out waiting for a Grok Bot transcript reply",
      504,
      "api_error",
      { upstreamErrorSource: "grokbot_service", upstreamOriginalCode: "response_timeout" }
    );
  }

  async unary(method, body, credentials, requestId = crypto.randomUUID(), signal) {
    const response = await this.open(method, credentials, body, requestId, signal);
    if (response.status !== 200) {
      response.body.destroy();
      throw upstreamHttpError(response.status);
    }
    return readResponseBody(response.body, this.maxResponseBytes);
  }

  open(method, credentials, body, requestId = crypto.randomUUID(), signal) {
    const endpoint = new URL(method, this.backend);
    return new Promise((resolve, reject) => {
      const request = https.request(endpoint, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/proto",
          "connect-protocol-version": "1",
          "user-agent": "connect-es/1.6.1",
          authorization: `Bearer ${credentials.accessToken}`,
          "x-cursor-checksum": cursorChecksum(credentials.machineId),
          "x-cursor-client-type": "sand",
          "x-cursor-client-version": credentials.clientVersion || "0.30.0",
          "x-sand-box-namespace": "prod",
          "x-ghost-mode": "true",
          "x-request-id": requestId,
          "content-length": String(body.length)
        },
        timeout: this.timeoutMs
      }, (response) => {
        resolve({ status: response.statusCode || 0, headers: response.headers, body: response });
      });
      request.on("timeout", () => request.destroy(new AppError("upstream_timeout", "Grok Bot upstream request timed out", 504)));
      request.on("error", reject);
      request.end(body);
    });
  }
}

export function buildCreateGrokBotAgentRequest(agentId) {
  const id = requiredString(agentId, "agentId");
  return protoMessage([
    protoField(1, 2, id),
    protoField(2, 2, "Pi session"),
    protoField(3, 2, "Isolated Pi Coding Agent conversation"),
    protoField(4, 2, "Pi session"),
    protoField(5, 2, "circle"),
    protoField(6, 2, "blue"),
    protoField(8, 2, id),
    protoField(9, 0, 2), // TEMPORAL
    protoField(11, 0, 1) // Suppress the introduction message.
  ]);
}

export function buildSendGrokBotUserMessageRequest(input) {
  const fields = [
    protoField(1, 2, requiredString(input.agentId, "agentId")),
    protoField(2, 2, requiredString(input.messageId, "messageId")),
    protoField(3, 2, requiredString(input.text, "text")),
    protoField(4, 0, requiredTimestamp(input.sentAtMs)),
    protoField(13, 0, clientSurface(input.source))
  ];
  if (stringValue(input.richText)) fields.push(protoField(5, 2, input.richText));
  if (stringValue(input.replyToId)) fields.push(protoField(6, 2, input.replyToId));
  if (input.isFork === true) fields.push(protoField(7, 0, 1));
  for (const attachmentPath of input.attachmentPaths || []) fields.push(protoField(8, 2, attachmentPath));
  for (const attachmentName of input.attachmentNames || []) fields.push(protoField(9, 2, attachmentName));
  if (stringValue(input.traceparent)) fields.push(protoField(10, 2, input.traceparent));
  if (input.enterEpochMs !== undefined) fields.push(protoField(11, 0, requiredTimestamp(input.enterEpochMs)));
  if (input.composedAtMs !== undefined) fields.push(protoField(12, 0, requiredTimestamp(input.composedAtMs)));
  return protoMessage(fields);
}

export function buildGetGrokBotSendStatusRequest({ agentId, messageId }) {
  return protoMessage([
    protoField(1, 2, requiredString(agentId, "agentId")),
    protoField(2, 2, requiredString(messageId, "messageId"))
  ]);
}

export function buildListGrokBotTranscriptEntriesRequest({ agentId, generation, beforeSeq, limit = DEFAULT_TRANSCRIPT_LIMIT }) {
  const fields = [protoField(1, 2, requiredString(agentId, "agentId"))];
  if (Number.isInteger(generation) && generation >= 0) fields.push(protoField(2, 0, generation));
  if (beforeSeq !== undefined) fields.push(protoField(3, 0, requiredTimestamp(beforeSeq)));
  fields.push(protoField(4, 0, boundedInteger(limit, DEFAULT_TRANSCRIPT_LIMIT, 1, 500)));
  return protoMessage(fields);
}

export function decodeListAgentsResponse(bytes) {
  return parseProto(bytes)
    .filter((field) => field.number === 1 && field.wireType === 2)
    .map((field) => {
      const values = parseProto(field.value);
      return {
        // The desktop client sends the canonical agent_id (field 12) to
        // message/transcript RPCs. Field 1 is the server/display id.
        id: textField(values, 12) || textField(values, 2) || textField(values, 1),
        legacyAgentId: textField(values, 2),
        name: textField(values, 3),
        harness: textField(values, 13),
        role: textField(values, 14)
      };
    });
}

export function decodeSendGrokBotUserMessageResponse(bytes) {
  const fields = parseProto(bytes);
  const refusal = messageField(fields, 5);
  return {
    dispatched: boolField(fields, 1),
    mode: numberField(fields, 2),
    workflowId: textField(fields, 3),
    delivery: deliveryName(numberField(fields, 4)),
    refusalCode: refusal ? textField(refusal, 1) : ""
  };
}

export function decodeGrokBotSendStatusResponse(bytes) {
  const fields = parseProto(bytes);
  return {
    status: sendStatusName(numberField(fields, 1)),
    echoEntryId: textField(fields, 2),
    rejectionCode: textField(fields, 3),
    acceptedAtMs: numberField(fields, 4)
  };
}

export function decodeListGrokBotTranscriptEntriesResponse(bytes) {
  const fields = parseProto(bytes);
  return {
    entries: fields
      .filter((field) => field.number === 1 && field.wireType === 2)
      .map((field) => decodeTranscriptEntry(field.value)),
    generation: numberField(fields, 2)
  };
}

export function decodeTranscriptEntry(bytes) {
  const fields = parseProto(bytes);
  return {
    seq: bigintField(fields, 1),
    entryKind: textField(fields, 2),
    body: bytesField(fields, 3),
    blobHash: textField(fields, 4),
    updatedSeq: bigintField(fields, 5),
    entryId: textField(fields, 6),
    bodyOmitted: boolField(fields, 7)
  };
}

export function newestAssistantText(entries, baseline, messageId = "") {
  if (!messageId) return null;
  let sentEntrySeq = null;
  let sentRequestId = "";
  if (messageId) {
    for (const entry of entries) {
      if (!isNewTranscriptEntry(entry, baseline) || !entry.body) continue;
      const value = parseTranscriptBody(entry.body);
      if (value?.kind === "message" && value.role === "user" && value.clientNonce === messageId) {
        sentEntrySeq = entry.seq;
        sentRequestId = value.requestId;
        break;
      }
    }
    // A nonce echo alone does not identify later assistant rows if the user
    // is chatting with the same Bot concurrently. Require the requestId too.
    if (sentEntrySeq === null || typeof sentRequestId !== "string" || !sentRequestId) return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!isNewTranscriptEntry(entry, baseline) || !entry.body) continue;
    if (sentEntrySeq !== null && entry.seq <= sentEntrySeq) continue;
    const value = parseTranscriptBody(entry.body);
    if (messageId && value?.requestId !== sentRequestId) continue;
    const textEntry = assistantTextEntry(value);
    if (!textEntry) continue;
    candidates.push({
      key: `${entry.entryId || entry.seq}:${entry.updatedSeq}`,
      updatedSeq: entry.updatedSeq,
      text: textEntry.text,
      isStreaming: textEntry.isStreaming
    });
  }
  candidates.sort((left, right) => compareBigInt(left.updatedSeq, right.updatedSeq));
  return candidates.at(-1) || null;
}

function transcriptBaseline(page) {
  const entries = Array.isArray(page?.entries) ? page.entries : [];
  return {
    generation: Number.isInteger(page?.generation) ? page.generation : 0,
    entryIds: new Set(entries.map((entry) => entry.entryId).filter(Boolean)),
    maxUpdatedSeq: entries.reduce((largest, entry) => entry.updatedSeq > largest ? entry.updatedSeq : largest, 0n),
    maxSeq: entries.reduce((largest, entry) => entry.seq > largest ? entry.seq : largest, 0n)
  };
}

export function assertTextOnlyRequest(request) {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    throw new AppError(
      "upstream_tools_not_supported",
      "GROKBOT_UPSTREAM_MODE=grokbot-service supports text chat only; Pi tools are not available in this mode",
      400,
      "invalid_request_error"
    );
  }
  if (request.messages?.some((message) => message.role === "tool" || message.toolCalls?.length || message.toolResults?.length)) {
    throw new AppError(
      "upstream_tools_not_supported",
      "GROKBOT_UPSTREAM_MODE=grokbot-service cannot continue a tool-call conversation",
      400,
      "invalid_request_error"
    );
  }
}

function latestUserPrompt(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && stringValue(message.text)) return message.text;
  }
  throw new AppError("grokbot_user_prompt_missing", "Grok Bot service mode requires a textual user prompt", 400, "invalid_request_error");
}

function isNewTranscriptEntry(entry, baseline) {
  if (baseline.entryIds.has(entry.entryId)) return false;
  return entry.updatedSeq > baseline.maxUpdatedSeq || entry.seq > baseline.maxSeq;
}

function parseTranscriptBody(body) {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
}

function assistantTextEntry(value) {
  if (
    value?.kind === "message" &&
    value.role === "assistant" &&
    typeof value.content === "string" &&
    value.fromUser == null &&
    value.channel == null
  ) {
    return { text: value.content, isStreaming: value.isStreaming };
  }
  // Current desktop 0.30.0 stores the completed assistant text as a
  // send-message transcript row. Its requestId matches the echoed user row,
  // while the text lives under message.content.
  if (
    value?.kind === "send-message" &&
    value.message?.type === "text" &&
    typeof value.message.content === "string"
  ) {
    return { text: value.message.content, isStreaming: value.message.isStreaming };
  }
  return null;
}

function serviceBackend(value) {
  const backend = new URL(value);
  if (!backend.pathname.endsWith("/")) backend.pathname += "/";
  return backend;
}

function clientSurface(value) {
  if (value === undefined || value === "desktop") return 1;
  if (value === "mobile") return 2;
  return 0;
}

function deliveryName(value) {
  return ({ 1: "accepted_box", 2: "accepted_temporal", 3: "duplicate", 4: "refused" })[value] || "unknown";
}

function sendStatusName(value) {
  return ({ 1: "not_found", 2: "accepted", 3: "rejected", 4: "pending", 5: "unknown_durability" })[value] || "unknown";
}

function textField(fields, number) {
  const field = fields.find((item) => item.number === number && item.wireType === 2);
  return field ? Buffer.from(field.value).toString("utf8") : "";
}

function bytesField(fields, number) {
  const field = fields.find((item) => item.number === number && item.wireType === 2);
  return field ? Buffer.from(field.value) : null;
}

function messageField(fields, number) {
  const field = fields.find((item) => item.number === number && item.wireType === 2);
  return field ? parseProto(field.value) : null;
}

function bigintField(fields, number) {
  const field = fields.find((item) => item.number === number && item.wireType === 0);
  return field ? BigInt(field.value) : 0n;
}

function numberField(fields, number) {
  return Number(bigintField(fields, number));
}

function boolField(fields, number) {
  return bigintField(fields, number) !== 0n;
}

function requiredString(value, name) {
  const text = stringValue(value);
  if (!text) throw new AppError("invalid_grokbot_service_request", `${name} is required`, 500);
  return text;
}

function requiredTimestamp(value) {
  const timestamp = typeof value === "bigint" ? value : BigInt(value);
  if (timestamp < 0n) throw new AppError("invalid_grokbot_service_request", "Timestamp must be non-negative", 500);
  return timestamp;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = positiveInteger(value, fallback);
  return Math.max(minimum, Math.min(maximum, parsed));
}

function compareBigInt(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

async function readResponseBody(body, maxBytes) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of body) {
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) {
      body.destroy();
      throw new AppError("upstream_response_too_large", "Upstream response too large", 502);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function upstreamHttpError(status) {
  const meta = {
    upstreamErrorSource: "http",
    upstreamHttpStatus: status,
    upstreamOriginalCode: `http_${status}`
  };
  if (status === 429) return rateLimitError(undefined, meta);
  if (hardStopStatus(status)) {
    return new AppError(`hard_stop_http_${status}`, `Grok Bot upstream returned ${status}`, 503, "api_error", meta);
  }
  return new AppError(`upstream_http_${status}`, `Grok Bot upstream returned ${status}`, 502, "api_error", meta);
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || new DOMException("The operation was aborted", "AbortError"));
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
