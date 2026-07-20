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

function matchesShortcutKey(event: ShortcutLikeEvent, key: string, platform = globalThis.navigator?.platform || ""): boolean {
  if (normalizeKey(event.key) === normalizeKey(key)) return true;
  // KeyboardEvent.code 回退：event.key 随布局/修饰键变形时按物理键位匹配
  // （macOS Option+字母 → 变形字符如 ⌥W="∑"；俄文等非拉丁布局 → "Ц"）。
  // 仅限 Alt 组合键场景
  if (!event.altKey || !/^Key[A-Z]$/.test(event.code ?? "") || !/^[A-Z]$/i.test(key)) return false;
  // 非 macOS 的 Ctrl+Alt 是 AltGr 特征：用户可能在输入字符（如波兰语
  // AltGr+W → "ł"），按 code 强制匹配会让全局快捷键在打字时误触发
  if (!isMacShortcutPlatform(platform) && event.ctrlKey) return false;
  return event.code!.slice(3).toLowerCase() === key.toLowerCase();
}

function shortcutKeyName(key: string): string | null {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  if (["Control", "Meta", "Shift", "Alt"].includes(key)) return null;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function eventToShortcut(event: ShortcutLikeEvent): string | null {
  if (event.isComposing) return null;

  const key = shortcutKeyName(event.key);
  if (!key) return null;

  const hasModifier = !!event.metaKey || !!event.ctrlKey || !!event.altKey || !!event.shiftKey;
  if (!hasModifier && event.key.length === 1 && event.key !== " ") return null;

  const parts: string[] = [];
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
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
  if (event.isComposing || !shortcut) return false;
  const parts = parseShortcutParts(shortcut);
  const key = parts[parts.length - 1] ?? "";
  const modifiers = new Set(parts.slice(0, -1));
  const usesMod = modifiers.has("Mod");
  const usesMeta = modifiers.has("Meta");
  const usesCtrl = modifiers.has("Ctrl");

  if (usesMod) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else {
    if (!!event.metaKey !== usesMeta) return false;
    if (!!event.ctrlKey !== usesCtrl) return false;
  }

  if (!!event.altKey !== modifiers.has("Alt")) return false;
  if (!!event.shiftKey !== modifiers.has("Shift")) return false;
  return matchesShortcutKey(event, key, platform);
}

function actionShortcut(actionId: ShortcutActionId, shortcuts?: Partial<ShortcutSettings>): string {
  return normalizeShortcutSettings(shortcuts)[actionId];
}

const SWITCH_TO_TAB_ACTIONS: ShortcutActionId[] = ["switchToTab1", "switchToTab2", "switchToTab3", "switchToTab4", "switchToTab5", "switchToTab6", "switchToTab7", "switchToTab8", "switchToTab9"];

export function isExecuteSqlShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("executeSql", shortcuts));
}

export function isCloseTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("closeTab", shortcuts));
}

export function isCloseOtherTabsShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>, platform = globalThis.navigator?.platform || ""): boolean {
  return matchesShortcut(event, actionShortcut("closeOtherTabs", shortcuts), platform);
}

export function isSendSelectionToAiShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("sendSelectionToAi", shortcuts));
}

export function isNewQueryShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("newQuery", shortcuts));
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

export function isCopyCurrentRowShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("copyCurrentRow", shortcuts));
}

export function isDeleteCurrentRowShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("deleteCurrentRow", shortcuts));
}

export function isCancelSearchShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("cancelSearch", shortcuts));
}

export function isToggleSidebarShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("toggleSidebar", shortcuts));
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

export function isQuickOpenShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("quickOpen", shortcuts));
}

export function isSwitchToPreviousTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("switchToPreviousTab", shortcuts));
}

export function isSwitchToNextTabShortcut(event: ShortcutLikeEvent, shortcuts?: Partial<ShortcutSettings>): boolean {
  return matchesShortcut(event, actionShortcut("switchToNextTab", shortcuts));
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
