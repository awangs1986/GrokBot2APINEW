import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jwtPayload } from "./credentials.mjs";
import { AppError } from "./errors.mjs";

const DEFAULT_STORE = path.join(os.homedir(), ".config", "grokbot2api", "sessions.json");

// One Pi session belongs to one Grok Bot agent in one signed-in account.
// Persist the intended agent ID before creating it, so a crash between the
// upstream create and the disk commit cannot silently create another Bot.
export class SessionAgents {
  constructor(config = {}) {
    this.path = config.path || DEFAULT_STORE;
    this.randomUuid = config.randomUuid || crypto.randomUUID;
    this.pending = new Map();
    this.queue = Promise.resolve();
    if (!path.isAbsolute(this.path)) {
      throw new AppError("grokbot_session_store_invalid", "GROKBOT_SESSION_STORE must be an absolute path", 503);
    }
  }

  async resolve(sessionKey, credentials, client, signal) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      throw new AppError("grokbot_session_id_required", "Grok Bot requires a stable Pi session ID", 400, "invalid_request_error");
    }
    const claims = jwtPayload(credentials.accessToken);
    if (typeof claims.sub !== "string" || !claims.sub) {
      throw new AppError("grokbot_account_id_required", "Grok Bot account identity is unavailable", 503);
    }
    const key = crypto.createHash("sha256").update(`${claims.iss || ""}\0${claims.sub}\0${sessionKey}`).digest("hex");
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    // Different sessions still share one JSON store: serialize read-modify-
    // write operations so concurrent first requests cannot erase a mapping.
    const work = this.queue.then(() => this.resolveOne(key, credentials, client, signal));
    this.queue = work.catch(() => {});
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }

  async resolveOne(key, credentials, client, signal) {
    const store = await this.read();
    let record = store.sessions[key];
    if (record?.status === "ready") return record.agentId;
    if (!record) {
      record = { status: "pending", agentId: this.randomUuid() };
      store.sessions[key] = record;
      await this.write(store);
    } else {
      // Recover an interrupted creation before attempting the same ID again.
      const existing = await client.listAgents(credentials, crypto.randomUUID(), signal);
      if (existing.some((agent) => agent.id === record.agentId)) {
        record.status = "ready";
        await this.write(store);
        return record.agentId;
      }
    }
    const created = await client.createAgent(record.agentId, credentials, crypto.randomUUID(), signal);
    if (created.id !== record.agentId) {
      throw new AppError("grokbot_created_agent_mismatch", "Created Grok Bot ID did not match the reserved ID", 502);
    }
    record.status = "ready";
    await this.write(store);
    return record.agentId;
  }

  async read() {
    let content;
    try {
      const stat = await fs.stat(this.path);
      if ((stat.mode & 0o077) !== 0) throw new AppError("grokbot_session_store_permissions", "Grok Bot session store must be private", 503);
      content = await fs.readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, sessions: {} };
      if (error instanceof AppError) throw error;
      throw new AppError("grokbot_session_store_read_failed", "Could not read Grok Bot session store", 503);
    }
    try {
      const value = JSON.parse(content);
      if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) throw new Error("shape");
      for (const record of Object.values(value.sessions)) {
        if (!record || !["pending", "ready"].includes(record.status) || typeof record.agentId !== "string" || !record.agentId) throw new Error("record");
      }
      return value;
    } catch {
      throw new AppError("grokbot_session_store_invalid", "Grok Bot session store is invalid; refusing to overwrite it", 503);
    }
  }

  async write(store) {
    const directory = path.dirname(this.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.stat(directory);
    if ((stat.mode & 0o077) !== 0) throw new AppError("grokbot_session_store_permissions", "Grok Bot session directory must be private", 503);
    const temp = path.join(directory, `.sessions-${this.randomUuid()}.tmp`);
    try {
      const file = await fs.open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(store)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, this.path);
    } catch {
      throw new AppError("grokbot_session_store_write_failed", "Could not save Grok Bot session mapping", 503);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
}
