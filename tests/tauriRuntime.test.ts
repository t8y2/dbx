import { strict as assert } from "node:assert";
import test from "node:test";
import { isTauriRuntime } from "../src/lib/tauriRuntime.ts";

test("detects plain browser-like globals as non-Tauri runtime", () => {
  assert.equal(isTauriRuntime({}), false);
});

test("detects Tauri globals", () => {
  assert.equal(isTauriRuntime({ __TAURI_INTERNALS__: {} }), true);
  assert.equal(isTauriRuntime({ __TAURI__: {} }), true);
});
