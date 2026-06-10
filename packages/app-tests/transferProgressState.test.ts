import { strict as assert } from "node:assert";
import { test } from "vitest";
import { nextTransferTerminalState } from "../../apps/desktop/src/lib/transferProgressState.ts";

test("does not mark transfer as failed when only a table progress event reports error", () => {
  const state = nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "error" });

  assert.deepEqual(state, { done: false, cancelled: false, error: false });
});

test("keeps terminal flags for done and cancelled progress events", () => {
  assert.deepEqual(nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "done" }), { done: true, cancelled: false, error: false });
  assert.deepEqual(nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "cancelled" }), { done: false, cancelled: true, error: false });
});

test("still marks transfer as done after earlier table errors", () => {
  const afterError = nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "error" });

  assert.deepEqual(nextTransferTerminalState(afterError, { status: "done" }), {
    done: true,
    cancelled: false,
    error: false,
  });
});
