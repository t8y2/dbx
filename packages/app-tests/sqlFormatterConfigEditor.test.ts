import assert from "node:assert/strict";
import { test } from "vitest";
import { createSqlFormatterConfigKeymap, sqlFormatterConfigShortcutRows } from "../../apps/desktop/src/lib/sqlFormatterConfigEditor.ts";

const commands = {
  indentMore: () => true,
  indentLess: () => true,
  copyLineDown: () => true,
  copyLineUp: () => true,
  deleteLine: () => true,
  moveLineUp: () => true,
  moveLineDown: () => true,
  openSearchPanel: () => true,
};
const actions = {
  apply: () => true,
  formatJson: () => true,
};
const otherCommand = () => true;

function createBindings() {
  return createSqlFormatterConfigKeymap(commands, actions);
}

test("builds common SQL formatter config editor key bindings", () => {
  const bindings = createBindings();

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

test("sets search, format, and apply binding details", () => {
  const bindings = createBindings();
  const searchBinding = bindings.find((binding) => binding.key === "Ctrl-h");
  const formatBinding = bindings.find((binding) => binding.key === "Shift-Alt-f");
  const applyBinding = bindings.find((binding) => binding.key === "Mod-s");

  assert.equal(searchBinding?.mac, "Mod-Alt-f");
  assert.equal(searchBinding?.preventDefault, true);
  assert.equal(searchBinding?.run, commands.openSearchPanel);
  assert.equal(formatBinding?.mac, "Shift-Mod-f");
  assert.equal(formatBinding?.preventDefault, true);
  assert.equal(formatBinding?.run, actions.formatJson);
  assert.equal(applyBinding?.preventDefault, true);
  assert.equal(applyBinding?.run, actions.apply);
});

test("keeps duplicate line before later Mod-d search bindings", () => {
  const bindings = [...createBindings(), { key: "Mod-d", run: otherCommand }];
  const duplicateLineIndex = bindings.findIndex(
    (binding) => binding.key === "Mod-d" && binding.run === commands.copyLineDown,
  );
  const searchKeymapIndex = bindings.findIndex((binding) => binding.key === "Mod-d" && binding.run === otherCommand);

  assert.notEqual(duplicateLineIndex, -1);
  assert.notEqual(searchKeymapIndex, -1);
  assert.equal(bindings[duplicateLineIndex]?.run, commands.copyLineDown);
  assert.ok(duplicateLineIndex < searchKeymapIndex);
});

test("shows platform-aware shortcut labels", () => {
  const windowsRows = sqlFormatterConfigShortcutRows("Win32");
  const macRows = sqlFormatterConfigShortcutRows("MacIntel");

  assert.equal(windowsRows.find((row) => row.id === "duplicateLine")?.shortcut, "Ctrl+D");
  assert.equal(macRows.find((row) => row.id === "duplicateLine")?.shortcut, "Cmd+D");
  assert.equal(windowsRows.find((row) => row.id === "formatJson")?.shortcut, "Shift+Alt+F");
  assert.equal(macRows.find((row) => row.id === "formatJson")?.shortcut, "Shift+Cmd+F");
  assert.equal(windowsRows.find((row) => row.id === "apply")?.shortcut, "Ctrl+S");
  assert.equal(macRows.find((row) => row.id === "apply")?.shortcut, "Cmd+S");
});
