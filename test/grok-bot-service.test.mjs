import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Readable } from "node:stream";
import https from "node:https";
import {
  buildGetGrokBotSendStatusRequest,
  buildCreateGrokBotAgentRequest,
  buildListGrokBotTranscriptEntriesRequest,
  buildSendGrokBotUserMessageRequest,
  decodeGrokBotSendStatusResponse,
  decodeListAgentsResponse,
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
  const created = parseProto(buildCreateGrokBotAgentRequest("agent-test"));
  assert.equal(fieldText(created, 8), "agent-test");
  assert.equal(Number(fieldNumber(created, 9)), 2);
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

test("decodes the canonical GrokBot agent id instead of the display id", () => {
  const response = decodeListAgentsResponse(protoMessage([
    protoField(1, 2, protoMessage([
      protoField(1, 2, "display"),
      protoField(2, 2, "legacy-agent-id"),
      protoField(3, 2, "Test Bot"),
      protoField(12, 2, "canonical-agent-id"),
      protoField(13, 2, "box"),
      protoField(14, 2, "owner")
    ]))
  ]));
  assert.deepEqual(response, [{
    id: "canonical-agent-id",
    legacyAgentId: "legacy-agent-id",
    name: "Test Bot",
    harness: "box",
    role: "owner"
  }]);
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
    transcriptEntry({ seq: 6, updatedSeq: 6, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", requestId: "request-test", content: "fake" } }),
    transcriptEntry({ seq: 7, updatedSeq: 7, entryId: "assistant", body: { kind: "message", role: "assistant", requestId: "request-test", content: "fake result", isStreaming: false } })
  ];
  assert.deepEqual(newestAssistantText(entries, baseline, "nonce-test"), {
    key: "assistant:7",
    updatedSeq: 7n,
    text: "fake result",
    isStreaming: false
  });
  assert.equal(newestAssistantText(entries.slice(1), baseline, "nonce-test"), null);
});

test("recognizes completed send-message text linked by the user request id", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 5n, maxSeq: 5n };
  const entries = [
    transcriptEntry({
      seq: 6,
      updatedSeq: 6,
      entryId: "user",
      body: { kind: "message", role: "user", clientNonce: "nonce-test", requestId: "request-test", content: "fake" }
    }),
    transcriptEntry({
      seq: 7,
      updatedSeq: 7,
      entryId: "send-message",
      body: { kind: "send-message", requestId: "request-test", message: { type: "text", content: "fake result" } }
    })
  ];
  assert.deepEqual(newestAssistantText(entries, baseline, "nonce-test"), {
    key: "send-message:7",
    updatedSeq: 7n,
    text: "fake result",
    isStreaming: undefined
  });
});

test("never returns another conversation's text after our nonce echo", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 0n, maxSeq: 0n };
  const user = transcriptEntry({
    seq: 1, updatedSeq: 1, entryId: "user",
    body: { kind: "message", role: "user", clientNonce: "nonce-test", requestId: "request-test", content: "fake" }
  });
  const unrelated = transcriptEntry({
    seq: 2, updatedSeq: 2, entryId: "other-reply",
    body: { kind: "send-message", requestId: "other-request", message: { type: "text", content: "wrong reply" } }
  });
  const own = transcriptEntry({
    seq: 3, updatedSeq: 3, entryId: "own-reply",
    body: { kind: "send-message", requestId: "request-test", message: { type: "text", content: "our reply" } }
  });
  const laterUnrelated = transcriptEntry({
    seq: 4, updatedSeq: 4, entryId: "later-other-reply",
    body: { kind: "message", role: "assistant", requestId: "other-request", content: "another wrong reply", isStreaming: false }
  });

  assert.equal(newestAssistantText([user, unrelated], baseline, "nonce-test"), null);
  assert.equal(newestAssistantText([user, unrelated, own, laterUnrelated], baseline, "nonce-test")?.text, "our reply");
  assert.equal(newestAssistantText([user, own], baseline, ""), null);
});

test("does not guess a reply when the nonce echo lacks a request id", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 0n, maxSeq: 0n };
  const entries = [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", content: "fake" } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "reply", body: { kind: "send-message", message: { type: "text", content: "unknown reply" } } })
  ];
  assert.equal(newestAssistantText(entries, baseline, "nonce-test"), null);
});

test("does not guess a reply when the assistant row lacks a request id", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 0n, maxSeq: 0n };
  const entries = [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", requestId: "request-test", content: "fake" } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "reply", body: { kind: "send-message", message: { type: "text", content: "unknown reply" } } })
  ];
  assert.equal(newestAssistantText(entries, baseline, "nonce-test"), null);
});

test("does not return an assistant row before the matching sent user row", () => {
  const baseline = { generation: 3, entryIds: new Set(), maxUpdatedSeq: 0n, maxSeq: 0n };
  const entries = [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "assistant", body: { kind: "message", role: "assistant", content: "wrong conversation", isStreaming: false } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "user", body: { kind: "message", role: "user", clientNonce: "nonce-test", requestId: "request-test", content: "fake" } })
  ];
  assert.equal(newestAssistantText(entries, baseline, "nonce-test"), null);
});

test("waits for a stable legacy assistant row after matching the sent nonce", async () => {
  const client = new GrokBotServiceClient({ sessionAgents: { resolve: async () => "agent-test" }, pollIntervalMs: 1, timeoutMs: 200, randomUuid: () => "fixed-nonce" });
  const baselinePage = transcriptPage(1, []);
  const replyPage = transcriptPage(1, [
    transcriptEntry({ seq: 1, updatedSeq: 1, entryId: "user", body: { kind: "message", role: "user", clientNonce: "fixed-nonce", requestId: "request-test", content: "fake" } }),
    transcriptEntry({ seq: 2, updatedSeq: 2, entryId: "assistant", body: { kind: "message", role: "assistant", requestId: "request-test", content: "legacy fake response" } })
  ]);
  let listCalls = 0;
  client.listTranscriptEntries = async () => (listCalls++ === 0 ? baselinePage : replyPage);
  client.sendUserMessage = async () => ({ delivery: "accepted_temporal" });
  client.getSendStatus = async () => ({ status: "accepted" });
  const events = [];
  for await (const event of client.stream({ sessionKey: "session-test", messages: [{ role: "user", text: "fake" }], tools: [] }, {})) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text", "done"]);
  assert.equal(events[0].text, "legacy fake response");
  assert.ok(listCalls >= 3);
});

test("rejects calls before sending if no stable Pi session is present", async () => {
  const client = new GrokBotServiceClient();
  let sent = false;
  client.sendUserMessage = async () => { sent = true; };
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [{ role: "user", text: "fake" }], tools: [] }, {})) {}
  }, { code: "grokbot_session_id_required" });
  assert.equal(sent, false);
});

test("rejects Pi tools before sending because transcript tool protocol is not verified", async () => {
  const client = new GrokBotServiceClient({ sessionAgents: { resolve: async () => "agent-test" } });
  let sent = false;
  client.sendUserMessage = async () => { sent = true; };
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [{ role: "user", text: "fake" }], tools: [{ name: "read" }] }, {})) {}
  }, { code: "upstream_tools_not_supported" });
  assert.equal(sent, false);
});

test("selects GrokBotService only in explicit service mode with a private session store", () => {
  const client = configuredUpstream({ GROKBOT_UPSTREAM_MODE: "grokbot-service", GROKBOT_SESSION_STORE: "/tmp/fixture-sessions.json" });
  assert.ok(client instanceof GrokBotServiceClient);
  assert.equal(client.sessionAgents.path, "/tmp/fixture-sessions.json");
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
