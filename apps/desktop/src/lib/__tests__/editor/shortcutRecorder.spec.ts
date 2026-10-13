// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { isShortcutEditingKeydown, isShortcutEditingTarget, shortcutRecorderAction } from "@/lib/editor/shortcutRecorder";
import { formatShortcutDisplay, normalizeShortcutSearch } from "@/lib/editor/shortcutDisplay";

// #11787：录入态按键 → 搜索文本的翻译。断言分两层：
//   1. 单次按键被翻成哪个动作（录入 / 退出 / 清空 / 继续等待）；
//   2. 录出来的文本必须与「行上渲染的绑定胶囊」归一到同一个键——这是整个特性的
//      承重契约，写错一侧就只在 macOS 上表现为「录了却搜不到」。
describe("shortcut recorder key translation", () => {
  it("turns a pressed combination into the display string a bound row renders", () => {
    expect(shortcutRecorderAction({ key: "w", ctrlKey: true, shiftKey: true }, "Win32")).toEqual({ type: "record", query: "Ctrl + Shift + W" });
    expect(shortcutRecorderAction({ key: "/", ctrlKey: true }, "Win32")).toEqual({ type: "record", query: "Ctrl + /" });
    expect(shortcutRecorderAction({ key: "Enter", ctrlKey: true }, "Win32")).toEqual({ type: "record", query: "Ctrl + ↵" });
  });

  it("normalizes to the same key as the stored binding on every platform", () => {
    const cases = [
      ["Win32", { key: "w", ctrlKey: true, shiftKey: true }, "Shift+Mod+W"],
      ["MacIntel", { key: "w", metaKey: true, shiftKey: true }, "Shift+Mod+W"],
      ["MacIntel", { key: "Enter", metaKey: true }, "Mod+Enter"],
    ] as const;

    for (const [platform, pressed, stored] of cases) {
      const action = shortcutRecorderAction(pressed, platform);
      expect(action?.type).toBe("record");
      const query = action?.type === "record" ? action.query : "";
      expect(normalizeShortcutSearch(query)).toBe(normalizeShortcutSearch(formatShortcutDisplay(stored, platform)));
    }
  });

  it("keeps waiting while only a modifier is held", () => {
    expect(shortcutRecorderAction({ key: "Control", ctrlKey: true }, "Win32")).toBeNull();
    expect(shortcutRecorderAction({ key: "Shift", shiftKey: true }, "Win32")).toBeNull();
    expect(shortcutRecorderAction({ key: "Meta", metaKey: true }, "MacIntel")).toBeNull();
    expect(shortcutRecorderAction({ key: "Alt", altKey: true }, "Win32")).toBeNull();
  });

  it("keeps Esc and Backspace as recorder controls", () => {
    expect(shortcutRecorderAction({ key: "Escape" }, "Win32")).toEqual({ type: "exit" });
    // 修饰键状态不影响 Esc：录入态必须能无条件退出。
    expect(shortcutRecorderAction({ key: "Escape", ctrlKey: true }, "Win32")).toEqual({ type: "exit" });
    expect(shortcutRecorderAction({ key: "Backspace" }, "Win32")).toEqual({ type: "clear" });
  });

  it("still records keys that carry their own default binding", () => {
    // deleteCurrentRow 的默认键就是 Delete：它必须照常录入，否则该行动作在录入态下
    // 永远搜不到自己。写进搜索框的是显示串（Win32 下 Delete 渲染成 "Del"），与行上
    // 胶囊同源，因此归一化后仍然命中。
    expect(shortcutRecorderAction({ key: "Delete" }, "Win32")).toEqual({ type: "record", query: formatShortcutDisplay("Delete", "Win32") });
    expect(shortcutRecorderAction({ key: "F5" }, "Win32")).toEqual({ type: "record", query: "F5" });
    expect(shortcutRecorderAction({ key: "Tab" }, "Win32")).toEqual({ type: "record", query: "Tab" });
  });

  it("ignores keys pressed while an IME is composing", () => {
    expect(shortcutRecorderAction({ key: "w", ctrlKey: true, isComposing: true }, "Win32")).toBeNull();
  });
});

// App.vue 的三条 capture 阶段分支靠这个判定给「自己拥有键盘输入」的表面让路：
// 判定错了就会出现「录入 Ctrl+P 顺手弹出快速打开」「录入 Ctrl+F 被抢走焦点」这类
// 副作用。这里用真实 KeyboardEvent 打在真实元素上，断言生产函数的可观测结果。
describe("shortcut editing surfaces own the keyboard", () => {
  function keydownOn(element: Element, init: KeyboardEventInit = { key: "p", ctrlKey: true }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    element.dispatchEvent(event);
    return event;
  }

  it("recognizes the per-row, SQL and #11787 recorder surfaces", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const rowInput = document.createElement("input");
    rowInput.dataset.shortcutInput = "formatSql";
    const sqlInput = document.createElement("input");
    sqlInput.dataset.sqlShortcutInput = "dialog";
    const recorder = document.createElement("button");
    recorder.dataset.shortcutRecorder = "active";
    const recorderIcon = document.createElement("span");
    recorder.append(recorderIcon);
    const plainButton = document.createElement("button");
    host.append(rowInput, sqlInput, recorder, plainButton);

    expect(isShortcutEditingKeydown(keydownOn(rowInput))).toBe(true);
    expect(isShortcutEditingKeydown(keydownOn(sqlInput))).toBe(true);
    expect(isShortcutEditingKeydown(keydownOn(recorder))).toBe(true);
    // 焦点可能落在按钮内部的图标上：仍要算录入表面（closest 向上匹配）。
    expect(isShortcutEditingKeydown(keydownOn(recorderIcon))).toBe(true);

    expect(isShortcutEditingKeydown(keydownOn(plainButton))).toBe(false);
    expect(isShortcutEditingKeydown(keydownOn(document.body))).toBe(false);
    expect(isShortcutEditingTarget(null)).toBe(false);
  });

  it("falls back to the focused element when the event carries no element target", () => {
    // capture 阶段的处理器拿到的事件目标可能不是元素（如在 window 上派发）：
    // 这时按焦点元素判定，与 App.vue 里三条分支原先各自解析 target 的口径一致。
    const recorder = document.createElement("button");
    recorder.dataset.shortcutRecorder = "active";
    const plainButton = document.createElement("button");
    document.body.append(recorder, plainButton);

    const windowEvent = keydownOn(window);
    recorder.focus();
    expect(isShortcutEditingKeydown(windowEvent)).toBe(true);

    plainButton.focus();
    expect(isShortcutEditingKeydown(windowEvent)).toBe(false);
  });
});
