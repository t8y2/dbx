import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { FrameDecoder, JsonLineDecoder, frame, binaryPayload, Sidecar, JSON_LIMIT } from "../sidecar.mjs";

const config = { executable: process.execPath, args: [fileURLToPath(new URL("./echo-sidecar.mjs", import.meta.url))], transport: "stdio-framed", manifest: { id: "example.echo", version: "1.0.0" } };
test("sidecar shutdown terminates descendants even after the leader exits", async (t) => {
  const sidecar = new Sidecar(config);
  t.after(() => sidecar.stop());
  await sidecar.start();
  const pid = await sidecar.request("spawn-child");
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  await delay(100);
  await sidecar.stop();
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try {
      process.kill(pid, 0);
      await delay(20);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "sidecar descendant must be terminated");
});
test("decoder handles split headers, payloads, concatenated frames and binary channels", () => {
  const got = [],
    decoder = new FrameDecoder((packet) => got.push(packet));
  const input = Buffer.concat([frame(0, Buffer.from('{"result":1}')), frame(1, binaryPayload("test/bytes", Buffer.from([0, 255, 13])))]);
  for (const byte of input) decoder.push(Buffer.from([byte]));
  assert.equal(got[0].message.result, 1);
  assert.deepEqual(got[1].data, Buffer.from([0, 255, 13]));
  assert.equal(decoder.buffer.length, 0);
});
test("decoder rejects oversized and malformed frames before allocating payloads", () => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(JSON_LIMIT + 1, 1);
  assert.throws(() => new FrameDecoder(() => {}).push(header), /limit/);
  assert.throws(() => new FrameDecoder(() => {}).push(frame(9, Buffer.alloc(0))), /kind/);
  assert.throws(() => new FrameDecoder(() => {}).push(frame(1, Buffer.from([0, 20]))), /channel/);
});
test("generic sidecar correlates out-of-order replies and preserves structured errors", async (t) => {
  const sidecar = new Sidecar(config);
  t.after(() => sidecar.stop());
  await sidecar.start();
  const order = [];
  const a = sidecar.request("slow", { a: 1 }).then((value) => {
    order.push("slow");
    return value;
  });
  const b = sidecar.request("echo", { b: 2 }).then((value) => {
    order.push("fast");
    return value;
  });
  assert.deepEqual(await b, { b: 2 });
  assert.deepEqual(await a, { a: 1 });
  assert.deepEqual(order, ["fast", "slow"]);
  await assert.rejects(sidecar.request("fail"), (e) => e.rpc.data.category === "example");
});
test("events, binary, timeout and process death are observable without business RPC knowledge", async (t) => {
  const sidecar = new Sidecar(config);
  t.after(() => sidecar.stop());
  await sidecar.start();
  const event = once(sidecar, "event");
  await sidecar.notify("emit", { event: true });
  assert.equal((await event)[0].params.event, true);
  const binary = once(sidecar, "binary");
  await sidecar.sendBinary("channel", Buffer.from("bytes"));
  assert.equal((await binary)[0].dataBase64, Buffer.from("bytes").toString("base64"));
  await assert.rejects(sidecar.request("slow", {}, 5), /timed out/);
  const slow = sidecar.request("slow");
  const slowAssertion = assert.rejects(slow, /exited/);
  await sidecar.notify("die");
  await slowAssertion;
  assert.equal(sidecar.pending.size, 0);
});
test("handshake rejects wrong identity and missing executables terminate promptly", async () => {
  const wrong = new Sidecar({ ...config, manifest: { id: "wrong", version: "1.0.0" } });
  await assert.rejects(wrong.start(), /identity/);
  const missing = new Sidecar({ ...config, executable: "/definitely/missing/mock-sidecar" });
  await assert.rejects(missing.start(), /start/);
  await missing.stop();
});

test("JSONL supports split lines, concurrent RPC, events and rejects binary channels", async (t) => {
  const packets = [],
    decoder = new JsonLineDecoder((packet) => packets.push(packet));
  decoder.push(Buffer.from('{"a":'));
  decoder.push(Buffer.from('1}\n\n{"b":2}\n'));
  assert.equal(packets.length, 2);
  assert.equal(packets[1].message.b, 2);
  assert.throws(() => new JsonLineDecoder(() => {}).push(Buffer.alloc(JSON_LIMIT + 1, 65)), /limit/);
  const sidecar = new Sidecar({ ...config, transport: "stdio-jsonl", args: [...config.args, "--jsonl"] });
  t.after(() => sidecar.stop());
  await sidecar.start();
  assert.deepEqual(await sidecar.request("echo", { arbitrary: "value" }), { arbitrary: "value" });
  const event = once(sidecar, "event");
  await sidecar.notify("emit", { ok: true });
  assert.equal((await event)[0].params.ok, true);
  await assert.rejects(sidecar.sendBinary("bytes", Buffer.from("data")), /framed/);
});
