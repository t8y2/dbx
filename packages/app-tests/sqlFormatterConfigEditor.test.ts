import assert from "node:assert/strict";
import { test } from "vitest";
import { createSqlFormatterConfigKeymap, sqlFormatterConfigShortcutRows } from "../../apps/desktop/src/lib/sqlFormatterConfigEditor.ts";

const command = () => true;

test("builds common SQL formatter config editor key bindings", () => {
  const bindings = createSqlFormatterConfigKeymap(
    {
      indentMore: command,
      indentLess: command,
      copyLineDown: command,
      copyLineUp: command,
      deleteLine: command,
      moveLineUp: command,
      moveLineDown: command,
      openSearchPanel: command,
    },
    {
      apply: command,
      formatJson: command,
    },
  );

  assert.deepEqual(
    bindings.map((binding) => binding.key),
    [
      "Tab",
      "Shift-Tab",
      "Mod-d",
      "Shift-Mod-k",
      "Alt-ArrowUp",
      "Alt-ArrowDown",
      "Shift-Alt-ArrowUp",
      "Shift-Alt-ArrowDown",
      "Ctrl-h",
      "Shift-Alt-f",
      "Mod-s",
    ],
  );
});

test("shows platform-aware shortcut labels", () => {
  const windowsRows = sqlFormatterConfigShortcutRows("Win32");
  const macRows = sqlFormatterConfigShortcutRows("MacIntel");

  assert.equal(windowsRows.find((row) => row.id === "duplicateLine")?.shortcut, "Ctrl+D");
  assert.equal(macRows.find((row) => row.id === "duplicateLine")?.shortcut, "Cmd+D");
  assert.equal(windowsRows.find((row) => row.id === "apply")?.shortcut, "Ctrl+S");
  assert.equal(macRows.find((row) => row.id === "apply")?.shortcut, "Cmd+S");
});
