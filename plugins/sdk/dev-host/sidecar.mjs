import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { stopProcessTree } from "./process-tree.mjs";

export const JSON_LIMIT = 8 * 1024 * 1024;
export const BINARY_LIMIT = 64 * 1024 * 1024;
export function protocolName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new Error("Invalid protocol name");
  return value;
}
export function frame(kind, payload) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
export function binaryPayload(channel, data) {
  const name = Buffer.from(protocolName(channel));
  if (data.length > BINARY_LIMIT) throw new Error("Binary payload exceeds limit");
  const header = Buffer.alloc(2);
  header.writeUInt16BE(name.length);
  return Buffer.concat([header, name, data]);
}

export class FrameDecoder {
  buffer = Buffer.alloc(0);
  constructor(onFrame) {
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const kind = this.buffer[0],
        length = this.buffer.readUInt32BE(1);
      if (![0, 1].includes(kind)) throw new Error("Unknown frame kind");
      if (length > (kind === 0 ? JSON_LIMIT : BINARY_LIMIT + 1024)) throw new Error("Frame exceeds limit");
      if (this.buffer.length < length + 5) return;
      const payload = this.buffer.subarray(5, length + 5);
      this.buffer = this.buffer.subarray(length + 5);
      if (kind === 0) this.onFrame({ kind, message: JSON.parse(payload.toString("utf8")) });
      else {
        if (payload.length < 2) throw new Error("Invalid binary frame");
        const size = payload.readUInt16BE(0);
        if (!size || size + 2 > payload.length) throw new Error("Invalid binary channel");
        const channel = protocolName(new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2, 2 + size)));
        this.onFrame({ kind, channel, data: payload.subarray(2 + size) });
      }
    }
  }
}

export class JsonLineDecoder {
  buffer = Buffer.alloc(0);
  constructor(onFrame) {
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > JSON_LIMIT) throw new Error("JSON line exceeds limit");
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.onFrame({ kind: 0, message: JSON.parse(line) });
    }
    if (this.buffer.length > JSON_LIMIT) throw new Error("JSON line exceeds limit");
  }
}

export class Sidecar extends EventEmitter {
  pending = new Map();
  sequence = 0;
  state = "stopped";
  constructor({ executable, args = [], cwd, manifest, transport }) {
    super();
    Object.assign(this, { executable, args, cwd, manifest });
    this.transport = transport || manifest.entrypoints?.backend?.transport || "stdio-jsonl";
  }
  async start() {
    if (!this.executable) {
      this.state = "frontend";
      this.emit("status", this.state);
      return null;
    }
    if (this.child) throw new Error("Sidecar is already running");
    this.state = "starting";
    this.emit("status", this.state);
    const child = spawn(this.executable, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child = child;
    const Decoder = this.transport === "stdio-framed" ? FrameDecoder : JsonLineDecoder;
    const decoder = new Decoder((packet) => {
      if (packet.kind === 1) return this.emit("binary", { channel: packet.channel, dataBase64: packet.data.toString("base64") });
      const message = packet.message;
      if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC message");
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message || "Sidecar error"), { rpc: message.error }));
        else waiter.resolve(message.result);
      } else if (message.method) this.emit("event", { method: protocolName(message.method), params: message.params });
    });
    child.stdout.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch {
        this.emit("diagnostic", { level: "error", message: "后端协议解析失败", details: { reason: "invalid-frame" } });
        this.fail("Invalid sidecar frame");
        child.kill();
      }
    });
    // Sidecar stderr may contain credentials. Consume it without copying it into HTTP or logs.
    child.stderr.resume();
    child.on("error", () => this.fail("Cannot start sidecar executable"));
    child.stdin.on("error", () => this.fail("Sidecar input closed"));
    child.on("exit", (code) => {
      this.emit("diagnostic", { level: this.state === "stopping" ? "info" : "error", message: "后端进程退出", details: { exitCode: code } });
      this.child = undefined;
      this.cleanup = stopProcessTree(child);
      if (this.state !== "stopping") this.fail("Sidecar exited");
      else {
        this.state = "stopped";
        this.emit("status", this.state);
      }
    });
    try {
      const info = await this.request("plugin/initialize", { host: { protocolVersions: [1] } }, 10000);
      if (info?.protocolVersion !== 1 || info?.plugin?.id !== this.manifest.id || info?.plugin?.version !== this.manifest.version) {
        throw new Error("Sidecar identity or protocol does not match manifest");
      }
      this.state = "ready";
      this.emit("status", this.state);
      return info;
    } catch (error) {
      await this.stop();
      this.fail(error.message);
      throw error;
    }
  }
  fail(message, state = "failed") {
    this.state = state;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.pending.clear();
    this.emit("status", this.state);
  }
  write(kind, payload) {
    if (!this.executable) return Promise.reject(new Error("This plugin has no backend"));
    if (kind === 1 && this.transport !== "stdio-framed") return Promise.reject(new Error("Binary channels require stdio-framed transport"));
    if (!this.child || !["starting", "ready"].includes(this.state)) return Promise.reject(new Error("Sidecar is not ready"));
    if (kind === 0 && payload.length > JSON_LIMIT) return Promise.reject(new Error("JSON payload exceeds limit"));
    if (this.child.stdin.writableLength > 16 * 1024 * 1024) return Promise.reject(new Error("Sidecar input is busy"));
    const output = this.transport === "stdio-framed" ? frame(kind, payload) : Buffer.concat([payload, Buffer.from("\n")]);
    return new Promise((resolve, reject) => this.child.stdin.write(output, (error) => (error ? reject(new Error("Sidecar write failed")) : resolve())));
  }
  request(method, params = null, timeoutMs = 30000) {
    protocolName(method);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Invalid request timeout");
    if (this.pending.size >= 256) return Promise.reject(new Error("Too many pending requests"));
    const id = ++this.sequence;
    const started = performance.now();
    this.emit("diagnostic", { level: "debug", message: "RPC 开始", details: { requestId: id, method, transport: this.transport, params } });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Sidecar request timed out; operation may still be running"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    }).then(
      (result) => {
        this.emit("diagnostic", { level: "debug", message: "RPC 完成", details: { requestId: id, method, result, durationMs: Math.round(performance.now() - started) } });
        return result;
      },
      (error) => {
        const reason = error.message.startsWith("Sidecar request timed out") ? "timeout" : error.rpc ? "backend-error" : "transport-error";
        this.emit("diagnostic", { level: "error", message: "RPC 失败", details: { requestId: id, method, reason, error: error.rpc ? { code: error.rpc.code, data: error.rpc.data } : { reason }, durationMs: Math.round(performance.now() - started) } });
        throw error;
      },
    );
  }
  notify(method, params) {
    return this.write(0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: protocolName(method), params })));
  }
  sendBinary(channel, data) {
    return this.write(1, binaryPayload(channel, data));
  }
  async stop() {
    const child = this.child;
    if (!child) {
      await this.cleanup;
      return;
    }
    if (!child.pid) {
      this.child = undefined;
      this.state = "stopped";
      return;
    }
    this.fail("Sidecar stopped", "stopping");
    // Keep the Windows leader alive until taskkill has discovered its descendants.
    if (process.platform !== "win32") child.stdin.end();
    await stopProcessTree(child);
    await this.cleanup;
  }
}
