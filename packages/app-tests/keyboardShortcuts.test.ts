import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  eventToShortcut,
  isBrowserReloadShortcut,
  isCancelSearchShortcut,
  isCloseOtherTabsShortcut,
  isCloseTabShortcut,
  isCopySidebarSelectionShortcut,
  isExecuteSqlShortcut,
  isEditSidebarConnectionShortcut,
  isFocusSearchShortcut,
  isModRShortcut,
  isNewQueryShortcut,
  isObjectSourceSaveShortcutTarget,
  isOpenSettingsShortcut,
  isPasteSidebarSelectionShortcut,
  isResetZoomShortcut,
  isRefreshDataShortcut,
  isSaveShortcut,
  isSwitchToNextTabShortcut,
  isSwitchToPreviousTabShortcut,
  isCopyCurrentRowShortcut,
  isDeleteCurrentRowShortcut,
  isToggleTransposeShortcut,
  isZoomInShortcut,
  isZoomOutShortcut,
  matchesShortcut,
  switchToTabIndexFromShortcut,
} from "../../apps/desktop/src/lib/editor/keyboardShortcuts.ts";
import { shortcutToCodeMirrorKey } from "../../apps/desktop/src/lib/editor/shortcutRegistry.ts";

test("matches Cmd+Enter for SQL execution", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", metaKey: true }), true);
});

test("matches custom shortcut settings for SQL execution", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", metaKey: true }, { executeSql: "Shift+Mod+Enter" } as any), false);
  assert.equal(
    isExecuteSqlShortcut(
      { key: "Enter", metaKey: true, shiftKey: true } as any,
      {
        executeSql: "Shift+Mod+Enter",
      } as any,
    ),
    true,
  );
});

test("records custom shortcuts from keydown events", () => {
  assert.equal(eventToShortcut({ key: "r", metaKey: true, shiftKey: true } as any), "Shift+Mod+R");
  assert.equal(eventToShortcut({ key: "F2" } as any), "F2");
  assert.equal(eventToShortcut({ key: "Control", ctrlKey: true } as any), null);
});

test("converts custom shortcuts to CodeMirror key names", () => {
  assert.equal(shortcutToCodeMirrorKey("Shift+Mod+R"), "Shift-Mod-r");
  assert.equal(shortcutToCodeMirrorKey("Mod+/"), "Mod-/");
});

test("matches Ctrl+Enter for SQL execution", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", ctrlKey: true }), true);
});

test("matches Cmd+T for opening a new query", () => {
  assert.equal(isNewQueryShortcut({ key: "t", metaKey: true }), true);
});

test("matches Shift+Mod+brackets for switching adjacent tabs", () => {
  assert.equal(isSwitchToPreviousTabShortcut({ key: "[", metaKey: true, shiftKey: true }), true);
  assert.equal(isSwitchToPreviousTabShortcut({ key: "[", ctrlKey: true, shiftKey: true }), true);
  assert.equal(isSwitchToNextTabShortcut({ key: "]", metaKey: true, shiftKey: true }), true);
  assert.equal(isSwitchToNextTabShortcut({ key: "]", ctrlKey: true, shiftKey: true }), true);
  assert.equal(isSwitchToPreviousTabShortcut({ key: "[", metaKey: true }), false);
  assert.equal(isSwitchToNextTabShortcut({ key: "]", metaKey: true }), false);
});

test("matches Mod+number for switching to numbered tabs", () => {
  assert.equal(switchToTabIndexFromShortcut({ key: "1", metaKey: true }), 0);
  assert.equal(switchToTabIndexFromShortcut({ key: "5", ctrlKey: true }), 4);
  assert.equal(switchToTabIndexFromShortcut({ key: "9", metaKey: true }), 8);
  assert.equal(switchToTabIndexFromShortcut({ key: "0", metaKey: true }), null);
  assert.equal(switchToTabIndexFromShortcut({ key: "1", metaKey: true, altKey: true }), null);
});

