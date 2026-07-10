import { parseShortcutStrokes, shortcutDisplayParts } from "@/lib/editor/shortcutDisplay";

export type ShortcutActionId =
  | "executeSql"
  | "formatSql"
  | "toggleLineComment"
  | "saveSql"
  | "acceptCompletion"
  | "indentMore"
  | "indentLess"
  | "duplicateLine"
  | "deleteLine"
  | "moveLineUp"
  | "moveLineDown"
  | "copyLineUp"
  | "copyLineDown"
  | "undo"
  | "redo"
  | "selectAll"
  | "uppercaseSelection"
  | "lowercaseSelection"
  | "exPasteSqlInCondition"
  | "copyCurrentRow"
  | "deleteCurrentRow"
  | "newQuery"
  | "openSettings"
  | "closeTab"
  | "focusSearch"
  | "quickOpen"
  | "switchToPreviousTab"
  | "switchToNextTab"
  | "switchToTab1"
  | "switchToTab2"
  | "switchToTab3"
  | "switchToTab4"
  | "switchToTab5"
  | "switchToTab6"
  | "switchToTab7"
  | "switchToTab8"
  | "switchToTab9"
  | "zoomInUi"
  | "zoomOutUi"
  | "resetUiZoom"
  | "find"
  | "replace"
  | "refreshData"
  | "toggleTranspose"
  | "cancelSearch"
  | "toggleSidebar"
  | "copySidebarSelection"
  | "pasteSidebarSelection"
  | "editSidebarConnection"
  | "sendSelectionToAi";

export type ShortcutScope = "global" | "editor" | "grid" | "search" | "sidebar";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  labelKey: string;
  scope: ShortcutScope;
  defaultShortcut: string;
}

