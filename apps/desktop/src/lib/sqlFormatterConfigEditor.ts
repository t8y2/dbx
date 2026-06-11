import type { Command, KeyBinding } from "@codemirror/view";
import { normalizeSqlFormatterEditorSettings, sqlFormatterPlatformFromNavigator, sqlFormatterShortcutDisplayKeyToCodeMirrorKey, type SqlFormatterEditorSettings, type SqlFormatterEditorShortcutAction, type SqlFormatterEditorShortcutId } from "@/lib/sqlFormatterConfig";

export interface SqlFormatterConfigEditorCommands {
  indentMore: Command;
  indentLess: Command;
  copyLineDown: Command;
  copyLineUp: Command;
  deleteLine: Command;
  moveLineUp: Command;
  moveLineDown: Command;
  undo: Command;
  redo: Command;
  selectAll: Command;
  openSearchPanel: Command;
}

export interface SqlFormatterConfigEditorActions {
  apply: Command;
  formatJson: Command;
}

const shortcutLabelKeys: Record<SqlFormatterEditorShortcutId, string> = {
  find: "settings.sqlFormatterShortcutFind",
  replace: "settings.sqlFormatterShortcutReplace",
  indentMore: "settings.sqlFormatterShortcutIndentMore",
  indentLess: "settings.sqlFormatterShortcutIndentLess",
  duplicateLine: "settings.sqlFormatterShortcutDuplicateLine",
  deleteLine: "settings.sqlFormatterShortcutDeleteLine",
  moveLineUp: "settings.sqlFormatterShortcutMoveLineUp",
  moveLineDown: "settings.sqlFormatterShortcutMoveLineDown",
  copyLineUp: "settings.sqlFormatterShortcutCopyLineUp",
  copyLineDown: "settings.sqlFormatterShortcutCopyLineDown",
  undo: "settings.sqlFormatterShortcutUndo",
  redo: "settings.sqlFormatterShortcutRedo",
  selectAll: "settings.sqlFormatterShortcutSelectAll",
  formatJson: "settings.sqlFormatterShortcutFormatJson",
  applyConfig: "settings.sqlFormatterShortcutApply",
};

export function sqlFormatterConfigShortcutLabelKey(id: SqlFormatterEditorShortcutId): string {
  return shortcutLabelKeys[id];
}

function commandForAction(commands: SqlFormatterConfigEditorCommands, actions: SqlFormatterConfigEditorActions, action: SqlFormatterEditorShortcutAction): Command {
  switch (action) {
    case "indentMore":
      return commands.indentMore;
    case "indentLess":
      return commands.indentLess;
    case "copyLineDown":
      return commands.copyLineDown;
    case "copyLineUp":
      return commands.copyLineUp;
    case "deleteLine":
      return commands.deleteLine;
    case "moveLineUp":
      return commands.moveLineUp;
    case "moveLineDown":
      return commands.moveLineDown;
    case "undo":
      return commands.undo;
    case "redo":
      return commands.redo;
    case "selectAll":
      return commands.selectAll;
    case "openSearchPanel":
      return commands.openSearchPanel;
    case "formatJson":
      return actions.formatJson;
    case "applyJsonDraft":
      return actions.apply;
  }
}

export function createSqlFormatterConfigKeymap(commands: SqlFormatterConfigEditorCommands, actions: SqlFormatterConfigEditorActions, editorSettings?: SqlFormatterEditorSettings): KeyBinding[] {
  const settings = normalizeSqlFormatterEditorSettings(editorSettings);
  const platforms = new Set(settings.platforms);

  return settings.shortcuts
    .filter((shortcut) => shortcut.enabled)
    .map((shortcut) => {
      const binding: KeyBinding = {
        run: commandForAction(commands, actions, shortcut.action),
        preventDefault: true,
      };
      if (platforms.has("windows")) binding.win = sqlFormatterShortcutDisplayKeyToCodeMirrorKey(shortcut.keys.windows) ?? undefined;
      if (platforms.has("linux")) binding.linux = sqlFormatterShortcutDisplayKeyToCodeMirrorKey(shortcut.keys.linux) ?? undefined;
      if (platforms.has("macos")) binding.mac = sqlFormatterShortcutDisplayKeyToCodeMirrorKey(shortcut.keys.macos) ?? undefined;
      return binding;
    });
}

export interface SqlFormatterConfigShortcutRow {
  id: string;
  labelKey: string;
  shortcut: string;
}

export function sqlFormatterConfigShortcutRows(platform = globalThis.navigator?.platform || "", editorSettings?: SqlFormatterEditorSettings): SqlFormatterConfigShortcutRow[] {
  const platformKey = sqlFormatterPlatformFromNavigator(platform);

  return normalizeSqlFormatterEditorSettings(editorSettings)
    .shortcuts.filter((shortcut) => shortcut.enabled)
    .map((shortcut) => ({
      id: shortcut.id,
      labelKey: shortcutLabelKeys[shortcut.id],
      shortcut: shortcut.keys[platformKey],
    }));
}
