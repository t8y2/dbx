import { test } from "vitest";
import assert from "node:assert/strict";
import { focusSidebarRenameInput, shouldPreventRenameCloseAutoFocus } from "../../apps/desktop/src/lib/sidebarRenameFocus.ts";

test("focusSidebarRenameInput waits for menu focus restoration before focusing", () => {
  const calls: string[] = [];
  let scheduled: (() => void) | undefined;

  focusSidebarRenameInput(
    () => ({
      focus: () => calls.push("focus"),
      select: () => calls.push("select"),
    }),
    (callback) => {
      scheduled = callback;
      return 1;
    },
  );

  assert.deepEqual(calls, []);

  scheduled?.();

  assert.deepEqual(calls, ["focus", "select"]);
});

test("focusSidebarRenameInput skips focusing when the input disappeared", () => {
  let scheduled: (() => void) | undefined;

  focusSidebarRenameInput(
    () => undefined,
    (callback) => {
      scheduled = callback;
      return 1;
    },
  );

  assert.doesNotThrow(() => scheduled?.());
});

test("shouldPreventRenameCloseAutoFocus consumes exactly one pending rename focus restore", () => {
  const pending = { value: true };

  assert.equal(shouldPreventRenameCloseAutoFocus(pending), true);
  assert.equal(pending.value, false);
  assert.equal(shouldPreventRenameCloseAutoFocus(pending), false);
});
