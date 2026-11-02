import { FrameDecoder, JsonLineDecoder, frame, binaryPayload } from "../sidecar.mjs";
import { spawn } from "node:child_process";
const jsonl = process.argv.includes("--jsonl");
const send = (message) => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(jsonl ? Buffer.concat([bytes, Buffer.from("\n")]) : frame(0, bytes));
};
let pendingAsk = null;
const decoder = new (jsonl ? JsonLineDecoder : FrameDecoder)((packet) => {
  if (packet.kind === 1) return process.stdout.write(frame(1, binaryPayload(packet.channel, packet.data)));
  // Host API 1.1: the dev host answers a plugin-initiated (string-id) request
  // with an error, which this sidecar forwards as the `ask-user` result.
  if (packet.message.id === "plugin-1") {
    const waiting = pendingAsk;
    pendingAsk = null;
    return send({ id: waiting, result: packet.message });
  }
  const { id, method, params } = packet.message;
  if (method === "plugin/initialize") return send({ id, result: { protocolVersion: 1, plugin: { id: "example.echo", version: "1.0.0" } } });
  if (method === "die") return process.exit(1);
  if (method === "spawn-child") {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
    child.unref();
    return send({ id, result: child.pid });
  }
  if (method === "emit") return send({ method: "example/event", params });
  if (method === "fail") return send({ id, error: { code: -32000, message: "Example failure", data: { category: "example" } } });
  if (method === "slow") return setTimeout(() => send({ id, result: params }), 80);
  // Plugins ask the user through string ids. The dev host has no UI, so it must
  // answer instead of leaving the plugin waiting.
  if (method === "ask-user") {
    pendingAsk = id;
    return send({ id: "plugin-1", method: "host/requestUserInput", params: { prompt: "Verification code" } });
  }
  if (id !== undefined) send({ id, result: method.startsWith("connection/") ? { success: true } : params });
});
process.stdin.on("data", (data) => decoder.push(data));
