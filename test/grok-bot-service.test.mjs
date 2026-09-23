import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Readable } from "node:stream";
import https from "node:https";
import {
  buildGetGrokBotSendStatusRequest,
  buildListGrokBotTranscriptEntriesRequest,
  buildSendGrokBotUserMessageRequest,
  decodeGrokBotSendStatusResponse,
  decodeListGrokBotTranscriptEntriesResponse,
  decodeSendGrokBotUserMessageResponse,
  GrokBotServiceClient,
  newestAssistantText
} from "../src/grok-bot-service.mjs";
import { parseProto, protoField, protoMessage } from "../src/proto.mjs";
import { configuredUpstream } from "../src/server.mjs";

test("encodes the desktop GrokBotService send request with explicit agent and desktop source", () => {
  const bytes = buildSendGrokBotUserMessageRequest({
    agentId: "agent-test",
    messageId: "nonce-test",
    text: "Only a fake test prompt.",
    sentAtMs: 1_700_000_000_000,
    source: "desktop"
  });
  const fields = parseProto(bytes);
  assert.equal(fieldText(fields, 1), "agent-test");
  assert.equal(fieldText(fields, 2), "nonce-test");
  assert.equal(fieldText(fields, 3), "Only a fake test prompt.");
  assert.equal(Number(fieldNumber(fields, 4)), 1_700_000_000_000);
  assert.equal(Number(fieldNumber(fields, 13)), 1);
});

test("encodes send-status and transcript requests", () => {
  const status = parseProto(buildGetGrokBotSendStatusRequest({ agentId: "agent-test", messageId: "nonce-test" }));
  assert.equal(fieldText(status, 1), "agent-test");
  assert.equal(fieldText(status, 2), "nonce-test");

  const transcript = parseProto(buildListGrokBotTranscriptEntriesRequest({ agentId: "agent-test", generation: 7, limit: 55 }));
  assert.equal(fieldText(transcript, 1), "agent-test");
  assert.equal(Number(fieldNumber(transcript, 2)), 7);
  assert.equal(Number(fieldNumber(transcript, 4)), 55);
});

test("decodes send delivery and send status without exposing response text", () => {
  const delivery = decodeSendGrokBotUserMessageResponse(protoMessage([
    protoField(1, 0, 1),
    protoField(4, 0, 2)
  ]));
  assert.deepEqual(delivery, {
    dispatched: true,
    mode: 0,
    workflowId: "",
    delivery: "accepted_temporal",
    refusalCode: ""
  });

  const status = decodeGrokBotSendStatusResponse(protoMessage([
    protoField(1, 0, 2),
    protoField(4, 0, 1_700_000_000_000)
  ]));
  assert.deepEqual(status, {
    status: "accepted",
    echoEntryId: "",
    rejectionCode: "",
    acceptedAtMs: 1_700_000_000_000
  });
});

test("uses the current unary protobuf route, not the retired Connect stream envelope", async (t) => {
  let observed;
  t.mock.method(https, "request", (url, options, callback) => {
    observed = { url, options };
    const request = new EventEmitter();
    request.end = () => callback(Object.assign(Readable.from([Buffer.alloc(0)]), { statusCode: 200, headers: {} }));
    return request;
  });
  const client = new GrokBotServiceClient({ serviceBackend: "https://example.invalid/aiserver.v1.GrokBotService/" });
  await client.unary("ListGrokBotAgents", Buffer.from([1, 2, 3]), {
    accessToken: "fake-token",
    machineId: "fake-machine",
    clientVersion: "0.30.0"
  }, "request-test");
  assert.equal(observed.url.pathname, "/aiserver.v1.GrokBotService/ListGrokBotAgents");
  assert.equal(observed.options.headers["content-type"], "application/proto");
  assert.equal(observed.options.headers["connect-protocol-version"], "1");
  assert.equal(observed.options.headers["content-length"], "3");
});

