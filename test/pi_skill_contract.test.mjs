import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { GrokBotServiceClient } from "../src/grok-bot-service.mjs";

const cli = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));

test("Pi explicit skill instructions reach the text-only Grok Bot adapter", { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "grokbot2api-skill-"));
  const agentDir = path.join(home, ".pi", "agent");
  const skillPath = path.join(agentDir, "skills", "fixture-skill", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "---\nname: fixture-skill\ndescription: A harmless text-only fixture for testing skill instructions.\n---\n\n# Fixture\n\nRemember the distinctive marker PI_SKILL_INSTRUCTION_MARKER. Do not use tools.\n");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  let sentPrompt = null;
  let sends = 0;
  let sessionKey = null;
  // Exercise the real adapter with fake RPCs so this test never contacts the
  // user's desktop Bot or executes skill-provided code.
  const client = new GrokBotServiceClient({ sessionAgents: { resolve: async () => "fixture-agent" }, pollIntervalMs: 1, timeoutMs: 200, randomUuid: () => "fixture-nonce" });
  const originalStream = client.stream.bind(client);
  client.stream = async function* (request, credentials) {
    sessionKey = request.sessionKey;
    yield* originalStream(request, credentials);
  };
  let lists = 0;
  const row = (seq, body) => ({ seq: BigInt(seq), updatedSeq: BigInt(seq), entryId: `fixture-row-${seq}`, body: Buffer.from(JSON.stringify(body)) });
  client.listTranscriptEntries = async () => lists++ === 0 ? { generation: 1, entries: [] } : { generation: 1, entries: [
    row(1, { kind: "message", role: "user", clientNonce: "fixture-nonce", requestId: "fixture-request", content: "fixture" }),
    row(2, { kind: "send-message", requestId: "fixture-request", message: { type: "text", content: "done" } })
  ] };
  client.sendUserMessage = async ({ text }) => { sends += 1; sentPrompt = text; return { delivery: "accepted_temporal" }; };
  client.getSendStatus = async () => ({ status: "accepted" });
  const server = http.createServer(createApp({ key: "fixture-key", credentialProvider: { get: async () => ({}) }, upstream: client }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { grokbot: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-responses", apiKey: "$GROKBOT2API_KEY",
    models: [{ id: "grok-4.5", reasoning: false, input: ["text"], contextWindow: 256000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
  } } }));
  const run = (toolOptions) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--offline", "--no-extensions", "--no-prompt-templates", "--no-themes",
      "--no-context-files", "--no-approve", "--no-session", ...toolOptions, "--skill", skillPath,
      "--mode", "json", "--provider", "grokbot", "--model", "grok-4.5", "--thinking", "off", "-p",
      "/skill:fixture-skill 请用纯文字确认。"
    ], { cwd: home, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
      GROKBOT2API_KEY: "fixture-key", PI_OFFLINE: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const result = await run(["--no-tools"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"stopReason":"stop"/);
  assert.ok(sentPrompt, "expected the fake Grok Bot send RPC to receive a prompt");
  assert.match(sentPrompt, /PI_SKILL_INSTRUCTION_MARKER/);
  assert.equal(sends, 1);
  assert.match(sessionKey, /^[0-9a-f-]{36}$/i, "Pi must send a stable session ID in the Responses request");

  const withTools = await run(["--tools", "read"]);
  assert.match(withTools.stdout, /"stopReason":"error"/);
  assert.match(withTools.stdout, /upstream_tools_not_supported|Pi tools are not available/);
  assert.equal(sends, 1, "a skill with Pi tools must be rejected before sending to Grok Bot");
});