test("matches custom shortcut settings for tab switching", () => {
  const shortcuts = {
    switchToPreviousTab: "Alt+ArrowLeft",
    switchToNextTab: "Alt+ArrowRight",
    switchToTab3: "Shift+Mod+3",
  } as any;

  assert.equal(isSwitchToPreviousTabShortcut({ key: "[", metaKey: true }, shortcuts), false);
  assert.equal(isSwitchToPreviousTabShortcut({ key: "ArrowLeft", altKey: true }, shortcuts), true);
  assert.equal(isSwitchToNextTabShortcut({ key: "ArrowRight", altKey: true }, shortcuts), true);
  assert.equal(switchToTabIndexFromShortcut({ key: "3", metaKey: true }, shortcuts), null);
  assert.equal(switchToTabIndexFromShortcut({ key: "3", metaKey: true, shiftKey: true }, shortcuts), 2);
});

test("matches custom shortcut settings for opening a new query", () => {
  assert.equal(isNewQueryShortcut({ key: "t", metaKey: true }, { newQuery: "Shift+Mod+N" } as any), false);
  assert.equal(isNewQueryShortcut({ key: "n", ctrlKey: true, shiftKey: true } as any, { newQuery: "Shift+Mod+N" } as any), true);
});

test("matches Mod+Comma for opening settings", () => {
  assert.equal(isOpenSettingsShortcut({ key: ",", metaKey: true }), true);
  assert.equal(isOpenSettingsShortcut({ key: ",", ctrlKey: true }), true);
  assert.equal(isOpenSettingsShortcut({ key: ",", altKey: true }), false);
});

test("matches custom shortcut settings for opening settings", () => {
  assert.equal(isOpenSettingsShortcut({ key: ",", metaKey: true }, { openSettings: "Shift+Mod+P" } as any), false);
  assert.equal(
    isOpenSettingsShortcut(
      { key: "p", ctrlKey: true, shiftKey: true } as any,
      {
        openSettings: "Shift+Mod+P",
      } as any,
    ),
    true,
  );
});

test("ignores Enter without modifier", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter" }), false);
});

test("ignores composing input events", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", metaKey: true, isComposing: true }), false);
});

test("matches Cmd+W for closing query tabs", () => {
  assert.equal(isCloseTabShortcut({ key: "w", metaKey: true }), true);
});

test("ignores Ctrl+W for closing query tabs", () => {
  assert.equal(isCloseTabShortcut({ key: "w", ctrlKey: true }), false);
});

test("matches platform shortcuts for closing other tabs", () => {
  // macOS 默认 ⌥⌘W：Option 会把 event.key 变形（⌥W → "∑"），按 code 回退匹配。
  // 平台默认集合内的值会被 normalize 按本机平台还原（云同步自愈），因此
  // 默认组合的匹配行为用 matchesShortcut 直接断言，自定义组合走完整入口
  assert.equal(matchesShortcut({ key: "∑", code: "KeyW", altKey: true, metaKey: true }, "Alt+Mod+W", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "w", metaKey: true }, "Alt+Mod+W", "MacIntel"), false);
  // Windows/Linux 默认 Shift+Alt+W（不含 Ctrl+Alt 避开 AltGr；不含 Ctrl+Shift+W 避开浏览器关窗保留键）
  assert.equal(matchesShortcut({ key: "W", altKey: true, shiftKey: true }, "Shift+Alt+W", "Win32"), true);
  assert.equal(matchesShortcut({ key: "w", altKey: true }, "Shift+Alt+W", "Win32"), false);
  // 非拉丁布局（俄文 Ц 在物理 KeyW 上）：无 Ctrl 的 Alt 组合按 code 回退匹配，默认键不失效
  assert.equal(matchesShortcut({ key: "Ц", code: "KeyW", altKey: true, shiftKey: true }, "Shift+Alt+W", "Win32"), true);
  // 用户自定义组合（非平台默认集合）经完整入口匹配
  assert.equal(isCloseOtherTabsShortcut({ key: "o", ctrlKey: true, shiftKey: true }, { closeOtherTabs: "Shift+Mod+O" }, "Win32"), true);
});

