import { isMacShortcutPlatform, parseShortcutStrokes, shortcutDisplayParts } from "@/lib/editor/shortcutDisplay";

export type ShortcutActionId =
  | "executeSql"
  | "executeSqlInNewResultTab"
  | "formatSql"
  | "expandSelectStar"
  | "toggleLineComment"
  | "toggleBlockComment"
  | "saveSql"
  | "acceptCompletion"
  | "triggerCompletion"
  | "indentMore"
  | "indentLess"
  | "insertLineBelow"
  | "joinLines"
  | "duplicateLine"
  | "deleteLine"
  | "moveLineUp"
  | "moveLineDown"
  | "copyLineUp"
  | "copyLineDown"
  | "undo"
  | "redo"
  | "selectAll"
  | "extendSelection"
  | "uppercaseSelection"
  | "lowercaseSelection"
  | "exPasteSqlInCondition"
  | "toggleFold"
  | "editTableStructure"
  | "copyCurrentRow"
  | "deleteCurrentRow"
  | "goToColumn"
  | "goToFirstPage"
  | "goToPreviousPage"
  | "goToNextPage"
  | "goToLastPage"
  | "newQuery"
  | "openSettings"
  | "closeTab"
  | "closeOtherTabs"
  | "focusSearch"
  | "quickOpen"
  | "navigateTabHistoryBack"
  | "navigateTabHistoryForward"
  | "tabSwitcher"
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
  | "toggleResultsPane"
  | "toggleTranspose"
  | "cancelSearch"
  | "toggleSidebar"
  | "toggleZenMode"
  | "copySidebarSelection"
  | "pasteSidebarSelection"
  | "editSidebarConnection"
  | "openDataInNewTab"
  | "viewTableDdl"
  | "sendSelectionToAi"
  | "sqlIntentionActions";

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
// Web 形态不可拦截）；Shift+Alt+W 无浏览器保留冲突（Firefox accesskey
// 同为 Alt+Shift+字母，属正常应用快捷键区）。
// 已知取舍：Windows 的 Alt+Shift 布局切换只在单独按下并释放时触发，
// Alt+Shift+字母会正常送达应用，多语言用户如遇干扰可自定义改键。
// macOS 的 ⌥⌘W 无上述问题
export function closeOtherTabsDefaultShortcut(platform = globalThis.navigator?.platform || ""): string {
  return isMacShortcutPlatform(platform) ? "Alt+Mod+W" : "Shift+Alt+W";
}

export function tabNavigationHistoryDefaultShortcut(direction: "back" | "forward", platform = globalThis.navigator?.platform || ""): string {
  const modifier = isMacShortcutPlatform(platform) ? "Ctrl" : "Mod";
  const key = direction === "back" ? "ArrowLeft" : "ArrowRight";
  return `${modifier}+Alt+${key}`;
}

