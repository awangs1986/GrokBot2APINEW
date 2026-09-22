import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesRequest, sanitizeJsonSchema, ResponseSseWriter, nonStreamingResponse } from "../src/openai.mjs";

test("normalizes stable conversation ids without a default max token override", () => {
  const first = normalizeResponsesRequest({
    model: "grok-4.5",
    prompt_cache_key: "session-123",
    input: "Use a tool."
  });
  const second = normalizeResponsesRequest({
    model: "grok-4.5",
    prompt_cache_key: "session-123",
    input: [
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]
  });

  assert.equal(first.maxTokens, undefined);
  assert.equal(first.conversationId, second.conversationId);
  assert.equal(first.conversationGroupId, second.conversationGroupId);
  assert.match(first.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(first.conversationGroupId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("honors explicit max_output_tokens", () => {
  const request = normalizeResponsesRequest({
    model: "grok-4.5",
    max_output_tokens: 128,
    input: "Say ok."
  });

  assert.equal(request.maxTokens, 128);
});

test("sanitizes tool JSON schema like the official client path", () => {
  const schema = sanitizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    markdownDescription: "not sent upstream",
    definitions: { unused: { type: "string" } },
    properties: {
      target: {
        type: "string",
        default: ".",
        markdownDescription: "Directory"
      },
      tuple: {
        type: "array",
        items: [
          { type: "string", default: "x" },
          { type: "number", additionalProperties: false }
        ],
        additionalItems: { type: "boolean", default: false }
      }
    }
  });

  assert.deepEqual(schema, {
    type: "object",
    definitions: { unused: { type: "string" } },
    properties: {
      target: { type: "string" },
      tuple: {
        type: "array",
        prefixItems: [
          { type: "string" },
          { type: "number" }
        ],
        items: { type: "boolean" }
      }
    }
  });
});

test("schema sanitization preserves property names, reference targets and literal objects", () => {
  const schema = {
    type: "object",
    properties: {
      default: { type: "string", default: "omit annotation" },
      definitions: { $ref: "#/definitions/Thing" },
      additionalProperties: { type: "boolean" },
      choice: { enum: [{ default: "literal", definitions: "literal" }] },
      fixed: { const: { default: "literal" } }
    },
    definitions: { Thing: { type: "string" } },
    required: ["default", "definitions"],
    items: false
  };
  const before = structuredClone(schema);
  const result = sanitizeJsonSchema(schema);
  assert.deepEqual(result.properties.default, { type: "string" });
  assert.deepEqual(result.properties.definitions, { $ref: "#/definitions/Thing" });
  assert.deepEqual(result.properties.additionalProperties, { type: "boolean" });
  assert.deepEqual(result.definitions, schema.definitions);
  assert.deepEqual(result.properties.choice, schema.properties.choice);
  assert.deepEqual(result.properties.fixed, schema.properties.fixed);
  assert.equal(result.items, false);
  assert.deepEqual(schema, before);
});

test("SSE assigns independent indexes to text, interleaved tools, and later text", () => {
  const { writer, events } = captureWriter();
  writer.start();
  writer.delta("Before tools.");
  writer.toolCallDelta({ id: "call_a", name: "read", args: '{"path":', index: 0 });
  writer.toolCallDelta({ id: "call_b", name: "read", args: '{"path":', index: 1 });
  writer.toolCallDone({ args: '"a"}', index: 0 });
  writer.toolCallDone({ id: "call_b", args: '"b"}', index: 1 });
  writer.delta("After tools.");
  writer.complete(null);
  const added = events().filter((event) => event.type === "response.output_item.added");
  const done = events().filter((event) => event.type === "response.output_item.done");
  const output = events().at(-1).response.output;
  assert.deepEqual(added.map((event) => event.output_index), [0, 1, 2, 3]);
  assert.deepEqual(output.map((item) => item.type), ["message", "function_call", "function_call", "message"]);
  assert.deepEqual(output.map((item) => item.id), added.map((event) => event.item.id));
  assert.deepEqual(done.map((event) => event.item), output);
  assert.equal(output[0].content[0].text, "Before tools.");
  assert.equal(output[3].content[0].text, "After tools.");
  assert.equal(output[1].arguments, '{"path":"a"}');
  assert.equal(output[2].arguments, '{"path":"b"}');
  assert.equal(new Set(output.map((item) => item.id)).size, 4);
});

test("SSE refuses to mark an unfinished tool call as completed", () => {
  const { writer, events } = captureWriter();
  writer.start();
  writer.toolCallDelta({ id: "call_a", name: "read", args: '{"path":', index: 0 });
  assert.throws(() => writer.complete(null), { code: "upstream_incomplete_tool_call" });
  assert.equal(events().some((event) => event.type === "response.completed"), false);
});

test("non-streaming output retains text alongside function calls", () => {
  const response = nonStreamingResponse("grok-4.5", "Before tools.", null, [{ id: "call_a", name: "read", arguments: "{}" }]);
  assert.deepEqual(response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(response.output[0].content[0].text, "Before tools.");
});

test("SSE errors expose standard top-level code and message for Pi", () => {
  const { writer, events } = captureWriter();
  writer.start();
  writer.fail(new Error("upstream failed"));
  const error = events().at(-1);
  assert.equal(error.type, "error");
  assert.equal(error.code, "upstream_error");
  assert.equal(error.message, "upstream failed");
  assert.equal(error.param, null);
  assert.equal(error.error.message, error.message);
});

function captureWriter() {
  let raw = "";
  const writer = new ResponseSseWriter({ writeHead() {}, write(chunk) { raw += chunk; }, end() {} }, {}, "grok-4.5");
  return { writer, events: () => raw.trim().split("\n\n").map((block) => JSON.parse(block.split("\ndata: ")[1])) };
}
