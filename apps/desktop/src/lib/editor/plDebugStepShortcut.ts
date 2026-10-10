import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey, type ShortcutActionId, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import type { KeyBinding } from "@codemirror/view";

/**
 * PL/SQL 调试器的单步快捷键判定。
 *
 * 绑定本身注册在 `shortcutRegistry` 的 `debug` 作用域里（`stepInto` / `stepOut` /
 * `stepOver`，默认 `Mod+I` / `Mod+O` / `Mod+P`），用户可在设置里改键。本模块只负责
 * **在什么上下文里、哪个键对应哪条命令**，把这段判断从 `App.vue`（5k+ 行、无法
 * 单测）里抽出来，让它成为可断言的不变式。
 *
 * 为什么需要上下文判定，而不是把三个键直接注册成全局快捷键：
 * `Mod+P` 早已是 global 作用域的 `quickOpen`（`App.vue` 的 quickOpen 分支在
 * window 级、不区分焦点）。ODC 的语义同样是**调试态下才认这三个键**
 * （`odc-client-ref/src/page/Workspace/components/PLPage/index.tsx:375-395`，
 * 三个 `run` 都被 `this.debugMode.get()` 守卫），因此 DBX 也必须按上下文让位：
 * 调试标签页之外这三个键的行为**逐位不变**。
 */
export type PlDebugStepCommand = "stepInto" | "stepOut" | "stepOver";

/** 命令 → 注册表动作 id。两者同名，但保持显式映射以免将来改名时静默失配。 */
export const PL_DEBUG_STEP_ACTION_IDS: Record<PlDebugStepCommand, ShortcutActionId> = {
  stepInto: "stepInto",
  stepOut: "stepOut",
  stepOver: "stepOver",
};

/**
 * 与 ODC `addAction` 的声明顺序一致：`KeyI` → 进入、`KeyO` → 跳出、`KeyP` → 跳过。
 * 顺序只影响同一事件命中多个绑定时的取舍（正常配置下不会发生，因为三者是
 * 同作用域的互斥键，`findShortcutConflict` 会阻断重复绑定）。
 */
const PL_DEBUG_STEP_COMMANDS: PlDebugStepCommand[] = ["stepInto", "stepOut", "stepOver"];

export interface PlDebugStepContext {
  /**
   * 前台标签页就是 PL/SQL 调试器（`activeTab.mode === "debug"`）。为 false 时
   * 本模块对**任何**按键都返回 null —— 这是「不全局劫持」的唯一开关。
   */
  isDebugTab: boolean;
  /**
   * 会话可接受单步：有存活的调试会话且没有一次续跑正在途中。对应工具栏按钮的
   * `disabled` 条件（`store.busy || store.terminated || !store.hasSession`）；
   * 键盘和按钮必须给出同一套可用性，否则排队第二次 `continue` 会让两侧状态分叉。
   */
  canStep: boolean;
  /**
   * 事件发生在已打开的对话框/警示框内部。为 true 时本模块让位 —— 否则调试标签页上浮着
   * 设置页时按 `Mod+P` 会去单步，而不是走它原本的分支。调用方按仓库既有惯例判定：
   * `target?.closest('[role="dialog"], [role="alertdialog"]')`。
   */
  insideDialog?: boolean;
  shortcuts?: Partial<ShortcutSettings>;
  platform?: string;
}

/**
 * 事件落在哪条调试单步命令上；不在调试上下文、或没有绑定命中时返回 null。
 *
 * 返回 null 是「交还给后面的分支」的信号：`App.vue` 在这个判定之后仍然会走
 * `isQuickOpenShortcut` 等既有分支，所以调试页之外的 `Mod+P` 照旧打开快速打开。
 */
export function resolvePlDebugStepShortcut(event: ShortcutLikeEvent, context: PlDebugStepContext): PlDebugStepCommand | null {
  if (!context.isDebugTab || !context.canStep) return null;
  // 对话框拥有其中的按键：调试标签页上浮着设置页（或任何对话框）时，Mod+I/O/P 必须回到
  // 它们原本的分支，而不能去单步。判定由调用方提供 —— 它手上有事件目标，并沿用仓库既有
  // 的 `closest('[role="dialog"], [role="alertdialog"]')` 惯例（`App.vue` 对
  // `openTableStructureEditor` 一类就是这么做目标门控的）。编辑器内的键位不经过这里，
  // 所以调试源码视图的绑定不受影响。
  if (context.insideDialog) return null;
  if (event.isComposing) return null;
  const platform = context.platform ?? globalThis.navigator?.platform ?? "";
  const shortcuts = normalizeShortcutSettings(context.shortcuts, platform);
  for (const command of PL_DEBUG_STEP_COMMANDS) {
    if (matchesShortcut(event, shortcuts[PL_DEBUG_STEP_ACTION_IDS[command]], platform)) return command;
  }
  return null;
}

