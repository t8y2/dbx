import { isMacShortcutPlatform, parseShortcutParts } from "@/lib/editor/shortcutDisplay";
import { normalizeShortcutSettings, type ShortcutActionId, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";

export interface ShortcutLikeEvent {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "+" || key === "Plus") return "Plus";
  return key.length === 1 ? key.toLowerCase() : key;
}

// Physical keys whose unshifted character CodeMirror always registers bindings
// under. `KeyboardEvent.key` reports the *shifted* character instead ("/" -> "?",
// "1" -> "!"), so a shortcut recorded from that character can never match the
// binding CodeMirror looks up. Letters are excluded: they already round-trip
// because `shortcutToCodeMirrorKey` lowercases them.
const BASE_KEY_BY_CODE: Record<string, string> = {
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadDivide: "/",
  NumpadMultiply: "*",
  NumpadSubtract: "-",
  NumpadAdd: "+",
  NumpadDecimal: ".",
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
};

const CJK_OR_MUTATED_PUNCTUATION: Record<string, string> = {
  "、": "/",
  "·": "`",
  "【": "[",
  "】": "]",
  "。": ".",
  "，": ",",
  "；": ";",
  "：": ";",
  "“": "'",
  "”": "'",
  "‘": "'",
  "’": "'",
  Divide: "/",
  Multiply: "*",
  Subtract: "-",
  Add: "+",
  Decimal: ".",
  "÷": "/",
};

/**
 * Physical unshifted character for a key press, or null when not applicable.
 * Handles shifted punctuation/digit presses (mirroring CodeMirror keymap resolution),
 * physical Slash / NumpadDivide, IME placeholders (Process / Unidentified), and
 * CJK punctuation emitted by active input methods on Windows.
 */
function baseKeyForEvent(event: ShortcutLikeEvent): string | null {
  const code = event.code ?? "";

  // Shifted punctuation/digit press (e.g. "?" on Slash -> "/", "!" on Digit1 -> "1")
  if (event.shiftKey && event.key && event.key.length === 1) {
    const baseKey = BASE_KEY_BY_CODE[code];
    if (baseKey && baseKey !== event.key) return baseKey;
  }

  // Physical slash or numpad divide always resolves to "/"
  if (code === "Slash" || code === "NumpadDivide") {
    return "/";
  }

  // Known deformed or CJK punctuation produced by the physical key
  if (event.key && CJK_OR_MUTATED_PUNCTUATION[event.key]) {
    return CJK_OR_MUTATED_PUNCTUATION[event.key];
  }

  // IME placeholder key (Process / Unidentified) with recognized code
  if (event.key === "Process" || event.key === "Unidentified") {
    if (BASE_KEY_BY_CODE[code]) return BASE_KEY_BY_CODE[code];
  }

  // Numpad named keys like "Divide", "Multiply", "Add", etc.
  if (code.startsWith("Numpad") && BASE_KEY_BY_CODE[code]) {
    return BASE_KEY_BY_CODE[code];
  }

  return null;
}

function matchesShortcutKey(event: ShortcutLikeEvent, key: string, platform = globalThis.navigator?.platform || ""): boolean {
  const normalizedTarget = normalizeKey(key);
  if (normalizeKey(event.key) === normalizedTarget) return true;

  // Match against physical key / unshifted base key (shifted punctuation,
  // Slash / NumpadDivide, IME Process / CJK punctuation, numpad keys)
  const baseKey = baseKeyForEvent(event);
  if (baseKey && normalizeKey(baseKey) === normalizedTarget) return true;

  // Slash / NumpadDivide physical key match for "/"
  if (normalizedTarget === "/" && (event.code === "Slash" || event.code === "NumpadDivide")) {
    return true;
  }

  // KeyboardEvent.code 回退：event.key 随布局/修饰键变形时按物理键位匹配
  // （macOS Option+字母 → 变形字符如 ⌥W="∑"；俄文等非拉丁布局 → "Ц"）。
  // 仅限 Alt 组合键场景
  if (event.altKey && /^Key[A-Z]$/.test(event.code ?? "") && /^[A-Z]$/i.test(key)) {
    // 非 macOS 的 Ctrl+Alt 是 AltGr 特征：用户可能在输入字符（如波兰语
    // AltGr+W → "ł"），按 code 强制匹配会让全局快捷键在打字时误触发
    if (!isMacShortcutPlatform(platform) && event.ctrlKey) return false;
    return event.code!.slice(3).toLowerCase() === key.toLowerCase();
  }

  if ((event.key === "Process" || event.key === "Unidentified") && /^Key[A-Z]$/.test(event.code ?? "") && /^[A-Z]$/i.test(key)) {
    return event.code!.slice(3).toLowerCase() === key.toLowerCase();
  }

  return false;
}

