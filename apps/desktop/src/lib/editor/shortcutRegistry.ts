import { isMacShortcutPlatform, parseShortcutStrokes, shortcutDisplayParts } from "@/lib/editor/shortcutDisplay";

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
  | "closeOtherTabs"
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
  | "openDataInNewTab"
  | "sendSelectionToAi";

export type ShortcutScope = "global" | "editor" | "grid" | "search" | "sidebar";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  labelKey: string;
  scope: ShortcutScope;
  defaultShortcut: string;
  inputKind?: "keyboard" | "modifier-only";
}

export type ShortcutSettings = Record<ShortcutActionId, string>;

// closeOtherTabs 的平台相关默认键。Windows/Linux 不用 Alt+Mod（= Ctrl+Alt，
// 与国际键盘 AltGr 字符输入冲突），也不用 Ctrl+Shift+W（浏览器保留的关窗键，
// Web 形态不可拦截，closeTab 默认 Meta+W 同理）；Shift+Alt+W 无浏览器保留
// 冲突（Firefox accesskey 同为 Alt+Shift+字母，属正常应用快捷键区）。
// 已知取舍：Windows 的 Alt+Shift 布局切换只在单独按下并释放时触发，
// Alt+Shift+字母会正常送达应用，多语言用户如遇干扰可自定义改键。
// macOS 的 ⌥⌘W 无上述问题
export function closeOtherTabsDefaultShortcut(platform = globalThis.navigator?.platform || ""): string {
  return isMacShortcutPlatform(platform) ? "Alt+Mod+W" : "Shift+Alt+W";
}

const CLOSE_OTHER_TABS_PLATFORM_DEFAULTS = new Set(["Alt+Mod+W", "Shift+Alt+W"]);

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
    id: "closeOtherTabs",
    labelKey: "contextMenu.closeOtherTabs",
    scope: "global",
    defaultShortcut: closeOtherTabsDefaultShortcut(),
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
    id: "openDataInNewTab",
    labelKey: "settings.shortcutOpenDataInNewTab",
    scope: "sidebar",
    defaultShortcut: "Alt",
    inputKind: "modifier-only",
  },
  {
    id: "sendSelectionToAi",
    labelKey: "settings.shortcutSendSelectionToAi",
    scope: "editor",
    defaultShortcut: "Mod+Shift+A",
  },
];

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultShortcut])) as ShortcutSettings;

const modifierOnlyShortcuts = new Set(["Alt", "Shift", "Mod", "Ctrl", "Meta"]);

export function normalizeModifierOnlyShortcut(shortcut: string, fallback = ""): string {
  const normalized = shortcut.trim() === "Control" ? "Ctrl" : shortcut.trim();
  if (normalized === "") return "";
  return modifierOnlyShortcuts.has(normalized) ? normalized : fallback;
}

export function normalizeShortcutSettings(settings?: Partial<ShortcutSettings>): ShortcutSettings {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((definition) => {
      const configuredValue = settings?.[definition.id];
      let configured = typeof configuredValue === "string" ? configuredValue : definition.defaultShortcut;
      // 云同步会把另一平台的默认值当作显式配置带过来（macOS 的 Alt+Mod+W 到
      // Windows 上会还原成 Ctrl+Alt+W）。凡是平台默认集合内的值都视为"未
      // 自定义"，按本机平台重新解析；用户真正自定义的其他组合原样保留
      if (definition.id === "closeOtherTabs" && CLOSE_OTHER_TABS_PLATFORM_DEFAULTS.has(configured)) {
        configured = definition.defaultShortcut;
      }
      const normalized = definition.inputKind === "modifier-only" ? normalizeModifierOnlyShortcut(configured, definition.defaultShortcut) : configured;
      return [definition.id, normalized];
    }),
  ) as ShortcutSettings;
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
