import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { stopProcessTree } from "../process-tree.mjs";

function windowsProcess(context) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  const killer = new EventEmitter();
  const spawn = context.mock.method(childProcess, "spawn", () => killer);
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  context.after(() => {
    child.emit("exit", 0);
    killer.emit("close", 0);
    Object.defineProperty(process, "platform", platform);
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { child, killer, spawn };
}

test("Windows shutdown waits for the child exit event after taskkill completes", async (context) => {
  const { child, killer } = windowsProcess(context);
  let completed = false;
  const stopping = stopProcessTree(child).then(() => {
    completed = true;
  });
  killer.emit("close", 0);
  await setImmediate();
  assert.equal(completed, false);
  child.exitCode = 0;
  child.emit("exit", 0);
  await stopping;
  assert.equal(child.listenerCount("exit"), 0);
});

test("Windows shutdown avoids taskkill for a child whose exit was already observed", async (context) => {
  const { child, killer, spawn } = windowsProcess(context);
  child.exitCode = 0;
  const stopping = stopProcessTree(child);
  killer.emit("close", 128);
  await stopping;
  assert.equal(spawn.mock.callCount(), 0);
});

test("Windows shutdown reports a taskkill spawn failure without retaining an exit listener", async (context) => {
  const { child, killer } = windowsProcess(context);
  const stopping = stopProcessTree(child);
  const rejected = assert.rejects(stopping, /taskkill unavailable/);
  killer.emit("error", new Error("taskkill unavailable"));
  await rejected;
  assert.equal(child.listenerCount("exit"), 0);
});

test("Windows shutdown reports a failed taskkill while the child remains alive", async (context) => {
  const { child, killer } = windowsProcess(context);
  const stopping = stopProcessTree(child);
  const rejected = assert.rejects(stopping, /taskkill.*1/);
  killer.emit("close", 1);
  await rejected;
  assert.equal(child.listenerCount("exit"), 0);
});

test("Windows shutdown handles a child exiting before taskkill closes", async (context) => {
  const { child, killer } = windowsProcess(context);
  const stopping = stopProcessTree(child);
  child.exitCode = 0;
  child.emit("exit", 0);
  killer.emit("close", 128);
  await stopping;
  assert.equal(child.listenerCount("exit"), 0);
});
