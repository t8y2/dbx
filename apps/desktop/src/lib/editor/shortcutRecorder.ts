import { formatShortcutDisplay } from "./shortcutDisplay";
import { eventToShortcut, type ShortcutLikeEvent } from "./keyboardShortcuts";

/**
 * 快捷键页签「键盘录入」的按键翻译（#11787，照 VS Code Keyboard Shortcuts 的
 * Record Keys）：把录入态下按下的一次按键翻译成对搜索框的动作。
 *
 * `null` 表示这次按键还不构成完整组合键——纯修饰键按下（Ctrl/Shift/Alt/⌘）是录入
 * 过程的必经中间态，必须继续等待；IME 组字期间（isComposing）已由 eventToShortcut
 * 内部屏蔽，同样落入 null。
 */
export type ShortcutRecorderAction = { type: "exit" } | { type: "clear" } | { type: "record"; query: string };

/**
 * 三个「自己拥有键盘输入」的表面：每行快捷键录入框、SQL 快捷键录入框、以及 #11787 的
 * 页签级录入按钮。全局 capture 阶段的快捷键处理器（App.vue 的快速打开 / 全局搜索 /
 * 修饰键双敲）必须在这些表面上让路——capture 早于目标元素的处理器执行，只能按
 * **焦点元素**判定，靠事件的 defaultPrevented 已经来不及。
 */
export const SHORTCUT_EDITING_TARGET_SELECTOR = "[data-shortcut-input], [data-sql-shortcut-input], [data-shortcut-recorder]";

export function isShortcutEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(SHORTCUT_EDITING_TARGET_SELECTOR);
}

/**
 * 按键事件是否发生在快捷键录入表面上。capture 阶段的全局快捷键处理器拿到的就是事件
 * 本身，焦点元素没在事件里时退回 `document.activeElement`——与它们原先各自解析 target
 * 的口径一致。
 */
export function isShortcutEditingKeydown(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return isShortcutEditingTarget(target);
}

export function shortcutRecorderAction(event: ShortcutLikeEvent, platform = globalThis.navigator?.platform || ""): ShortcutRecorderAction | null {
  // Esc / Backspace 在录入态是控制键，不参与录入（与 VS Code 一致）：否则「退出录入」
  // 「清空已录入」就没有键位可用。代价是**裸 Esc / Backspace 绑定无法被录入到**——
  // 带修饰键的组合（Mod+Esc 等）照常录入，裸键仍可用文本搜索找到（如 cancelSearch 的
  // 默认键 Escape）。判定刻意不看修饰键状态：Esc 必须无条件能退出录入态。
  if (event.key === "Escape") return { type: "exit" };
  if (event.key === "Backspace") return { type: "clear" };

  const shortcut = eventToShortcut(event, platform);
  if (!shortcut) return null;

  // 写进搜索框的是**显示串**（⌘ ⇧ W / Ctrl + Shift + W）而不是规范串
  // （Shift+Mod+W）：过滤管线比较的是每一行的显示串（见 EditorSettingsDialog 的
  // filteredShortcutDefinitions 与 shortcutDisplay 的归一化），写规范串在 macOS
  // 上永远匹配不到任何一行。
  return { type: "record", query: formatShortcutDisplay(shortcut, platform) };
}
