import crypto from "node:crypto";
import https from "node:https";
import {
  ConnectFrameDecoder,
  connectEnvelope,
  parseProto,
  protoField,
  protoMessage
} from "./proto.mjs";
import { cursorChecksum } from "./credentials.mjs";
import { AppError, hardStopStatus, rateLimitError } from "./errors.mjs";

const BACKEND = new URL("https://api2.cursor.sh/aiserver.v1.AiService/StreamChat");

export class AiServiceStreamChatClient {
  constructor(config = {}) {
    this.backend = new URL(config.backend || BACKEND);
    this.upstreamModel = config.upstreamModel || "grok-4.5";
    this.timeoutMs = config.timeoutMs || 90_000;
    this.maxResponseBytes = config.maxResponseBytes || 8 * 1024 * 1024;
  }

  async *stream(request, credentials) {
    assertTextOnlyRequest(request);
    const upstreamRequestId = request.requestId || crypto.randomUUID();
    const body = connectEnvelope(buildAiServiceStreamChatRequest({
      ...request,
      requestId: upstreamRequestId,
      upstreamModel: request.upstreamModel || this.upstreamModel,
      conversationId: request.conversationId || crypto.randomUUID()
    }));
    const response = await this.open(credentials, body, upstreamRequestId, request.signal);
    if (response.status !== 200) {
      response.body.destroy();
      throw upstreamHttpError(response.status);
    }

    const state = { text: "", endFrames: 0, errors: [] };
    const decoder = new ConnectFrameDecoder();
    let receivedBytes = 0;
    for await (const chunk of response.body) {
      receivedBytes += chunk.length;
      if (receivedBytes > this.maxResponseBytes) {
        throw new AppError("upstream_response_too_large", "Upstream response too large", 502);
      }
      for (const frame of decoder.push(chunk)) {
        if (state.endFrames > 0) {
          throw new AppError("upstream_frame_after_terminal", "Grok Bot sent data after its terminal frame", 502);
        }
        if ((frame.flags & 0x01) !== 0) {
          throw new AppError("compressed_connect_frame_unsupported", "Compressed Connect frame unsupported", 502);
        }
        if ((frame.flags & 0x02) !== 0) {
          state.endFrames += 1;
          applyEndFrame(frame.payload, state);
          continue;
        }
        for (const text of textDeltas(frame.payload)) {
          state.text += text;
          yield { type: "text", text };
        }
      }
    }
    decoder.finish();
    if (state.errors.length > 0) {
      const first = state.errors[0];
      throw new AppError(first.code, first.message || "Grok Bot upstream stream error", 502, "api_error", {
        upstreamErrorSource: "connect_end_frame",
        upstreamOriginalCode: first.code
      });
    }
    if (state.endFrames !== 1) {
      throw new AppError("upstream_missing_terminal", "Grok Bot upstream did not return exactly one terminal frame", 502);
    }
    yield { type: "done", state };
  }

  open(credentials, body, requestId = crypto.randomUUID(), signal) {
    return new Promise((resolve, reject) => {
      const request = https.request(this.backend, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/connect+proto",
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

export function buildAiServiceStreamChatRequest(input) {
  const modelDetails = protoMessage([
    protoField(1, 2, input.upstreamModel)
  ]);
  const fields = [
    ...input.messages.map((message) => protoField(2, 2, conversationMessage(message))),
    protoField(7, 2, modelDetails),
    protoField(9, 2, input.requestId),
    protoField(15, 2, input.conversationId)
  ];
  if (Number.isInteger(input.maxTokens) && input.maxTokens > 0) {
    fields.push(protoField(26, 5, fixed32(input.maxTokens)));
  }
  return protoMessage(fields);
}

function conversationMessage(message) {
  return protoMessage([
    protoField(1, 2, message.text || ""),
    protoField(2, 0, message.role === "assistant" ? 2 : 1)
  ]);
}

function fixed32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new AppError("invalid_fixed32", "Invalid fixed32", 500);
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function assertTextOnlyRequest(request) {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    throw new AppError(
      "upstream_tools_not_supported",
      "GROKBOT_UPSTREAM_MODE=ai-stream-chat supports text chat only; Pi tools are not available in this mode",
      400,
      "invalid_request_error"
    );
  }
  if (request.messages.some((message) => message.role === "tool" || message.toolCalls?.length || message.toolResults?.length)) {
    throw new AppError(
      "upstream_tools_not_supported",
      "GROKBOT_UPSTREAM_MODE=ai-stream-chat cannot continue a tool-call conversation",
      400,
      "invalid_request_error"
    );
  }
}

function textDeltas(payload) {
  return parseProto(payload)
    .filter((field) => field.number === 1 && field.wireType === 2)
    .map((field) => field.value.toString("utf8"))
    .filter(Boolean);
}

function applyEndFrame(payload, state) {
  if (payload.length === 0) return;
  let end;
  try {
    end = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new AppError("invalid_connect_end_frame", "Invalid Connect end frame", 502);
  }
  if (end?.error) {
    state.errors.push({
      code: String(end.error.code || "connect_end_error"),
      message: String(end.error.message || "")
    });
  }
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
