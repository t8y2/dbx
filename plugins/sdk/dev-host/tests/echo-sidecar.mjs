import { FrameDecoder, JsonLineDecoder, frame, binaryPayload } from "../sidecar.mjs";
import { spawn } from "node:child_process";
const jsonl = process.argv.includes("--jsonl");
const send = (message) => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(jsonl ? Buffer.concat([bytes, Buffer.from("\n")]) : frame(0, bytes));
};
const decoder = new (jsonl ? JsonLineDecoder : FrameDecoder)((packet) => {
  if (packet.kind === 1) return process.stdout.write(frame(1, binaryPayload(packet.channel, packet.data)));
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
  if (id !== undefined) send({ id, result: method.startsWith("connection/") ? { success: true } : params });
});
process.stdin.on("data", (data) => decoder.push(data));