export type ShortcutSettings = Record<ShortcutActionId, string>;

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "executeSql",
    labelKey: "settings.shortcutExecuteSql",
    scope: "editor",
    defaultShortcut: "Mod+Enter",
  },
  {
    id: "formatSql",
    labelKey: "settings.shortcutFormatSql",
    scope: "editor",
    defaultShortcut: "Shift+Mod+F",
  },
  {
    id: "toggleLineComment",
    labelKey: "settings.shortcutToggleLineComment",
    scope: "editor",
    defaultShortcut: "Mod+/",
  },
  {
    id: "saveSql",
    labelKey: "settings.shortcutSaveSql",
    scope: "editor",
    defaultShortcut: "Mod+S",
  },
  {
    id: "acceptCompletion",
    labelKey: "settings.shortcutAcceptCompletion",
    scope: "editor",
    defaultShortcut: "Tab",
  },
  {
    id: "indentMore",
    labelKey: "settings.shortcutIndentMore",
    scope: "editor",
    defaultShortcut: "",
  },
  {
    id: "indentLess",
    labelKey: "settings.shortcutIndentLess",
    scope: "editor",
    defaultShortcut: "Shift+Tab",
  },
  {
    id: "duplicateLine",
    labelKey: "settings.shortcutDuplicateLine",
    scope: "editor",
    defaultShortcut: "Mod+D",
  },
  {
    id: "deleteLine",
    labelKey: "settings.shortcutDeleteLine",
    scope: "editor",
    defaultShortcut: "Shift+Mod+K",
  },
  {
    id: "moveLineUp",
    labelKey: "settings.shortcutMoveLineUp",
    scope: "editor",
    defaultShortcut: "Alt+ArrowUp",
  },
  {
    id: "moveLineDown",
    labelKey: "settings.shortcutMoveLineDown",
    scope: "editor",
    defaultShortcut: "Alt+ArrowDown",
  },
  {
    id: "copyLineUp",
    labelKey: "settings.shortcutCopyLineUp",
    scope: "editor",
    defaultShortcut: "Shift+Alt+ArrowUp",
  },
  {
    id: "copyLineDown",
    labelKey: "settings.shortcutCopyLineDown",
    scope: "editor",
    defaultShortcut: "Shift+Alt+ArrowDown",
  },
  {
    id: "undo",
    labelKey: "settings.shortcutUndo",
    scope: "editor",
    defaultShortcut: "Mod+Z",
  },
  {
    id: "redo",
    labelKey: "settings.shortcutRedo",
    scope: "editor",
    defaultShortcut: "Shift+Mod+Z",
  },
  {
    id: "selectAll",
    labelKey: "settings.shortcutSelectAll",
    scope: "editor",
    defaultShortcut: "Mod+A",
  },
  {
    id: "uppercaseSelection",
    labelKey: "settings.shortcutUppercaseSelection",
    scope: "editor",
    defaultShortcut: "Shift+Alt+U",
  },
  {
    id: "lowercaseSelection",
    labelKey: "settings.shortcutLowercaseSelection",
    scope: "editor",
    defaultShortcut: "Shift+Alt+L",
  },
  {
    id: "exPasteSqlInCondition",
    labelKey: "settings.shortcutExPasteSqlInCondition",
    scope: "editor",
    defaultShortcut: "",
  },
  {
    id: "copyCurrentRow",
    labelKey: "settings.shortcutCopyCurrentRow",
    scope: "grid",
    defaultShortcut: "Mod+D",
  },
  {
    id: "deleteCurrentRow",
    labelKey: "settings.shortcutDeleteCurrentRow",
    scope: "grid",
    defaultShortcut: "Delete",
  },
  {
    id: "newQuery",
    labelKey: "settings.shortcutNewQuery",
    scope: "global",
    defaultShortcut: "Mod+T",
  },
  {
    id: "openSettings",
    labelKey: "settings.shortcutOpenSettings",
    scope: "global",
    defaultShortcut: "Mod+,",
  },
  {
    id: "closeTab",
    labelKey: "settings.shortcutCloseTab",
    scope: "global",
    defaultShortcut: "Meta+W",
  },
  {
    id: "focusSearch",
    labelKey: "settings.shortcutFocusSearch",
    scope: "global",
    defaultShortcut: "Mod+F",
  },
  {
    id: "quickOpen",
    labelKey: "settings.shortcutQuickOpen",
    scope: "global",
    defaultShortcut: "Mod+P",
  },
  {
    id: "switchToPreviousTab",
    labelKey: "settings.shortcutSwitchToPreviousTab",
    scope: "global",
    defaultShortcut: "Shift+Mod+[",
  },
  {
    id: "switchToNextTab",
    labelKey: "settings.shortcutSwitchToNextTab",
    scope: "global",
    defaultShortcut: "Shift+Mod+]",
  },
  {
    id: "switchToTab1",
    labelKey: "settings.shortcutSwitchToTab1",
    scope: "global",
    defaultShortcut: "Mod+1",
  },
  {
    id: "switchToTab2",
    labelKey: "settings.shortcutSwitchToTab2",
    scope: "global",
    defaultShortcut: "Mod+2",
  },
  {
    id: "switchToTab3",
    labelKey: "settings.shortcutSwitchToTab3",
    scope: "global",
    defaultShortcut: "Mod+3",
  },
  {
    id: "switchToTab4",
    labelKey: "settings.shortcutSwitchToTab4",
    scope: "global",
    defaultShortcut: "Mod+4",
  },
  {
    id: "switchToTab5",
    labelKey: "settings.shortcutSwitchToTab5",
    scope: "global",
    defaultShortcut: "Mod+5",
  },
  {
    id: "switchToTab6",
    labelKey: "settings.shortcutSwitchToTab6",
    scope: "global",
    defaultShortcut: "Mod+6",
  },
  {
    id: "switchToTab7",
    labelKey: "settings.shortcutSwitchToTab7",
    scope: "global",
    defaultShortcut: "Mod+7",
  },
  {
    id: "switchToTab8",
    labelKey: "settings.shortcutSwitchToTab8",
    scope: "global",
    defaultShortcut: "Mod+8",
  },
  {
    id: "switchToTab9",
    labelKey: "settings.shortcutSwitchToTab9",
    scope: "global",
    defaultShortcut: "Mod+9",
  },
  {
    id: "zoomInUi",
    labelKey: "settings.shortcutZoomInUi",
    scope: "global",
    defaultShortcut: "Mod+=",
  },
  {
    id: "zoomOutUi",
    labelKey: "settings.shortcutZoomOutUi",
    scope: "global",
    defaultShortcut: "Mod+-",
  },
  {
    id: "resetUiZoom",
    labelKey: "settings.shortcutResetUiZoom",
    scope: "global",
    defaultShortcut: "Mod+0",
  },
  {
    id: "find",
    labelKey: "settings.shortcutFind",
    scope: "editor",
    defaultShortcut: "Mod+F",
  },
  {
    id: "replace",
    labelKey: "settings.shortcutReplace",
    scope: "editor",
    defaultShortcut: "Mod+R",
  },
  {
    id: "refreshData",
    labelKey: "settings.shortcutRefreshData",
    scope: "global",
    defaultShortcut: "F5",
  },
  {
    id: "toggleTranspose",
    labelKey: "settings.shortcutToggleTranspose",
    scope: "grid",
    defaultShortcut: "Tab",
  },
  {
    id: "cancelSearch",
    labelKey: "settings.shortcutCancelSearch",
    scope: "search",
    defaultShortcut: "Escape",
  },
  {
    id: "toggleSidebar",
    labelKey: "settings.shortcutToggleSidebar",
    scope: "global",
    defaultShortcut: "Mod+B",
  },
  {
    id: "copySidebarSelection",
    labelKey: "settings.shortcutCopySidebarSelection",
    scope: "sidebar",
    defaultShortcut: "Mod+C",
  },
  {
    id: "pasteSidebarSelection",
    labelKey: "settings.shortcutPasteSidebarSelection",
    scope: "sidebar",
    defaultShortcut: "Mod+V",
  },
  {
    id: "editSidebarConnection",
    labelKey: "settings.shortcutEditSidebarConnection",
    scope: "sidebar",
    defaultShortcut: "Mod+E",
  },
  {
    id: "sendSelectionToAi",
    labelKey: "settings.shortcutSendSelectionToAi",
    scope: "editor",
    defaultShortcut: "Mod+Shift+A",
  },
];

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultShortcut])) as ShortcutSettings;

