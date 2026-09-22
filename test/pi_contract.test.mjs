import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { GrokBotInferenceClient } from "../src/upstream.mjs";
import { connectEnvelope, protoField, protoMessage } from "../src/proto.mjs";

// Real, pinned Pi CLI + real sidecar encoder/decoder; only the remote HTTP
// transport/credentials are replaced. This is NOT a live Grok Bot smoke test.
const cli = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));
const example = JSON.parse(await readFile(new URL("../examples/pi/models.json", import.meta.url), "utf8"));
const textFrame = (text) => connectEnvelope(protoField(1, 2, protoField(1, 2, text)));
const toolFrame = (id, args, index, complete = false) => connectEnvelope(protoField(2, 2, protoMessage([
  ...(id ? [protoField(1, 2, id), protoField(2, 2, "read")] : []),
  protoField(3, 2, args), protoField(4, 0, complete ? 1 : 0), protoField(5, 0, index)
])));
const endFrame = (error) => connectEnvelope(Buffer.from(JSON.stringify(error ? { error } : {})), 2);
const usageFrame = () => connectEnvelope(protoField(3, 2, protoMessage([
  protoField(1, 0, 30), protoField(2, 0, 10), protoField(3, 0, 40)
])));

test("Pi CLI reads files and replays full tool history through the Responses/protobuf bridge", { timeout: 30_000 }, async (t) => {
  const seen = [];
  const encoded = [];
  const upstream = new GrokBotInferenceClient();
  const originalStream = upstream.stream.bind(upstream);
  upstream.stream = async function* (request, credentials) {
    seen.push(request);
    yield* originalStream(request, credentials);
  };
  upstream.open = async (_credentials, body) => {
    encoded.push(body);
    const frames = encoded.length === 1 ? [
      textFrame("I will read both fixtures."),
      toolFrame("call_a", '{"path":', 0),
      toolFrame("call_b", '{"path":', 1),
      toolFrame("", '"a.txt"}', 0, true),
      toolFrame("call_b", '"b.txt"}', 1, true),
      usageFrame(), endFrame()
    ] : [textFrame("PI_TOOL_ROUNDTRIP_OK"), usageFrame(), endFrame()];
    const bytes = Buffer.concat(frames);
    return { status: 200, body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]) };
  };
  const { run } = await fixture(t, upstream);
  const result = await run("Read a.txt and b.txt using the read tool.");
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PI_TOOL_ROUNDTRIP_OK/);
  assert.equal(seen.length, 2, "Pi should execute both tools then make one continuation request");
  assert.equal(seen[0].stream, true);
  assert.equal(seen[0].maxTokens, 8192);
  assert.equal(seen[0].tools.some((tool) => tool.name === "read"), true);
  assert.equal(seen[0].conversationId, seen[1].conversationId);
  assert.equal(seen[0].conversationGroupId, seen[1].conversationGroupId);
  assert.equal(seen[1].messages.some((message) => message.role === "user"), true);
  assert.equal(seen[1].messages.some((message) => message.role === "system"), true);
  const calls = seen[1].messages.flatMap((message) => message.toolCalls || []);
  const results = seen[1].messages.flatMap((message) => message.toolResults || []);
  assert.deepEqual(calls.map((call) => call.id).sort(), ["call_a", "call_b"]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.rawArgs).path).sort(), ["a.txt", "b.txt"]);
  assert.deepEqual(results.map((result) => result.id).sort(), ["call_a", "call_b"]);
  assert.ok(results.every((result) => result.name === "read"));
  assert.ok(results.some((result) => result.result.includes("PI_FIXTURE_ALPHA")));
  assert.ok(results.some((result) => result.result.includes("PI_FIXTURE_BETA")));
  assert.match(encoded[1].toString("utf8"), /PI_FIXTURE_ALPHA/);
  assert.match(encoded[1].toString("utf8"), /PI_FIXTURE_BETA/);
});

for (const [name, frames, expected] of [
  ["upstream rate limit", [endFrame({ code: "resource_exhausted", message: "quota" })], /Grok Bot upstream rate limit exceeded/],
  ["missing terminal frame", [textFrame("partial")], /Grok Bot upstream did not return exactly one terminal frame/]
]) {
  test(`Pi CLI reports ${name} as an error, not a successful answer`, { timeout: 30_000 }, async (t) => {
    const upstream = new GrokBotInferenceClient();
    upstream.open = async () => ({ status: 200, body: Readable.from(frames) });
    const { run } = await fixture(t, upstream);
    const result = await run("Say hello.");
    assert.match(result.stdout + result.stderr, expected);
    assert.doesNotMatch(result.stdout + result.stderr, /Error Code undefined/);
    assert.match(result.stdout, /"stopReason":"error"/);
  });
}

async function fixture(t, upstream) {
  const home = await mkdtemp(path.join(tmpdir(), "grokbot2api-pi-"));
  const agentDir = path.join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await writeFile(path.join(home, "a.txt"), "PI_FIXTURE_ALPHA\n");
  await writeFile(path.join(home, "b.txt"), "PI_FIXTURE_BETA\n");
  const server = http.createServer(createApp({
    key: "pi-contract-key",
    credentialProvider: { get: async () => ({}) },
    upstream
  }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = structuredClone(example);
  config.providers.grokbot.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify(config));
  return {
    run(prompt) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli,
          "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
          "--no-context-files", "--no-approve", "--no-session", "--mode", "json", "--tools", "read",
          "--provider", "grokbot", "--model", "grok-4.5", "--thinking", "off", "-p", prompt
        ], {
          cwd: home,
          // Do not load developer/user credentials, extensions, or project hooks.
          env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
            GROKBOT2API_KEY: "pi-contract-key", PI_OFFLINE: "1", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    }
  };
}
