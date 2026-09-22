import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import {
  AiServiceStreamChatClient,
  buildAiServiceStreamChatRequest
} from "../src/ai-service.mjs";
import { connectEnvelope, parseProto } from "../src/proto.mjs";
import { configuredUpstream } from "../src/server.mjs";

test("encodes the desktop AiService StreamChat request shape", () => {
  const body = buildAiServiceStreamChatRequest({
    messages: [
      { role: "developer", text: "Be concise." },
      { role: "user", text: "Hello." },
      { role: "assistant", text: "Hi." }
    ],
    upstreamModel: "grok-4.5",
    requestId: "request-1",
    conversationId: "conversation-1",
    maxTokens: 256
  });

  const fields = parseProto(body);
  const conversations = fields.filter((field) => field.number === 2);
  assert.equal(conversations.length, 3);
  assert.deepEqual(conversations.map((field) => {
    const message = parseProto(field.value);
    return {
      text: message.find((item) => item.number === 1)?.value.toString("utf8"),
      type: Number(message.find((item) => item.number === 2)?.value)
    };
  }), [
    { text: "Be concise.", type: 1 },
    { text: "Hello.", type: 1 },
    { text: "Hi.", type: 2 }
  ]);

  const model = parseProto(fields.find((field) => field.number === 7).value);
  assert.equal(model.find((field) => field.number === 1).value.toString("utf8"), "grok-4.5");
  assert.equal(fields.find((field) => field.number === 9).value.toString("utf8"), "request-1");
  assert.equal(fields.find((field) => field.number === 15).value.toString("utf8"), "conversation-1");
  assert.equal(fields.find((field) => field.number === 26).value.readUInt32LE(), 256);
});

test("decodes direct StreamChat text frames and requires a Connect terminal frame", async () => {
  const client = new AiServiceStreamChatClient();
  client.open = async () => ({
    status: 200,
    body: Readable.from([
      connectEnvelope(Buffer.from([0x0a, 0x03, 0x68, 0x65, 0x79])),
      connectEnvelope(Buffer.from("{}"), 2)
    ])
  });

  const events = [];
  for await (const event of client.stream({
    messages: [{ role: "user", text: "Hello." }],
    requestId: "request-1",
    conversationId: "conversation-1"
  }, {})) events.push(event);

  assert.deepEqual(events[0], { type: "text", text: "hey" });
  assert.equal(events[1].type, "done");
  assert.equal(events[1].state.text, "hey");
  assert.equal(events[1].state.endFrames, 1);
});

test("does not pretend StreamChat supports Pi tool calls", async () => {
  const client = new AiServiceStreamChatClient();
  await assert.rejects(async () => {
    for await (const _event of client.stream({
      messages: [{ role: "user", text: "List files." }],
      tools: [{ name: "read" }]
    }, {})) {}
  }, { code: "upstream_tools_not_supported" });
});

test("selects the experimental AiService transport only when explicitly configured", () => {
  assert.ok(configuredUpstream({ GROKBOT_UPSTREAM_MODE: "ai-stream-chat" }) instanceof AiServiceStreamChatClient);
  assert.throws(
    () => configuredUpstream({ GROKBOT_UPSTREAM_MODE: "unsupported" }),
    { code: "invalid_upstream_mode" }
  );
});
