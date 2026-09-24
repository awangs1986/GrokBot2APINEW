import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionAgents } from "../src/session-agents.mjs";

const credentials = (sub) => ({ accessToken: `header.${Buffer.from(JSON.stringify({ sub, iss: "fixture" })).toString("base64url")}.signature` });

test("creates one Bot per session/account and reuses it across restarts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot2api-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "private", "sessions.json");
  const created = [];
  const client = {
    createAgent: async (id) => { created.push(id); return { id }; },
    listAgents: async () => created.map((id) => ({ id }))
  };
  const first = new SessionAgents({ path: storePath });
  const a = await first.resolve("pi-a", credentials("account-a"), client);
  const reused = await first.resolve("pi-a", credentials("account-a"), client);
  const b = await first.resolve("pi-b", credentials("account-a"), client);
  const otherAccount = await first.resolve("pi-a", credentials("account-b"), client);
  assert.equal(a, reused);
  assert.equal(new Set([a, b, otherAccount]).size, 3);
  assert.equal(created.length, 3);
  const restarted = new SessionAgents({ path: storePath });
  assert.equal(await restarted.resolve("pi-a", credentials("account-a"), client), a);
  assert.equal(created.length, 3);
  const disk = await fs.readFile(storePath, "utf8");
  assert.doesNotMatch(disk, /pi-a|pi-b|account-a|account-b/);
  assert.equal((await fs.stat(storePath)).mode & 0o777, 0o600);
});

test("recovers a pending creation by looking up its reserved ID", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot2api-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "sessions.json");
  const first = new SessionAgents({ path: storePath, randomUuid: crypto.randomUUID });
  let reserved;
  await assert.rejects(() => first.resolve("pi-a", credentials("account-a"), {
    createAgent: async (id) => { reserved = id; throw new Error("disconnected after upstream create"); }
  }), /disconnected after upstream create/);
  const recovered = new SessionAgents({ path: storePath });
  let creates = 0;
  const actual = await recovered.resolve("pi-a", credentials("account-a"), {
    listAgents: async () => [{ id: reserved }],
    createAgent: async () => { creates++; throw new Error("should not create another Bot"); }
  });
  assert.equal(actual, reserved);
  assert.equal(creates, 0);
});

test("concurrent first requests keep both session mappings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot2api-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "sessions.json");
  const store = new SessionAgents({ path: storePath });
  let count = 0;
  const client = { createAgent: async (id) => { count++; await new Promise(resolve => setTimeout(resolve, 3)); return { id }; } };
  const [a, b] = await Promise.all([
    store.resolve("pi-a", credentials("account-a"), client),
    store.resolve("pi-b", credentials("account-a"), client)
  ]);
  assert.notEqual(a, b);
  const restarted = new SessionAgents({ path: storePath });
  assert.equal(await restarted.resolve("pi-a", credentials("account-a"), client), a);
  assert.equal(await restarted.resolve("pi-b", credentials("account-a"), client), b);
  assert.equal(count, 2);
});

test("refuses missing session IDs and unsafe store permissions before any creation", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot2api-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "sessions.json");
  let creates = 0;
  const client = { createAgent: async () => { creates++; return { id: "unexpected" }; } };
  const store = new SessionAgents({ path: storePath });
  await assert.rejects(() => store.resolve("", credentials("account-a"), client), { code: "grokbot_session_id_required" });
  await fs.writeFile(storePath, "{}", { mode: 0o644 });
  await assert.rejects(() => store.resolve("pi-a", credentials("account-a"), client), { code: "grokbot_session_store_permissions" });
  assert.equal(creates, 0);
});