function shortcutKeyName(key: string): string | null {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  if (["Control", "Meta", "Shift", "Alt"].includes(key)) return null;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function shortcutKeyNameFromEvent(event: ShortcutLikeEvent, platform: string): string | null {
  if (event.altKey && isMacShortcutPlatform(platform) && /^Key[A-Z]$/.test(event.code ?? "")) {
    return event.code!.slice(3);
  }
  const baseKey = baseKeyForEvent(event);
  if (baseKey) return shortcutKeyName(baseKey);
  if ((event.key === "Process" || event.key === "Unidentified") && /^Key[A-Z]$/.test(event.code ?? "")) {
    return event.code!.slice(3).toUpperCase();
  }
  return shortcutKeyName(event.key);
}

export function eventToShortcut(event: ShortcutLikeEvent, platform = globalThis.navigator?.platform || ""): string | null {
  const isSlashShortcut = (event.code === "Slash" || event.code === "NumpadDivide") && (!!event.ctrlKey || !!event.metaKey);
  if (event.isComposing && !isSlashShortcut) return null;

  const key = shortcutKeyNameFromEvent(event, platform);
  if (!key) return null;

  const hasModifier = !!event.metaKey || !!event.ctrlKey || !!event.altKey || !!event.shiftKey;
  if (!hasModifier && event.key.length === 1 && event.key !== " ") return null;

  const isMac = isMacShortcutPlatform(platform);
  const parts: string[] = [];
  if (event.shiftKey) parts.push("Shift");
  if (isMac) {
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.metaKey) parts.push("Mod");
  } else if (event.ctrlKey && event.metaKey) {
    parts.push("Mod", "Meta");
  } else if (event.ctrlKey || event.metaKey) {
    parts.push("Mod");
  }
  if (event.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

export function eventToModifierOnlyShortcut(event: ShortcutLikeEvent, platform = globalThis.navigator?.platform || ""): string | null {
  if (event.isComposing) return null;
  if (event.key === "Alt") return "Alt";
  if (event.key === "Shift") return "Shift";
  if (event.key === "Meta") return isMacShortcutPlatform(platform) ? "Mod" : "Meta";
  if (event.key === "Control") return isMacShortcutPlatform(platform) ? "Ctrl" : "Mod";
  return null;
}

export function matchesModifierOnlyShortcut(event: Omit<ShortcutLikeEvent, "key">, shortcut: string): boolean {
  if (event.isComposing || !shortcut) return false;
  const meta = !!event.metaKey;
  const ctrl = !!event.ctrlKey;
  const alt = !!event.altKey;
  const shift = !!event.shiftKey;
  if (shortcut === "Mod") return meta !== ctrl && !alt && !shift;
  if (shortcut === "Meta") return meta && !ctrl && !alt && !shift;
  if (shortcut === "Ctrl") return ctrl && !meta && !alt && !shift;
  if (shortcut === "Alt") return alt && !meta && !ctrl && !shift;
  if (shortcut === "Shift") return shift && !meta && !ctrl && !alt;
  return false;
}

export function matchesShortcut(event: ShortcutLikeEvent, shortcut: string, platform = globalThis.navigator?.platform || ""): boolean {
  const isSlashShortcut = (event.code === "Slash" || event.code === "NumpadDivide") && (!!event.ctrlKey || !!event.metaKey);
  if ((event.isComposing && !isSlashShortcut) || !shortcut) return false;
  const parts = parseShortcutParts(shortcut);
  const key = parts[parts.length - 1] ?? "";
  const modifiers = new Set(parts.slice(0, -1));
  const usesMod = modifiers.has("Mod");
  const usesMeta = modifiers.has("Meta");
  const usesCtrl = modifiers.has("Ctrl");

  if (usesMod) {
    if (isMacShortcutPlatform(platform)) {
      if (!event.metaKey || !!event.ctrlKey !== usesCtrl) return false;
    } else {
      if (!event.metaKey && !event.ctrlKey) return false;
      if (usesCtrl && (!event.ctrlKey || !event.metaKey)) return false;
      if (usesMeta && (!event.metaKey || !event.ctrlKey)) return false;
    }
  } else {
    if (!!event.metaKey !== usesMeta) return false;
    if (!!event.ctrlKey !== usesCtrl) return false;
  }

  if (!!event.altKey !== modifiers.has("Alt")) return false;
  if (!!event.shiftKey !== modifiers.has("Shift")) return false;
  return matchesShortcutKey(event, key, platform);
}

function actionShortcut(actionId: ShortcutActionId, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): string {
  return normalizeShortcutSettings(shortcuts, platform)[actionId];
}

const SWITCH_TO_TAB_ACTIONS: ShortcutActionId[] = ["switchToTab1", "switchToTab2", "switchToTab3", "switchToTab4", "switchToTab5", "switchToTab6", "switchToTab7", "switchToTab8", "switchToTab9"];

export function isExecuteSqlShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("executeSql", shortcuts));
}