const PLATFORM_DEFAULT_SHORTCUTS: Partial<Record<ShortcutActionId, ReadonlySet<string>>> = {
  closeOtherTabs: new Set(["Alt+Mod+W", "Shift+Alt+W"]),
  navigateTabHistoryBack: new Set(["Ctrl+Alt+ArrowLeft", "Mod+Alt+ArrowLeft"]),
  navigateTabHistoryForward: new Set(["Ctrl+Alt+ArrowRight", "Mod+Alt+ArrowRight"]),
};
const LEGACY_CLOSE_TAB_DEFAULT = "Meta+W";
const LEGACY_COPY_CURRENT_ROW_DEFAULT = "Mod+D";
const TAB_NAVIGATION_HISTORY_ACTIONS: ShortcutActionId[] = ["navigateTabHistoryBack", "navigateTabHistoryForward"];

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "executeSql",
    labelKey: "settings.shortcutExecuteSql",
    scope: "editor",
    defaultShortcut: "Mod+Enter",
  },
  {
    id: "executeSqlInNewResultTab",
    labelKey: "settings.shortcutExecuteSqlInNewResultTab",
    scope: "editor",
    defaultShortcut: "Mod+\\",
  },
  {
    id: "formatSql",
    labelKey: "settings.shortcutFormatSql",
    scope: "editor",
    defaultShortcut: "Shift+Mod+F",
  },
  {
    id: "expandSelectStar",
    labelKey: "settings.shortcutExpandSelectStar",
    scope: "editor",
    defaultShortcut: "Mod+Shift+X",
  },
  {
    id: "toggleLineComment",
    labelKey: "settings.shortcutToggleLineComment",
    scope: "editor",
    defaultShortcut: "Mod+/",
  },
  {
    id: "toggleBlockComment",
    labelKey: "settings.shortcutToggleBlockComment",
    scope: "editor",
    defaultShortcut: "Shift+Alt+A",
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
    id: "triggerCompletion",
    labelKey: "settings.shortcutTriggerCompletion",
    scope: "editor",
    defaultShortcut: "Alt+/",
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
    id: "insertLineBelow",
    labelKey: "settings.shortcutInsertLineBelow",
    scope: "editor",
    defaultShortcut: "Shift+Enter",
  },
  {
    id: "joinLines",
    labelKey: "settings.shortcutJoinLines",
    scope: "editor",
    defaultShortcut: "Mod+J",
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
    id: "extendSelection",
    labelKey: "settings.shortcutExtendSelection",
    scope: "editor",
    defaultShortcut: "Alt+W",
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
    id: "toggleFold",
    labelKey: "settings.shortcutToggleFold",
    scope: "editor",
    defaultShortcut: "Mod+.",
  },
  {
    id: "editTableStructure",
    labelKey: "settings.shortcutEditTableStructure",
    scope: "grid",
    defaultShortcut: "Mod+D",
  },
  {
    id: "copyCurrentRow",
    labelKey: "settings.shortcutCopyCurrentRow",
    scope: "grid",
    defaultShortcut: "",
  },
  {
    id: "deleteCurrentRow",
    labelKey: "settings.shortcutDeleteCurrentRow",
    scope: "grid",
    defaultShortcut: "Delete",
  },
  {
    id: "goToColumn",
    labelKey: "settings.shortcutGoToColumn",
    scope: "grid",
    defaultShortcut: "",
  },
  {
    id: "goToFirstPage",
    labelKey: "settings.shortcutGoToFirstPage",
    scope: "grid",
    defaultShortcut: "",
  },
  {
    id: "goToPreviousPage",
    labelKey: "settings.shortcutGoToPreviousPage",
    scope: "grid",
    defaultShortcut: "",
  },
  {
    id: "goToNextPage",
    labelKey: "settings.shortcutGoToNextPage",
    scope: "grid",
    defaultShortcut: "",
  },
  {
    id: "goToLastPage",
    labelKey: "settings.shortcutGoToLastPage",
    scope: "grid",
    defaultShortcut: "",
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
    defaultShortcut: "Mod+W",
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
    id: "navigateTabHistoryBack",
    labelKey: "settings.shortcutNavigateTabHistoryBack",
    scope: "global",
    defaultShortcut: tabNavigationHistoryDefaultShortcut("back"),
  },
  {
    id: "navigateTabHistoryForward",
    labelKey: "settings.shortcutNavigateTabHistoryForward",
    scope: "global",
    defaultShortcut: tabNavigationHistoryDefaultShortcut("forward"),
  },
  {
    id: "tabSwitcher",
    labelKey: "settings.shortcutTabSwitcher",
    scope: "global",
    defaultShortcut: "Ctrl+Tab",
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
    id: "toggleResultsPane",
    labelKey: "settings.shortcutToggleResultsPane",
    scope: "global",
    defaultShortcut: "",
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
    id: "toggleZenMode",
    labelKey: "settings.shortcutToggleZenMode",
    scope: "global",
    defaultShortcut: "Shift+Mod+F12",
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
    id: "viewTableDdl",
    labelKey: "settings.shortcutViewTableDdl",
    scope: "sidebar",
    defaultShortcut: "Shift+Mod+D",
  },
  {
    id: "sendSelectionToAi",
    labelKey: "settings.shortcutSendSelectionToAi",
    scope: "editor",
    defaultShortcut: "Mod+Shift+A",
  },
  {
    id: "sqlIntentionActions",
    labelKey: "settings.shortcutSqlIntentionActions",
    scope: "editor",
    defaultShortcut: "Shift+Mod+Enter",
  },
];

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultShortcut])) as ShortcutSettings;

