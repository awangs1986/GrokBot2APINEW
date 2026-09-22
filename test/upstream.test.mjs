import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import https from "node:https";
import { buildUpstreamRequestBody, GrokBotInferenceClient } from "../src/upstream.mjs";
import { connectEnvelope, protoField } from "../src/proto.mjs";

test("includes normalized tools in the upstream inference request body", () => {
  const body = buildUpstreamRequestBody({
    messages: [{ role: "user", text: "Use the tool." }],
    tools: [{
      name: "unique_live_tool_schema",
      description: "A unique tool for regression coverage.",
      parameters: {
        type: "object",
        properties: {
          unique_live_tool_argument: { type: "string" }
        }
      }
    }],
    parameters: {},
    maxTokens: 128
  }, "grok-4.5");

  const encoded = body.toString("utf8");
  assert.match(encoded, /unique_live_tool_schema/);
  assert.match(encoded, /unique_live_tool_argument/);
});


for (const chunks of [[], [connectEnvelope(protoField(1, 2, protoField(1, 2, "partial")))]]) {
  test(`rejects an HTTP 200 response without a Connect terminal frame (${chunks.length} chunks)`, async () => {
    const client = new GrokBotInferenceClient();
    client.open = async () => ({ status: 200, body: Readable.from(chunks) });
    await assert.rejects(async () => {
      for await (const event of client.stream({ messages: [] }, {})) assert.notEqual(event.type, "done");
    }, { code: "upstream_missing_terminal" });
  });
}

test("accepts a valid empty stream with a terminal frame", async () => {
  const client = new GrokBotInferenceClient();
  client.open = async () => ({ status: 200, body: Readable.from([connectEnvelope(Buffer.from("{}"), 2)]) });
  const events = [];
  for await (const event of client.stream({ messages: [] }, {})) events.push(event);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).state.endFrames, 1);
});

test("rejects frames after the terminal frame", async () => {
  const client = new GrokBotInferenceClient();
  const end = connectEnvelope(Buffer.from("{}"), 2);
  client.open = async () => ({ status: 200, body: Readable.from([end, end]) });
  await assert.rejects(async () => {
    for await (const event of client.stream({ messages: [] }, {})) assert.notEqual(event.type, "done");
  }, { code: "upstream_frame_after_terminal" });
});

test("forwards cancellation to the HTTPS transport and destroys rejected response bodies", async (t) => {
  const controller = new AbortController();
  let seenSignal;
  const body = Readable.from([]);
  t.mock.method(https, "request", (_url, options, callback) => {
    seenSignal = options.signal;
    const request = new EventEmitter();
    request.end = () => callback(Object.assign(body, { statusCode: 429, headers: {} }));
    return request;
  });
  const client = new GrokBotInferenceClient();
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [], signal: controller.signal }, { accessToken: "fake", machineId: "fake" })) {}
  }, { code: "upstream_rate_limited" });
  assert.equal(seenSignal, controller.signal);
  assert.equal(body.destroyed, true);
});
