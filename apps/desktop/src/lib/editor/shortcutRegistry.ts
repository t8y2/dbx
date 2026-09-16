import { isMacShortcutPlatform, parseShortcutParts, parseShortcutStrokes, shortcutDisplayParts } from "@/lib/editor/shortcutDisplay";

export type ShortcutActionId =
  | "executeSql"
  | "executeSqlInNewResultTab"
  | "explainSql"
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
  | "addNextSelectionOccurrence"
  | "selectAllSelectionOccurrences"
  | "uppercaseSelection"
  | "lowercaseSelection"
  | "convertNamingStyle"
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
  | "toggleAiPanel"
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

// 同词项选择的平台相关默认键。Windows/Linux 上 Ctrl+Mod+G 经 CodeMirror 的
// Mod→Ctrl 展开后成为不可达的 Ctrl-Ctrl-G，且 Ctrl+G 本身是编辑器内
// find-next（Mod-G 的非 mac 展开），因此非 mac 平台改用 JetBrains 风格的
// Alt+J / Ctrl+Alt+Shift+J；macOS 维持 Ctrl+G / Ctrl+Cmd+G。
export function selectionOccurrenceDefaultShortcut(actionId: "addNextSelectionOccurrence" | "selectAllSelectionOccurrences", platform = globalThis.navigator?.platform || ""): string {
  if (isMacShortcutPlatform(platform)) {
    return actionId === "addNextSelectionOccurrence" ? "Ctrl+G" : "Ctrl+Mod+G";
  }
  return actionId === "addNextSelectionOccurrence" ? "Alt+J" : "Ctrl+Alt+Shift+J";
}

export function tabNavigationHistoryDefaultShortcut(direction: "back" | "forward", platform = globalThis.navigator?.platform || ""): string {
  const modifier = isMacShortcutPlatform(platform) ? "Ctrl" : "Mod";
  const key = direction === "back" ? "ArrowLeft" : "ArrowRight";
  return `${modifier}+Alt+${key}`;
}

// Match the shortcut used by VS Code to open its chat sidebar on macOS while
// keeping a reachable, non-conflicting equivalent on Windows/Linux.
export function toggleAiPanelDefaultShortcut(platform = globalThis.navigator?.platform || ""): string {
  return isMacShortcutPlatform(platform) ? "Ctrl+Mod+I" : "Ctrl+Alt+I";
}

const PLATFORM_DEFAULT_SHORTCUTS: Partial<Record<ShortcutActionId, ReadonlySet<string>>> = {
  closeOtherTabs: new Set(["Alt+Mod+W", "Shift+Alt+W"]),
  navigateTabHistoryBack: new Set(["Ctrl+Alt+ArrowLeft", "Mod+Alt+ArrowLeft"]),
  navigateTabHistoryForward: new Set(["Ctrl+Alt+ArrowRight", "Mod+Alt+ArrowRight"]),
  addNextSelectionOccurrence: new Set(["Ctrl+G", "Alt+J"]),
  selectAllSelectionOccurrences: new Set(["Ctrl+Mod+G", "Ctrl+Alt+Shift+J"]),
  toggleAiPanel: new Set(["Ctrl+Mod+I", "Ctrl+Alt+I"]),
};
const LEGACY_CLOSE_TAB_DEFAULT = "Meta+W";
const LEGACY_COPY_CURRENT_ROW_DEFAULT = "Mod+D";
const EDIT_TABLE_STRUCTURE_DEFAULT = "Mod+Shift+D";
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
    id: "explainSql",
    labelKey: "toolbar.explainPlan",
    scope: "editor",
    defaultShortcut: "Mod+E",
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
    id: "addNextSelectionOccurrence",
    labelKey: "settings.shortcutAddNextSelectionOccurrence",
    scope: "editor",
    defaultShortcut: "Ctrl+G",
  },
  {
    id: "selectAllSelectionOccurrences",
    labelKey: "settings.shortcutSelectAllSelectionOccurrences",
    scope: "editor",
    defaultShortcut: "Ctrl+Mod+G",
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
    id: "convertNamingStyle",
    labelKey: "settings.shortcutConvertNamingStyle",
    scope: "editor",
    defaultShortcut: "Shift+Alt+C",
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
    defaultShortcut: EDIT_TABLE_STRUCTURE_DEFAULT,
  },
  {
    id: "copyCurrentRow",
    labelKey: "settings.shortcutCopyCurrentRow",
    scope: "grid",
    defaultShortcut: LEGACY_COPY_CURRENT_ROW_DEFAULT,
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
    id: "toggleAiPanel",
    labelKey: "settings.shortcutToggleAiPanel",
    scope: "global",
    defaultShortcut: toggleAiPanelDefaultShortcut(),
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
  if (definition.id === "addNextSelectionOccurrence") return selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence", platform);
  if (definition.id === "selectAllSelectionOccurrences") return selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences", platform);
  if (definition.id === "closeOtherTabs") return closeOtherTabsDefaultShortcut(platform);
  if (definition.id === "navigateTabHistoryBack") return tabNavigationHistoryDefaultShortcut("back", platform);
  if (definition.id === "navigateTabHistoryForward") return tabNavigationHistoryDefaultShortcut("forward", platform);
  if (definition.id === "toggleAiPanel") return toggleAiPanelDefaultShortcut(platform);
  return definition.defaultShortcut;
}

