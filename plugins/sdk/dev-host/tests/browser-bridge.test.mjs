import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import { JSDOM } from "jsdom";
import { sandboxDocument } from "../browser-bridge.mjs";
import { hostMessage } from "../ui/messages.js";

test("bridge delivers host-compatible environment, lifecycle and binary events", async (t) => {
  const dom = new JSDOM(sandboxDocument("<head></head>", "test"), { runScripts: "dangerously" });
  t.after(() => dom.window.close());
  const w = dom.window;
  const send = (payload) => w.dispatchEvent(new w.MessageEvent("message", { source: w, data: hostMessage("test", payload) }));
  const events = [];
  for (const type of ["init", "context", "env", "event", "binary"]) w.addEventListener(`dbx-plugin-${type}`, (event) => events.push(event));
  let initialized = 0,
    notifications = 0,
    binary;
  w.dbxPlugin.onInit(() => initialized++);
  w.dbxPlugin.onEvent(() => notifications++);
  w.dbxPlugin.onBinary((value) => {
    binary = value;
  });
  send({ type: "init", context: { value: 1 } });
  await w.dbxPlugin.ready;
  assert.equal(initialized, 1);
  w.dbxPlugin.onInit(() => initialized++);
  assert.equal(initialized, 2);
  send({ type: "context", context: { value: 2 } });
  send({ type: "env", locale: "en" });
  send({ type: "event", method: "arbitrary/event" });
  send({ type: "binary", binaryChannel: "bytes", dataBase64: "AP8=" });
  assert.equal(notifications, 2);
  assert.ok(binary.data instanceof w.Uint8Array);
  assert.deepEqual([...binary.data], [0, 255]);
  assert.equal(binary.channel, "bytes");
  assert.equal(events.length, 5);
  assert.equal(events[1].detail.value, 2);
});

test("host messages snapshot nested reactive context and permissions before postMessage", () => {
  const source = reactive({ context: { connectionId: "one" }, permissions: ["host.events"] });
  const message = hostMessage("generation", { type: "init", ...source });
  assert.doesNotThrow(() => structuredClone(message));
  source.context.connectionId = "two";
  source.permissions.push("host.binary");
  assert.equal(message.context.connectionId, "one");
  assert.deepEqual(message.permissions, ["host.events"]);
});
test("sandbox bootstrap handles initialization, generation filtering and context listeners", async () => {
  const dom = new JSDOM(sandboxDocument("<html><head></head><body></body></html>", "generation"), { runScripts: "dangerously" });
  const w = dom.window,
    send = (value) => w.dispatchEvent(new w.MessageEvent("message", { source: w, data: value }));
  send(hostMessage("generation", { type: "init", context: { connectionId: "one" }, locale: "zh-CN" }));
  await w.dbxPlugin.ready;
  assert.equal(w.dbxPlugin.context.connectionId, "one");
  assert.equal(w.dbxPlugin.locale, "zh-CN");
  send(hostMessage("old", { type: "env", locale: "ja" }));
  assert.equal(w.dbxPlugin.locale, "zh-CN");
  send(hostMessage("generation", { type: "env", locale: "en" }));
  assert.equal(w.dbxPlugin.locale, "en");
  send(hostMessage("generation", { type: "env", theme: { appearance: "dark" } }));
  assert.equal(w.dbxPlugin.locale, "en");
  assert.equal(w.dbxPlugin.context.connectionId, "one");
  let calls = 0;
  const off = w.dbxPlugin.onContext(() => calls++);
  send(hostMessage("old", { type: "context", context: { connectionId: "bad" } }));
  assert.equal(w.dbxPlugin.context.connectionId, "one");
  send(hostMessage("generation", { type: "context", context: { connectionId: "two" } }));
  assert.equal(calls, 1);
  off();
  send(hostMessage("generation", { type: "context", context: { connectionId: "three" } }));
  assert.equal(calls, 1);
  dom.window.close();
});