const modifierOnlyShortcuts = new Set(["Alt", "Shift", "Mod", "Ctrl", "Meta"]);

export function normalizeModifierOnlyShortcut(shortcut: string, fallback = ""): string {
  const normalized = shortcut.trim() === "Control" ? "Ctrl" : shortcut.trim();
  if (normalized === "") return "";
  return modifierOnlyShortcuts.has(normalized) ? normalized : fallback;
}

function hasExplicitShortcut(settings: Partial<ShortcutSettings> | undefined, actionId: ShortcutActionId): boolean {
  return !!settings && Object.prototype.hasOwnProperty.call(settings, actionId) && typeof settings[actionId] === "string";
}

function shortcutsUseSameKeys(first: string, second: string, platform = globalThis.navigator?.platform || ""): boolean {
  return !!first && !!second && formatShortcut(first, platform).toLowerCase() === formatShortcut(second, platform).toLowerCase();
}

function shortcutDefaultForPlatform(definition: ShortcutDefinition, platform: string): string {
  if (definition.id === "closeOtherTabs") return closeOtherTabsDefaultShortcut(platform);
  if (definition.id === "navigateTabHistoryBack") return tabNavigationHistoryDefaultShortcut("back", platform);
  if (definition.id === "navigateTabHistoryForward") return tabNavigationHistoryDefaultShortcut("forward", platform);
  return definition.defaultShortcut;
}

export function needsTabNavigationHistoryShortcutMigration(settings?: Partial<ShortcutSettings>): boolean {
  return !!settings && TAB_NAVIGATION_HISTORY_ACTIONS.some((actionId) => !hasExplicitShortcut(settings, actionId));
}

export function normalizeShortcutSettings(settings?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): ShortcutSettings {
  const normalized = Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((definition) => {
      const configuredValue = settings?.[definition.id];
      const platformDefault = shortcutDefaultForPlatform(definition, platform);
      let configured = typeof configuredValue === "string" ? configuredValue : platformDefault;
      // 云同步会把另一平台的默认值当作显式配置带过来。平台默认集合内的值视为
      // 未自定义，按本机平台重新解析；用户真正自定义的其他组合原样保留
      const platformDefaults = PLATFORM_DEFAULT_SHORTCUTS[definition.id];
      if (platformDefaults?.has(configured)) {
        configured = platformDefault;
      }
      // Meta+W was the old macOS-only default. Treat that exact value as a
      // legacy default so existing Windows/Linux settings adopt Ctrl+W.
      if (definition.id === "closeTab" && configured === LEGACY_CLOSE_TAB_DEFAULT) {
        configured = definition.defaultShortcut;
      }
      const normalized = definition.inputKind === "modifier-only" ? normalizeModifierOnlyShortcut(configured, definition.defaultShortcut) : configured;
      return [definition.id, normalized];
    }),
  ) as ShortcutSettings;

  if (!hasExplicitShortcut(settings, "editTableStructure") && settings?.copyCurrentRow === LEGACY_COPY_CURRENT_ROW_DEFAULT) {
    normalized.editTableStructure = LEGACY_COPY_CURRENT_ROW_DEFAULT;
    normalized.copyCurrentRow = "";
  }

  for (const actionId of TAB_NAVIGATION_HISTORY_ACTIONS) {
    if (hasExplicitShortcut(settings, actionId)) continue;
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
    if (!definition) continue;
    const defaultShortcut = normalized[actionId];
    const occupiedByExistingAction = SHORTCUT_DEFINITIONS.some((item) => item.id !== actionId && item.scope === definition.scope && hasExplicitShortcut(settings, item.id) && shortcutsUseSameKeys(normalized[item.id], defaultShortcut, platform));
    if (occupiedByExistingAction) normalized[actionId] = "";
  }

  return normalized;
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

export function findShortcutConflict(actionId: ShortcutActionId, shortcut: string, shortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): ShortcutActionId | null {
  if (!shortcut) return null;
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  if (!definition) return null;

  const conflict = SHORTCUT_DEFINITIONS.find((item) => item.id !== actionId && item.scope === definition.scope && shortcutsUseSameKeys(shortcuts[item.id], shortcut, platform));
  return conflict?.id ?? null;
}