export function needsTabNavigationHistoryShortcutMigration(settings?: Partial<ShortcutSettings>): boolean {
  return !!settings && TAB_NAVIGATION_HISTORY_ACTIONS.some((actionId) => !hasExplicitShortcut(settings, actionId));
}

export function normalizeShortcutSettings(settings?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): ShortcutSettings {
  const reservedKeyRepairedActionIds = new Set<ShortcutActionId>();
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
      // 用户显式配置（或云同步带入）的 macOS 保留键会重新劫持 ⌘H（#9068 的
      // 配置层复现：CodeMirror 对匹配的绑定 preventDefault，AppKit 菜单的 Hide
      // key equivalent 永远收不到），因此解析后如果命中保留键，则回退到该动作
      // 的平台默认值——而非清空——与上面云同步跨平台默认值的修复行为保持一致。
      if (isReservedShortcut(normalized, platform)) {
        reservedKeyRepairedActionIds.add(definition.id);
        return [definition.id, platformDefault];
      }
      return [definition.id, normalized];
    }),
  ) as ShortcutSettings;

  if (settings?.copyCurrentRow === "" && settings?.editTableStructure === LEGACY_COPY_CURRENT_ROW_DEFAULT) {
    normalized.editTableStructure = EDIT_TABLE_STRUCTURE_DEFAULT;
    normalized.copyCurrentRow = LEGACY_COPY_CURRENT_ROW_DEFAULT;
  }

  for (const actionId of TAB_NAVIGATION_HISTORY_ACTIONS) {
    if (hasExplicitShortcut(settings, actionId)) continue;
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
    if (!definition) continue;
    const defaultShortcut = normalized[actionId];
    const occupiedByExistingAction = SHORTCUT_DEFINITIONS.some((item) => item.id !== actionId && item.scope === definition.scope && hasExplicitShortcut(settings, item.id) && shortcutsUseSameKeys(normalized[item.id], defaultShortcut, platform));
    if (occupiedByExistingAction) normalized[actionId] = "";
  }

  // 修复后的平台默认值如果被同一作用域内另一动作的显式配置占用，则清空而非套用：
  // 默认值不是用户的选择，强加回去会让用户刻意绑定的动作变得不可达——运行时的
  // keymap 先匹配先执行（QueryEditor.vue 中 find 绑定注册在 formatSql 之前，
  // 二者默认都是 Mod+F 时 formatSql 永远轮不到）。用户显式配置必须赢，
  // 占用者只统计显式配置（hasExplicitShortcut），默认值之间的“占位”不算。
  // 与上面 TAB_NAVIGATION_HISTORY_ACTIONS 的占用判定同构；清空后由上方
  // copyCurrentRow/editTableStructure 迁移与 tab 导航占位判定依赖的值均不受影响。
  for (const actionId of reservedKeyRepairedActionIds) {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
    if (!definition) continue;
    const repairedValue = normalized[actionId];
    const occupiedByExistingAction = SHORTCUT_DEFINITIONS.some((item) => item.id !== actionId && item.scope === definition.scope && hasExplicitShortcut(settings, item.id) && shortcutsUseSameKeys(normalized[item.id], repairedValue, platform));
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

// macOS 上由系统/应用菜单占用的快捷键（DBX 自己的应用子菜单，
// src-tauri/src/lib.rs）：
//   Mod+H      Hide，⌘H
//   Alt+Mod+H  Hide Others，⌥⌘H
// Web 视图中任何绑定只要 preventDefault 都会挡住 AppKit 的菜单 key
// equivalent —— 这正是 #9068 里 ⌘H 打开替换面板、应用无法隐藏的机制，
// 所以配置层必须把这些键从所有可绑定动作中排除出去。
// 刻意不包含 ⌘M（Minimize）与 ⌘Q（Quit）：它们不在报告的问题范围内，
// 加入会静默解绑已有用户配置；将来如需覆盖，扩展该集合即可。
export const MACOS_RESERVED_SHORTCUTS: ReadonlySet<string> = new Set(["Mod+H", "Alt+Mod+H"]);

// 本模块内的规范比较形式：在 macOS 分支上（isReservedShortcut 已短路掉非 mac
// 平台），Mod 永远是 ⌘，因此把 Meta/Cmd 别名写成 Mod 后再解析为 Meta，与
// Ctrl/Control 区分开——不能复用 canonicalShortcutKey，它按 "Win32" 把 Mod
// 展开为 Ctrl，会把 ⌃H 误判成 ⌘H。修饰键排序、键名小写，使
// Alt+Mod+H 与 Mod+Alt+H 归一为同一个串。
function macCanonicalShortcut(shortcut: string): string {
  // 保留键判定必须先 trim：配置层消费时会对值做 trim（createQueryEditorReplaceShortcutHandler
  // 等），手工编辑设置 JSON 时误留的前后空白不能成为绕过保留键判定的途径。
  const parts = parseShortcutParts(shortcut.replace(/\b(?:Meta|Cmd)\b/g, "Mod").trim());
  if (parts.length === 0) return "";
  const key = parts[parts.length - 1] ?? "";
  const modifiers = parts
    .slice(0, -1)
    .map((modifier) => (modifier === "Mod" ? "Meta" : modifier === "Control" ? "Ctrl" : modifier))
    .sort()
    .join("+");
  return `${modifiers}${modifiers ? "+" : ""}${key}`.toLowerCase();
}

export function isReservedShortcut(shortcut: string, platform = globalThis.navigator?.platform || ""): boolean {
  // 仅 macOS 保留：Mod+H 在 Windows/Linux 上展开为 Ctrl+H（正常的替换键），
  // 必须原样保留。该短路条件必须先于下面的比较执行。
  if (!shortcut || !isMacShortcutPlatform(platform)) return false;
  const canonical = macCanonicalShortcut(shortcut);
  for (const reserved of MACOS_RESERVED_SHORTCUTS) {
    if (macCanonicalShortcut(reserved) === canonical) return true;
  }
  return false;
}

export function findShortcutConflict(actionId: ShortcutActionId, shortcut: string, shortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): ShortcutActionId | null {
  if (!shortcut) return null;
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  if (!definition) return null;

  const conflict = SHORTCUT_DEFINITIONS.find((item) => item.id !== actionId && item.scope === definition.scope && shortcutsUseSameKeys(shortcuts[item.id], shortcut, platform));
  return conflict?.id ?? null;
}

/**
 * 跨作用域同键（**仅用于提示，不参与任何修复**）。
 *
 * 不同作用域共用同一个组合是**有意的设计**：`find`（editor）与
 * `focusSearch`（global）默认都是 `Mod+F`，运行时由焦点/目标路由区分
 * （`App.vue` 在 `defaultPrevented` 时让位，`ContentArea.focusSearch()`
 * 按聚焦面路由）。因此本函数只**只读地报告**这类重叠，供设置界面以
 * “提示”级别展示；绝不能拿它的结果去改写配置——`normalizeShortcutSettings`
 * 的占用判定刻意只统计**同作用域**（见该函数内的两张占用轮），跨作用域
 * 重叠不在其范围内。
 *
 * 同作用域重复**不**在此返回（那是必须阻断的冲突，见 `findShortcutConflict`）。
 * 未绑定（空串）不参与比较。比较口径与 `findShortcutConflict` 一致：
 * `formatShortcut` 展开 `Mod`、修饰键排序、大小写不敏感，因此
 * `Mod+Shift+D` 与 `Shift+Mod+D` 视为同键。
 */
export function findCrossScopeShortcutConflicts(shortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): Partial<Record<ShortcutActionId, ShortcutActionId[]>> {
  const conflicts: Partial<Record<ShortcutActionId, ShortcutActionId[]>> = {};
  for (const definition of SHORTCUT_DEFINITIONS) {
    const shortcut = shortcuts[definition.id];
    if (!shortcut) continue;
    const others = SHORTCUT_DEFINITIONS.filter((item) => item.id !== definition.id && item.scope !== definition.scope && shortcutsUseSameKeys(shortcuts[item.id], shortcut, platform)).map((item) => item.id);
    if (others.length > 0) conflicts[definition.id] = others;
  }
  return conflicts;
}

/**
 * 去重后的重复对数。行→对方 的映射会把同一对重复算两次（双向各一次），
 * 而摘要文案要说的是“有多少组重复”，故统一按无序对折算。
 *
 * 同时接受 L1（每行单个对方）与 L2（每行多个对方）两种形状，
 * 让同作用域与跨作用域的计数口径保持一致。
 */
export function countShortcutConflictPairs(conflicts: Partial<Record<ShortcutActionId, ShortcutActionId | ShortcutActionId[]>>): number {
  const pairs = new Set<string>();
  for (const [actionId, value] of Object.entries(conflicts)) {
    if (!value) continue;
    for (const other of Array.isArray(value) ? value : [value]) {
      if (!other) continue;
      pairs.add([actionId, other].sort().join("|"));
    }
  }
  return pairs.size;
}