test("altgr character input never triggers close other tabs on windows layouts", () => {
  // 波兰语等布局：AltGr+W（= Ctrl+Alt+W）产生字符 "ł"，event.key 不是 "w"。
  // 即使用户自定义了 Alt+Mod+W，code 回退在非 macOS 平台禁用，不得按物理
  // KeyW 强制匹配——否则用户输入文本会误触发关闭其他标签页
  assert.equal(matchesShortcut({ key: "ł", code: "KeyW", altKey: true, ctrlKey: true }, "Alt+Mod+W", "Win32"), false);
  assert.equal(matchesShortcut({ key: "ę", code: "KeyE", altKey: true, ctrlKey: true }, "Alt+Mod+E", "Linux x86_64"), false);
  // 显式按下字母本身（key 就是 "w"）仍正常匹配自定义组合
  assert.equal(matchesShortcut({ key: "w", altKey: true, ctrlKey: true }, "Alt+Mod+W", "Win32"), true);
  // 经完整入口：非平台默认集合的自定义组合在 AltGr 布局下同样不误触发
  assert.equal(isCloseOtherTabsShortcut({ key: "ę", code: "KeyE", altKey: true, ctrlKey: true }, { closeOtherTabs: "Alt+Mod+E" }, "Win32"), false);
});

test("matches Ctrl+F for focusing search", () => {
  assert.equal(isFocusSearchShortcut({ key: "f", ctrlKey: true }), true);
});

test("matches Cmd+F for focusing search", () => {
  assert.equal(isFocusSearchShortcut({ key: "F", metaKey: true }), true);
});

test("matches F5 for refreshing data", () => {
  assert.equal(isRefreshDataShortcut({ key: "F5" }), true);
});

test("matches configurable shortcut for toggling transpose view", () => {
  assert.equal(isToggleTransposeShortcut({ key: "Tab" }), true);
  assert.equal(isToggleTransposeShortcut({ key: "Tab" }, { toggleTranspose: "Alt+T" } as any), false);
  assert.equal(isToggleTransposeShortcut({ key: "t", altKey: true }, { toggleTranspose: "Alt+T" } as any), true);
});

test("matches custom shortcut settings for refreshing data", () => {
  assert.equal(isRefreshDataShortcut({ key: "F5" }, { refreshData: "Shift+Mod+R" } as any), false);
  assert.equal(isRefreshDataShortcut({ key: "r", metaKey: true, shiftKey: true } as any, { refreshData: "Shift+Mod+R" } as any), true);
});

test("detects browser reload shortcuts for desktop suppression", () => {
  assert.equal(isBrowserReloadShortcut({ key: "r", ctrlKey: true }), true);
  assert.equal(isBrowserReloadShortcut({ key: "R", metaKey: true, shiftKey: true }), true);
  assert.equal(isBrowserReloadShortcut({ key: "F5" }), true);
  assert.equal(isBrowserReloadShortcut({ key: "r", altKey: true, ctrlKey: true }), false);
  assert.equal(isBrowserReloadShortcut({ key: "r", ctrlKey: true, isComposing: true }), false);
});

test("matches Mod-R without shift or alt for scoped refresh and replace", () => {
  assert.equal(isModRShortcut({ key: "r", ctrlKey: true }), true);
  assert.equal(isModRShortcut({ key: "R", metaKey: true }), true);
  assert.equal(isModRShortcut({ key: "R", metaKey: true, shiftKey: true }), false);
  assert.equal(isModRShortcut({ key: "r", ctrlKey: true, altKey: true }), false);
});

test("matches desktop UI zoom shortcuts", () => {
  assert.equal(isZoomInShortcut({ key: "=", ctrlKey: true }), true);
  assert.equal(isZoomInShortcut({ key: "NumpadAdd", ctrlKey: true }), true);
  assert.equal(isZoomOutShortcut({ key: "-", ctrlKey: true }), true);
  assert.equal(isZoomOutShortcut({ key: "NumpadSubtract", metaKey: true }), true);
  assert.equal(isResetZoomShortcut({ key: "0", ctrlKey: true }), true);
  assert.equal(isResetZoomShortcut({ key: "Numpad0", metaKey: true }), true);
});