export function isExecuteAllSqlShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("executeAllSql", shortcuts));
}

export function isExecuteSqlInNewResultTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("executeSqlInNewResultTab", shortcuts));
}

export function isExplainSqlShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("explainSql", shortcuts));
}

export function isCloseTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("closeTab", shortcuts));
}

export function isReopenClosedTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("reopenClosedTab", shortcuts));
}

export function isCloseOtherTabsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("closeOtherTabs", shortcuts), platform);
}

export function isCloseAllTabsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("closeAllTabs", shortcuts), platform);
}

export function isSaveAllTabsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("saveAllTabs", shortcuts), platform);
}

export function isCloseWindowShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("closeWindow", shortcuts));
}

export function isSendSelectionToAiShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("sendSelectionToAi", shortcuts));
}

export function isToggleAiPanelShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("toggleAiPanel", shortcuts, platform), platform);
}

export function isConvertNamingStyleShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("convertNamingStyle", shortcuts, platform), platform);
}

export function isNewQueryShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("newQuery", shortcuts));
}

/** Whether a global shortcut originated from the sidebar navigation surface. */
export function isSidebarFocusedTarget(target: EventTarget | null, lastFocusedSidebarSurface = false): boolean {
  if (typeof Element !== "undefined" && target instanceof Element && target.closest("[data-app-sidebar]")) return true;
  if (!lastFocusedSidebarSurface || typeof document === "undefined") return false;
  return !target || target === document.body || target === document.documentElement;
}

/** Whether the default-query shortcut is being invoked from navigation/search UI. */
export function isDefaultQueryShortcutTarget(target: EventTarget | null, lastFocusedSidebarSurface = false): boolean {
  if (isSidebarFocusedTarget(target, lastFocusedSidebarSurface)) return true;
  return typeof Element !== "undefined" && target instanceof Element && !!target.closest("[data-object-search-input]");
}

export function isOpenSettingsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("openSettings", shortcuts));
}

export function isFocusSearchShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("focusSearch", shortcuts));
}

