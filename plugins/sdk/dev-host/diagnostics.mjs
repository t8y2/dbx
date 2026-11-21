import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const sensitive = /password|passwd|secret|token|authorization|cookie|credential|private.?key|access.?key|api.?key|csrf/i;
export function redact(value, secretKeys = new Set()) {
  let budget = 8192,
    nodes = 0;
  const seen = new WeakSet();
  function visit(v, key = "", depth = 0) {
    if (sensitive.test(key) || secretKeys.has(key) || key === "headers" || key === "channel") return "[REDACTED]";
    if (/base64|binary|^html$/i.test(key)) return "[content omitted]";
    if (++nodes > 150 || budget <= 0 || depth > 6) return "[truncated]";
    if (typeof v === "string") {
      const limit = Math.min(2048, budget),
        source = v.slice(0, limit);
      if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(source)) return "[REDACTED]";
      const safe = source.replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@").replace(/([?&](?:[^=&\s]*(?:token|key|password|secret)[^=&\s]*)=)[^&#\s]*/gi, "$1[REDACTED]");
      budget -= source.length;
      return safe + (v.length > limit ? " [truncated]" : "");
    }
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v))
      return v
        .slice(0, 40)
        .map((item) => visit(item, "", depth + 1))
        .concat(v.length > 40 ? ["[truncated]"] : []);
    return Object.fromEntries(
      Object.entries(v)
        .slice(0, 40)
        .map(([k, item]) => [k.slice(0, 128), visit(item, k, depth + 1)]),
    );
  }
  return visit(value);
}

export class Diagnostics extends EventEmitter {
  instanceId = randomUUID();
  entries = [];
  sequence = 0;
  secretKeys = new Set();
  context = {};
  constructor(output = (line) => console.log(line)) {
    super();
    this.output = output;
  }
  record(level, category, message, details = {}) {
    const safe = { ...this.context };
    for (const key of ["requestId", "status", "durationMs", "bytes", "port", "exitCode"]) {
      if (Number.isFinite(details[key])) safe[key] = details[key];
    }
    for (const key of ["method", "state", "reason", "transport"]) {
      if (typeof details[key] === "string" && /^[A-Za-z0-9._:/-]{1,256}$/.test(details[key])) safe[key] = details[key];
    }
    for (const key of ["path", "project", "uiRoot", "backend", "params", "result", "error"]) {
      if (details[key] !== undefined) safe[key] = redact(details[key], this.secretKeys);
    }
    const entry = { id: ++this.sequence, time: new Date().toISOString(), level, category, message, details: safe };
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
    this.output(`[dbx-dev] ${JSON.stringify(entry)}`);
    this.emit("entry", entry);
    return entry;
  }
  snapshot() {
    return structuredClone(this.entries);
  }
  query(params) {
    for (const key of params.keys()) if (!["after", "limit", "level", "instanceId"].includes(key) || params.getAll(key).length !== 1) throw new Error("Invalid diagnostics query");
    const integer = (key, fallback, max) => {
      const raw = params.get(key);
      if (raw === null) return fallback;
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new Error(`Invalid ${key}`);
      return Number(raw);
    };
    const after = integer("after", 0, Number.MAX_SAFE_INTEGER),
      limit = integer("limit", 100, 500);
    const level = params.get("level");
    if (limit < 1 || (level && !["debug", "info", "error"].includes(level))) throw new Error("Invalid diagnostics filter");
    const reset = !!(params.get("instanceId") && params.get("instanceId") !== this.instanceId) || after > this.sequence;
    const cursor = reset ? 0 : after,
      oldestId = this.entries[0]?.id || 0;
    const matched = this.entries.filter((e) => e.id > cursor && (!level || e.level === level));
    const entries = matched.slice(0, limit),
      hasMore = matched.length > limit;
    return { instanceId: this.instanceId, entries: structuredClone(entries), nextAfter: hasMore ? entries.at(-1).id : this.sequence, hasMore, reset, truncated: oldestId > cursor + 1, oldestId, latestId: this.sequence };
  }
}