export function normalizeShortcutSettings(settings?: Partial<ShortcutSettings>): ShortcutSettings {
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, typeof settings?.[definition.id] === "string" ? settings[definition.id] : definition.defaultShortcut])) as ShortcutSettings;
}

export function shortcutToCodeMirrorKey(shortcut: string): string {
  return parseShortcutStrokes(shortcut)
    .map((parts) =>
      parts
        .map((part) => (part.length === 1 ? part.toLowerCase() : part))
        .map((part) => (part === "Plus" ? "+" : part))
        .join("-"),
    )
    .join(" ");
}

export function formatShortcut(shortcut: string, platform = globalThis.navigator?.platform || ""): string {
  const isMac = platform.toLowerCase().includes("mac");
  return shortcutDisplayParts(shortcut, platform)
    .map((part) => {
      if (part === "Mod") return isMac ? "Cmd" : "Ctrl";
      if (part === "Meta") return isMac ? "Cmd" : "Meta";
      if (part === "Plus") return "+";
      return part;
    })
    .join("+");
}

export function findShortcutConflict(actionId: ShortcutActionId, shortcut: string, shortcuts: ShortcutSettings): ShortcutActionId | null {
  if (!shortcut) return null;
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  if (!definition) return null;

  const conflict = SHORTCUT_DEFINITIONS.find((item) => item.id !== actionId && item.scope === definition.scope && shortcuts[item.id] === shortcut);
  return conflict?.id ?? null;
}