export interface PlDebugStepKeyBindingsOptions {
  /** 当前快捷键配置；用户改键后重建绑定即可生效。 */
  shortcuts?: Partial<ShortcutSettings>;
  /**
   * 会话是否可接受单步。为 false 时绑定**返回 false**，把该键让回编辑器默认行为
   * （`Mod-i` 仍是 `selectParentSyntax`），也就是让本功能彻底不参与这次按键。
   */
  canStep: () => boolean;
  /** 真正执行单步；命令名与 store 动作同名。 */
  run: (command: PlDebugStepCommand) => void;
  platform?: string;
}

/**
 * 调试源码编辑器内的绑定（调用方用 `Prec.highest(keymap.of(...))` 装配）。
 *
 * 为什么编辑器内也要绑一次：`PlDebugSourceEditor.vue` 用 CodeMirror 的
 * `basicSetup` 建视图，而 `basicSetup` 含 `@codemirror/commands` 的 `defaultKeymap`，
 * 其中 `{ key: "Mod-i", run: selectParentSyntax, preventDefault: true }` **独占**了
 * Ctrl/Cmd+I。CodeMirror 的 keydown 挂在编辑器 contentDOM 上（冒泡先于 window），
 * 且 `buildKeymap` 对同键做 `if (preventDefault) binding.preventDefault = true` 的
 * **或合并**：无论 `selectParentSyntax` 返回 true（光标有父级语法节点，选中它）还是
 * false（没有父级节点，什么都不做），`runScopeHandlers` 都返回 true。于是
 * `App.vue` 开头的 `if (e.defaultPrevented) return;` 必然让位 —— **不绑到编辑器上，
 * Step into 在编辑器聚焦时永远不生效**，而编辑器正是调试页最主要的焦点面。
 * （plDebugStepKeymap.spec.ts 的对照组把这一事实钉住了：只装 defaultKeymap 时，
 * 连"没有语法树、selectParentSyntax 返回 false"的场景也已经是 handled。）
 *
 * ODC 的这三个 action 同样绑在**编辑器**上（`PLPage/index.tsx:375-395` 的 Monaco
 * `addAction`），本函数与之一致。
 *
 * 优先级必须高于 `basicSetup`：否则 `defaultKeymap` 先命中就轮不到单步。
 *
 * **不声明 `preventDefault`**：这个键在编辑器里本来就被 CodeMirror 消费；`canStep()`
 * 为假时返回 false 的语义是「整条链与加本功能之前逐位一致」，而不是「把事件放给
 * window」。`App.vue` 的窗口级分支负责的是编辑器**之外**的焦点（工具栏 / 变量面板 /
 * 调用栈），那才是它不可替代的场景。
 */
export function createPlDebugStepKeyBindings(options: PlDebugStepKeyBindingsOptions): KeyBinding[] {
  const platform = options.platform ?? globalThis.navigator?.platform ?? "";
  const shortcuts = normalizeShortcutSettings(options.shortcuts, platform);
  // CodeMirror 键 → 命令的反向索引；未绑定（空串）与重复键都由前者兜住。
  const commandByKey = new Map<string, PlDebugStepCommand>();
  for (const command of PL_DEBUG_STEP_COMMANDS) {
    const key = shortcutToCodeMirrorKey(shortcuts[PL_DEBUG_STEP_ACTION_IDS[command]]);
    if (key && !commandByKey.has(key)) commandByKey.set(key, command);
  }
  // 刻意不设 preventDefault：让出键位时不改写 basicSetup 的既有消费语义。
  return [...commandByKey].map(([key, command]) => ({
    key,
    run: () => {
      if (!options.canStep()) return false;
      options.run(command);
      return true;
    },
  }));
}
