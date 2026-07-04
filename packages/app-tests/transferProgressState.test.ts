import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isTransferRunActive, nextTransferTerminalState, shouldKeepTransferDraftOnOpen, shouldResetTransferDialogOnOpen } from "../../apps/desktop/src/lib/app/transferProgressState.ts";

test("marks transfer as failed when a table progress event reports error", () => {
  const state = nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "error" });

  assert.deepEqual(state, { done: false, cancelled: false, error: true });
});

test("keeps terminal flags for done and cancelled progress events", () => {
  assert.deepEqual(nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "done" }), { done: true, cancelled: false, error: false });
  assert.deepEqual(nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "cancelled" }), { done: false, cancelled: true, error: false });
});

test("keeps transfer failed after a later done event", () => {
  const afterError = nextTransferTerminalState({ done: false, cancelled: false, error: false }, { status: "error" });

  assert.deepEqual(nextTransferTerminalState(afterError, { status: "done" }), {
    done: true,
    cancelled: false,
    error: true,
  });
});

test("keeps running transfer dialog state but resets terminal result on reopen", () => {
  assert.equal(isTransferRunActive({ transferring: true, done: false, cancelled: false, error: false }), true);
  assert.equal(shouldResetTransferDialogOnOpen({ transferring: true, done: false, cancelled: false, error: false }), false);
  assert.equal(shouldResetTransferDialogOnOpen({ transferring: true, done: false, cancelled: false, error: true }), true);
  assert.equal(shouldResetTransferDialogOnOpen({ transferring: true, done: true, cancelled: false, error: false }), true);
  assert.equal(shouldResetTransferDialogOnOpen({ transferring: true, done: false, cancelled: true, error: false }), true);
});

test("keeps editable transfer draft across repeated dialog opens until user starts a new task", () => {
  assert.equal(shouldKeepTransferDraftOnOpen(true, { transferring: false, done: false, cancelled: false, error: false }), true);
  assert.equal(shouldKeepTransferDraftOnOpen(false, { transferring: true, done: false, cancelled: false, error: true }), true);
  assert.equal(shouldKeepTransferDraftOnOpen(false, { transferring: false, done: false, cancelled: false, error: false }), false);
});
