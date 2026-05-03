import { strict as assert } from "node:assert";
import test from "node:test";
import { nextTransferTerminalState } from "../src/lib/transferProgressState.ts";

test("marks transfer as failed when a table progress event reports error", () => {
  const state = nextTransferTerminalState(
    { done: false, cancelled: false, error: false },
    { status: "error" },
  );

  assert.deepEqual(state, { done: false, cancelled: false, error: true });
});

test("keeps terminal flags for done and cancelled progress events", () => {
  assert.deepEqual(
    nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "done" }),
    { done: true, cancelled: false, error: false },
  );
  assert.deepEqual(
    nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "cancelled" }),
    { done: false, cancelled: true, error: false },
  );
});
