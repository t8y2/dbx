import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "../../apps/desktop/src/lib/sqlFormatterConfig.ts";
import { createSqlFormatterConfigKeymap, sqlFormatterConfigShortcutRows } from "../../apps/desktop/src/lib/sqlFormatterConfigEditor.ts";

const commands = {
  indentMore: () => true,
  indentLess: () => true,
  copyLineDown: () => true,
  copyLineUp: () => true,
  deleteLine: () => true,
  moveLineUp: () => true,
  moveLineDown: () => true,
  undo: () => true,
  redo: () => true,
  selectAll: () => true,
  openSearchPanel: () => true,
};
const actions = {
  apply: () => true,
  formatJson: () => true,
};
const otherCommand = () => true;

function createBindings(editorSettings = DEFAULT_SQL_FORMATTER_SETTINGS.editor) {
  return createSqlFormatterConfigKeymap(commands, actions, editorSettings);
}

test("builds common SQL formatter config editor key bindings", () => {
  const bindings = createBindings();

  assert.deepEqual(
    bindings.map((binding) => binding.win),
    ["Ctrl-f", "Ctrl-h", "Tab", "Shift-Tab", "Ctrl-d", "Ctrl-Shift-k", "Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown", "Ctrl-z", "Ctrl-y", "Ctrl-a", "Shift-Alt-f", "Ctrl-s"],
  );
  assert.deepEqual(
    bindings.map((binding) => binding.linux),
    ["Ctrl-f", "Ctrl-h", "Tab", "Shift-Tab", "Ctrl-d", "Ctrl-Shift-k", "Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown", "Ctrl-z", "Ctrl-Shift-z", "Ctrl-a", "Shift-Alt-f", "Ctrl-s"],
  );
});

test("sets search, format, and apply binding details", () => {
  const bindings = createBindings();
  const searchBinding = bindings.find((binding) => binding.win === "Ctrl-h");
  const formatBinding = bindings.find((binding) => binding.win === "Shift-Alt-f");
  const applyBinding = bindings.find((binding) => binding.win === "Ctrl-s");

  assert.equal(searchBinding?.mac, "Mod-Alt-f");
  assert.equal(searchBinding?.linux, "Ctrl-h");
  assert.equal(searchBinding?.preventDefault, true);
  assert.equal(searchBinding?.run, commands.openSearchPanel);
  assert.equal(formatBinding?.mac, "Shift-Mod-f");
  assert.equal(formatBinding?.preventDefault, true);
  assert.equal(formatBinding?.run, actions.formatJson);
  assert.equal(applyBinding?.mac, "Mod-s");
  assert.equal(applyBinding?.preventDefault, true);
  assert.equal(applyBinding?.run, actions.apply);
});

test("keeps duplicate line before later Ctrl-d search bindings", () => {
  const bindings = [...createBindings(), { win: "Ctrl-d", run: otherCommand }];
  const duplicateLineIndex = bindings.findIndex((binding) => binding.win === "Ctrl-d" && binding.run === commands.copyLineDown);
  const searchKeymapIndex = bindings.findIndex((binding) => binding.win === "Ctrl-d" && binding.run === otherCommand);

  assert.notEqual(duplicateLineIndex, -1);
  assert.notEqual(searchKeymapIndex, -1);
  assert.equal(bindings[duplicateLineIndex]?.run, commands.copyLineDown);
  assert.ok(duplicateLineIndex < searchKeymapIndex);
});

test("uses customized shortcut keys and skips disabled shortcuts", () => {
  const editorSettings = {
    ...DEFAULT_SQL_FORMATTER_SETTINGS.editor,
    shortcuts: DEFAULT_SQL_FORMATTER_SETTINGS.editor.shortcuts.map((shortcut) => {
      if (shortcut.id === "duplicateLine") return { ...shortcut, keys: { windows: "Ctrl+W", linux: "Ctrl+W", macos: "Cmd+W" } };
      if (shortcut.id === "deleteLine") return { ...shortcut, enabled: false };
      return shortcut;
    }),
  };

  const bindings = createBindings(editorSettings);
  assert.equal(bindings.find((binding) => binding.win === "Ctrl-w")?.run, commands.copyLineDown);
  assert.equal(bindings.find((binding) => binding.linux === "Ctrl-w")?.run, commands.copyLineDown);
  assert.equal(bindings.some((binding) => binding.win === "Ctrl-Shift-k"), false);
});

test("honors enabled platforms when building key bindings", () => {
  const bindings = createBindings({
    ...DEFAULT_SQL_FORMATTER_SETTINGS.editor,
    platforms: ["linux"],
  });

  assert.equal(bindings.every((binding) => !binding.win && !binding.mac && !!binding.linux), true);
});

test("shows platform-aware shortcut labels", () => {
  const windowsRows = sqlFormatterConfigShortcutRows("Win32");
  const macRows = sqlFormatterConfigShortcutRows("MacIntel");

  assert.equal(windowsRows.find((row) => row.id === "duplicateLine")?.shortcut, "Ctrl+D");
  assert.equal(macRows.find((row) => row.id === "duplicateLine")?.shortcut, "Cmd+D");
  assert.equal(windowsRows.find((row) => row.id === "formatJson")?.shortcut, "Shift+Alt+F");
  assert.equal(macRows.find((row) => row.id === "formatJson")?.shortcut, "Shift+Cmd+F");
  assert.equal(windowsRows.find((row) => row.id === "applyConfig")?.shortcut, "Ctrl+S");
  assert.equal(macRows.find((row) => row.id === "applyConfig")?.shortcut, "Cmd+S");
});
