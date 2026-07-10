import { strict as assert } from "node:assert";
import { test } from "vitest";

const { isTerminalTransferProgress } = await import("../../apps/desktop/src/lib/backend/transferProgress.ts");

test("treats only terminal transfer progress as the end of a transfer stream", () => {
  assert.equal(isTerminalTransferProgress({ status: "error", terminal: false }), false);
  assert.equal(isTerminalTransferProgress({ status: "error", terminal: true }), true);
  assert.equal(isTerminalTransferProgress({ status: "done", terminal: false }), true);
  assert.equal(isTerminalTransferProgress({ status: "cancelled", terminal: false }), true);
  assert.equal(isTerminalTransferProgress({ status: "running", terminal: false }), false);
});