export function isRefreshDataShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("refreshData", shortcuts));
}

export function isToggleResultsPaneShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("toggleResultsPane", shortcuts));
}

export function isModRShortcut(event: ShortcutLikeEvent): boolean {
  return matchesShortcut(event, "Mod+R");
}

export function isZoomInShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  if (matchesShortcut(event, actionShortcut("zoomInUi", shortcuts))) return true;
  if (event.isComposing || event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return normalizeKey(event.key) === "NumpadAdd" && !event.shiftKey;
}

export function isZoomOutShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  if (matchesShortcut(event, actionShortcut("zoomOutUi", shortcuts))) return true;
  if (event.isComposing || event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return normalizeKey(event.key) === "NumpadSubtract" && !event.shiftKey;
}

export function isResetZoomShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  if (matchesShortcut(event, actionShortcut("resetUiZoom", shortcuts))) return true;
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return normalizeKey(event.key) === "Numpad0";
}

export function isToggleTransposeShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("toggleTranspose", shortcuts));
}

export function isSaveShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("saveSql", shortcuts));
}

export function isAcceptCompletionShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("acceptCompletion", shortcuts));
}

export function isObjectSourceSaveShortcutTarget(target: { closest(selector: string): unknown } | null | undefined): boolean {
  return !!target?.closest("[data-object-source-editor], [data-object-source-preview]");
}

/**
 * Which surface the "save" shortcut should act on.
 *
 * The settings page, plugin center and driver store replace the content area but
 * keep the previously active query tab activated, so `activeTab.mode === "query"`
 * stays true while one of those surfaces is on screen. Without this decision the
 * save shortcut popped the "SQL saved" dialog on top of the settings page instead
 * of applying the edited draft (#13020).
 */
export type SaveShortcutSurface = "settings" | "query" | "none";

export interface SaveShortcutSurfaceInput {
  settingsPageOpen?: boolean;
  pluginCenterOpen?: boolean;
  driverStoreOpen?: boolean;
  activeTabMode?: string | null;
  saveSqlDialogOpen?: boolean;
}

export function saveShortcutSurface(input: SaveShortcutSurfaceInput): SaveShortcutSurface {
  if (input.settingsPageOpen) return "settings";
  // Browsing surfaces have nothing to save, and must not fall through to the
  // query branch just because a query tab is still the active tab.
  if (input.pluginCenterOpen || input.driverStoreOpen) return "none";
  if (input.activeTabMode !== "query" || input.saveSqlDialogOpen) return "none";
  return "query";
}

export function isCopyCurrentRowShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("copyCurrentRow", shortcuts));
}

export function isEditCellShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("editCell", shortcuts, platform), platform);
}

export function isEditTableStructureShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("editTableStructure", shortcuts, platform), platform);
}

export function isDeleteCurrentRowShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("deleteCurrentRow", shortcuts));
}

export function isFocusWhereShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("focusWhere", shortcuts, platform), platform);
}

export function isGoToColumnShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("goToColumn", shortcuts, platform), platform);
}

export function isGoToFirstPageShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("goToFirstPage", shortcuts));
}

export function isGoToPreviousPageShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("goToPreviousPage", shortcuts));
}

export function isGoToNextPageShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("goToNextPage", shortcuts));
}

export function isGoToLastPageShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("goToLastPage", shortcuts));
}

export function isCancelSearchShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("cancelSearch", shortcuts));
}

export function isToggleSidebarShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("toggleSidebar", shortcuts));
}

export function isToggleZenModeShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("toggleZenMode", shortcuts));
}

export function isDisconnectAllActiveConnectionsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("disconnectAllActiveConnections", shortcuts));
}

export function isCopySidebarSelectionShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("copySidebarSelection", shortcuts));
}

export function isPasteSidebarSelectionShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("pasteSidebarSelection", shortcuts));
}

export function isEditSidebarConnectionShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("editSidebarConnection", shortcuts));
}

export function isDisconnectSidebarConnectionShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("disconnectSidebarConnection", shortcuts));
}

export function isViewTableDdlShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("viewTableDdl", shortcuts));
}

export function isEditSidebarTableStructureShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("editSidebarTableStructure", shortcuts, platform), platform);
}

export function isQuickOpenShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("quickOpen", shortcuts));
}

export function isGlobalSearchShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("globalSearch", shortcuts));
}

export function isOpenConnectionPickerShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("openConnectionPicker", shortcuts));
}

export function isOpenDatabasePickerShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("openDatabasePicker", shortcuts));
}

export function isOpenSchemaPickerShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("openSchemaPicker", shortcuts));
}

export function isNavigateTabHistoryBackShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("navigateTabHistoryBack", shortcuts, platform), platform);
}

export function isNavigateTabHistoryForwardShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("navigateTabHistoryForward", shortcuts, platform), platform);
}

export function handleTabHistoryNavigationShortcut(event: ShortcutLikeEvent, shortcuts: Partial<ShortcutSettings> | undefined, navigate: (direction: -1 | 1) => boolean, platform = globalThis.navigator?.platform || ""): boolean {
  if (isNavigateTabHistoryBackShortcut(event, shortcuts, platform)) return navigate(-1);
  if (isNavigateTabHistoryForwardShortcut(event, shortcuts, platform)) return navigate(1);
  return false;
}

export function isSwitchToPreviousTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("switchToPreviousTab", shortcuts));
}

export function isSwitchToNextTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("switchToNextTab", shortcuts));
}

/**
 * JetBrains-style tab switcher: exact match advances forward; adding Shift to
 * the configured combo (Ctrl+Shift+Tab by default) moves backward. Returns
 * null when the event is not the switcher shortcut.
 */
export function tabSwitcherDirectionFromShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): -1 | 1 | null {
  const shortcut = actionShortcut("tabSwitcher", shortcuts, platform);
  if (matchesShortcut(event, shortcut, platform)) return 1;
  if (event.shiftKey && matchesShortcut({ ...event, shiftKey: false }, shortcut, platform)) return -1;
  return null;
}

export function switchToTabIndexFromShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): number | null {
  const normalized = normalizeShortcutSettings(shortcuts);
  const index = SWITCH_TO_TAB_ACTIONS.findIndex((actionId) => matchesShortcut(event, normalized[actionId]));
  return index >= 0 ? index : null;
}

export function isBrowserReloadShortcut(event: ShortcutLikeEvent): boolean {
  if (event.isComposing || event.altKey) return false;
  const key = normalizeKey(event.key);
  if (key === "F5") return true;
  return key === "r" && (!!event.metaKey || !!event.ctrlKey);
}

export function isBrowserTaskManagerShortcut(event: ShortcutLikeEvent): boolean {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!event.shiftKey) return false;
  return event.key === "Escape" || event.key === "Esc" || event.code === "Escape";
}

export function isCaretBrowsingShortcut(event: ShortcutLikeEvent): boolean {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return event.key === "F7" || event.code === "F7";
}

export function isConfiguredShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  if (!shortcuts) return false;
  const normalized = normalizeShortcutSettings(shortcuts, platform);
  return Object.values(normalized).some((shortcut) => matchesShortcut(event, shortcut, platform));
}

export interface CaretBrowsingBlockOptions {
  caretBrowsingEnabled?: boolean;
  shortcuts?: Partial<ShortcutSettings>;
}

export function shouldBlockCaretBrowsing(event: ShortcutLikeEvent, options?: CaretBrowsingBlockOptions, platform = globalThis.navigator?.platform || ""): boolean {
  if (options?.caretBrowsingEnabled) return false;
  if (!isCaretBrowsingShortcut(event)) return false;
  if (options?.shortcuts && isConfiguredShortcut(event, options.shortcuts, platform)) return false;
  return true;
}
