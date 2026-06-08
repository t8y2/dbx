import type { Command, KeyBinding } from "@codemirror/view";

export interface SqlFormatterConfigEditorCommands {
  indentMore: Command;
  indentLess: Command;
  copyLineDown: Command;
  copyLineUp: Command;
  deleteLine: Command;
  moveLineUp: Command;
  moveLineDown: Command;
  openSearchPanel: Command;
}

export interface SqlFormatterConfigEditorActions {
  apply: Command;
  formatJson: Command;
}

export function createSqlFormatterConfigKeymap(
  commands: SqlFormatterConfigEditorCommands,
  actions: SqlFormatterConfigEditorActions,
): KeyBinding[] {
  return [
    { key: "Tab", run: commands.indentMore },
    { key: "Shift-Tab", run: commands.indentLess },
    { key: "Mod-d", run: commands.copyLineDown },
    { key: "Shift-Mod-k", run: commands.deleteLine },
    { key: "Alt-ArrowUp", run: commands.moveLineUp },
    { key: "Alt-ArrowDown", run: commands.moveLineDown },
    { key: "Shift-Alt-ArrowUp", run: commands.copyLineUp },
    { key: "Shift-Alt-ArrowDown", run: commands.copyLineDown },
    { key: "Ctrl-h", mac: "Mod-Alt-f", run: commands.openSearchPanel, preventDefault: true },
    { key: "Shift-Alt-f", mac: "Shift-Mod-f", run: actions.formatJson, preventDefault: true },
    { key: "Mod-s", run: actions.apply, preventDefault: true },
  ];
}

export interface SqlFormatterConfigShortcutRow {
  id: string;
  labelKey: string;
  shortcut: string;
}

function modLabel(platform = globalThis.navigator?.platform || ""): "Cmd" | "Ctrl" {
  return platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
}

function altLabel(platform = globalThis.navigator?.platform || ""): "Option" | "Alt" {
  return platform.toLowerCase().includes("mac") ? "Option" : "Alt";
}

export function sqlFormatterConfigShortcutRows(
  platform = globalThis.navigator?.platform || "",
): SqlFormatterConfigShortcutRow[] {
  const isMac = platform.toLowerCase().includes("mac");
  const mod = modLabel(platform);
  const alt = altLabel(platform);

  return [
    { id: "find", labelKey: "settings.sqlFormatterShortcutFind", shortcut: `${mod}+F` },
    {
      id: "replace",
      labelKey: "settings.sqlFormatterShortcutReplace",
      shortcut: isMac ? "Cmd+Option+F" : "Ctrl+H",
    },
    { id: "indentMore", labelKey: "settings.sqlFormatterShortcutIndentMore", shortcut: "Tab" },
    { id: "indentLess", labelKey: "settings.sqlFormatterShortcutIndentLess", shortcut: "Shift+Tab" },
    { id: "duplicateLine", labelKey: "settings.sqlFormatterShortcutDuplicateLine", shortcut: `${mod}+D` },
    { id: "deleteLine", labelKey: "settings.sqlFormatterShortcutDeleteLine", shortcut: `${mod}+Shift+K` },
    { id: "moveLine", labelKey: "settings.sqlFormatterShortcutMoveLine", shortcut: `${alt}+Up/Down` },
    { id: "copyLine", labelKey: "settings.sqlFormatterShortcutCopyLine", shortcut: `Shift+${alt}+Up/Down` },
    {
      id: "formatJson",
      labelKey: "settings.sqlFormatterShortcutFormatJson",
      shortcut: isMac ? "Shift+Cmd+F" : "Shift+Alt+F",
    },
    { id: "apply", labelKey: "settings.sqlFormatterShortcutApply", shortcut: `${mod}+S` },
  ];
}