test("uses an exact prompt nonce and a completed assistant transcript row", () => {
  const baseline = { generation: 3, entryIds: new Set(["old"]), maxUpdatedSeq: 5n, maxSeq: 5n };
  const entries = [
    transcriptEntry({ seq: 6, updatedSeq: 6, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", content: "fake" } }),
    transcriptEntry({ seq: 7, updatedSeq: 7, entryId: "assistant", body: { kind: "message", role: "assistant", content: "fake result", isStreaming: false } })
  ];
  assert.deepEqual(newestAssistantText(entries, baseline, "nonce-test"), {
    key: "assistant:7",
    updatedSeq: 7n,
    text: "fake result",
    isStreaming: false
  });
  assert.equal(newestAssistantText(entries.slice(1), baseline, "nonce-test"), null);
});

test("does not return an assistant row before the matching sent user row", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 0n, maxSeq: 0n };
  const entries = [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "assistant", body: { kind: "message", role: "assistant", content: "wrong conversation", isStreaming: false } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", content: "fake" } })
  ];
  assert.equal(newestAssistantText(entries, baseline, "nonce-test"), null);
});

test("waits for a stable legacy assistant row after matching the sent nonce", async () => {
  const client = new GrokBotServiceClient({ agentId: "agent-test", pollIntervalMs: 1, timeoutMs: 200, randomUuid: () => "fixed-nonce" });
  const baselinePage = transcriptPage(1, []);
  const replyPage = transcriptPage(1, [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "user", body: { kind: "message", role: "user", clientNonce: "fixed-nonce", content: "fake" } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "assistant", body: { kind: "message", role: "assistant", content: "legacy fake response" } })
  ]);
  let listCalls = 0;
  client.listTranscriptEntries = async () => (listCalls++ === 0 ? baselinePage : replyPage);
  client.sendUserMessage = async () => ({ delivery: "accepted_temporal" });
  client.getSendStatus = async () => ({ status: "accepted" });
  const events = [];
  for await (const event of client.stream({ messages: [{ role: "user", text: "fake" }], tools: [] }, {})) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text", "done"]);
  assert.equal(events[0].text, "legacy fake response");
  assert.ok(listCalls >= 3);
});

test("rejects calls before sending if the agent is not explicitly configured", async () => {
  const client = new GrokBotServiceClient();
  let sent = false;
  client.sendUserMessage = async () => { sent = true; };
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [{ role: "user", text: "fake" }], tools: [] }, {})) {}
  }, { code: "grokbot_agent_id_not_configured" });
  assert.equal(sent, false);
});

test("rejects Pi tools before sending because transcript tool protocol is not verified", async () => {
  const client = new GrokBotServiceClient({ agentId: "agent-test" });
  let sent = false;
  client.sendUserMessage = async () => { sent = true; };
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [{ role: "user", text: "fake" }], tools: [{ name: "read" }] }, {})) {}
  }, { code: "upstream_tools_not_supported" });
  assert.equal(sent, false);
});

test("selects GrokBotService only when the explicit service mode and agent id are configured", () => {
  const client = configuredUpstream({ GROKBOT_UPSTREAM_MODE: "grokbot-service", GROKBOT_AGENT_ID: "agent-test" });
  assert.ok(client instanceof GrokBotServiceClient);
  assert.equal(client.agentId, "agent-test");
});

test("decodes transcript protobuf rows without leaking them to logs", () => {
  const result = decodeListGrokBotTranscriptEntriesResponse(protoMessage([
    protoField(1, 2, transcriptEntryBytes({ seq: 9, updatedSeq: 10, entryId: "entry-1", body: { kind: "message", role: "assistant", content: "fake" } })),
    protoField(2, 0, 3)
  ]));
  assert.equal(result.generation, 3);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].seq, 9n);
  assert.equal(result.entries[0].updatedSeq, 10n);
  assert.equal(result.entries[0].entryId, "entry-1");
});

function transcriptPage(generation, entries) {
  return { generation, entries };
}

function transcriptEntry({ seq, updatedSeq, entryId, body }) {
  return {
    seq: BigInt(seq),
    entryKind: "entry",
    body: Buffer.from(JSON.stringify(body)),
    blobHash: "",
    updatedSeq: BigInt(updatedSeq),
    entryId,
    bodyOmitted: false
  };
}

function transcriptEntryBytes({ seq, updatedSeq, entryId, body }) {
  return protoMessage([
    protoField(1, 0, seq),
    protoField(2, 2, "entry"),
    protoField(3, 2, Buffer.from(JSON.stringify(body))),
    protoField(5, 0, updatedSeq),
    protoField(6, 2, entryId)
  ]);
}

function fieldText(fields, number) {
  return Buffer.from(fields.find((field) => field.number === number).value).toString("utf8");
}

function fieldNumber(fields, number) {
  return fields.find((field) => field.number === number).value;
}