test("matches configurable desktop UI zoom shortcuts", () => {
  assert.equal(isZoomInShortcut({ key: "i", ctrlKey: true }, { zoomInUi: "Mod+I" } as any), true);
  assert.equal(isZoomOutShortcut({ key: "o", metaKey: true }, { zoomOutUi: "Mod+O" } as any), true);
  assert.equal(isResetZoomShortcut({ key: "9", ctrlKey: true }, { resetUiZoom: "Mod+9" } as any), true);
});

test("ignores desktop UI zoom shortcuts with the wrong modifiers", () => {
  assert.equal(isZoomInShortcut({ key: "=", ctrlKey: true, altKey: true }), false);
  assert.equal(isZoomOutShortcut({ key: "-", isComposing: true, ctrlKey: true }), false);
  assert.equal(isResetZoomShortcut({ key: "0", metaKey: true, shiftKey: true }), false);
});

test("ignores focus search shortcut while composing", () => {
  assert.equal(isFocusSearchShortcut({ key: "f", ctrlKey: true, isComposing: true }), false);
});

test("ignores Alt+F for focusing search", () => {
  assert.equal(isFocusSearchShortcut({ key: "f", altKey: true }), false);
});

test("matches Cmd+S for saving", () => {
  assert.equal(isSaveShortcut({ key: "s", metaKey: true }), true);
});

test("matches Mod+D for copying current row", () => {
  assert.equal(isCopyCurrentRowShortcut({ key: "d", metaKey: true }), true);
});

test("matches Delete for deleting current row", () => {
  assert.equal(isDeleteCurrentRowShortcut({ key: "Delete" }), true);
});

test("matches Ctrl+S for saving", () => {
  assert.equal(isSaveShortcut({ key: "S", ctrlKey: true }), true);
});

test("ignores save shortcut while composing", () => {
  assert.equal(isSaveShortcut({ key: "s", metaKey: true, isComposing: true }), false);
});

test("ignores Alt+S for saving", () => {
  assert.equal(isSaveShortcut({ key: "s", altKey: true }), false);
});

test("detects object source editor targets for contextual save", () => {
  const target = {
    closest: (selector: string) => (selector === "[data-object-source-editor], [data-object-source-preview]" ? {} : null),
  };

  assert.equal(isObjectSourceSaveShortcutTarget(target), true);
});

test("ignores regular editor targets for contextual object source save", () => {
  const target = {
    closest: () => null,
  };

  assert.equal(isObjectSourceSaveShortcutTarget(target), false);
});

test("matches Escape for cancelling search", () => {
  assert.equal(isCancelSearchShortcut({ key: "Escape" }), true);
});

test("ignores cancelling search while composing", () => {
  assert.equal(isCancelSearchShortcut({ key: "Escape", isComposing: true }), false);
});

test("matches configurable sidebar shortcuts", () => {
  assert.equal(isCopySidebarSelectionShortcut({ key: "c", metaKey: true }), true);
  assert.equal(isPasteSidebarSelectionShortcut({ key: "v", ctrlKey: true }), true);
  assert.equal(isEditSidebarConnectionShortcut({ key: "e", metaKey: true }), true);

  const shortcuts = {
    copySidebarSelection: "Alt+C",
    pasteSidebarSelection: "Alt+V",
    editSidebarConnection: "Shift+Mod+E",
  } as any;

  assert.equal(isCopySidebarSelectionShortcut({ key: "c", metaKey: true }, shortcuts), false);
  assert.equal(isCopySidebarSelectionShortcut({ key: "c", altKey: true }, shortcuts), true);
  assert.equal(isPasteSidebarSelectionShortcut({ key: "v", altKey: true }, shortcuts), true);
  assert.equal(isEditSidebarConnectionShortcut({ key: "e", metaKey: true }, shortcuts), false);
  assert.equal(isEditSidebarConnectionShortcut({ key: "e", ctrlKey: true, shiftKey: true }, shortcuts), true);
});
