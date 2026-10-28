// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import { isQuickOpenShortcut, isToggleAiPanelShortcut, matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { dispatchPlDebugStepShortcut, resolvePlDebugStepShortcut, isPlDebugEditableTarget, type PlDebugStepCommand } from "@/lib/editor/plDebugStepShortcut";
import { DEFAULT_SHORTCUT_SETTINGS, findCrossScopeShortcutConflicts, findShortcutConflict, normalizeShortcutSettings, SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";

/**
 * D1：PL/SQL 调试器单步快捷键（Ctrl/Cmd+I 进入 / O 跳出 / P 跳过）。
 *
 * 本文件把两件容易在重构里悄悄失守的事钉死：
 *  1. **语义**：三个键来自 ODC 客户端源码而非猜测，映射到 store 的
 *     stepIn / stepOut / stepOver。
 *  2. **边界**：它们只在调试标签页被认领，且焦点不在对话框/可编辑元素里时才算数。
 *     调试页之外 `Mod+P` 必须仍是 quickOpen，`Mod+I` / `Mod+O` 必须什么都不触发。
 *
 * #9（加严焦点门控）把第 2 条从「对话框」扩到「对话框 + 输入框」：焦点在
 * INPUT/TEXTAREA/SELECT/contenteditable 里时同样返回 null，键位回到输入框；调试源码
 * 编辑器不受影响 —— 它的键由 CodeMirror 自己的绑定处理（见本文件末尾的装配契约）。
 */

const DEBUG_STEP_DEFAULTS: Array<[PlDebugStepCommand, string, string]> = [
  ["stepInto", "Mod+I", "plDebug.toolbar.stepIn"],
  ["stepOut", "Mod+O", "plDebug.toolbar.stepOut"],
  ["stepOver", "Mod+P", "plDebug.toolbar.stepOver"],
];

function isMac(platform: string): boolean {
  return platform.toLowerCase().includes("mac");
}

/** `Mod+<letter>` 的按键事件：macOS 是 ⌘，Windows/Linux 是 Ctrl。 */
function modKeyEvent(key: string, platform: string, extra: Partial<ShortcutLikeEvent> = {}): ShortcutLikeEvent {
  return isMac(platform) ? { key, metaKey: true, ...extra } : { key, ctrlKey: true, ...extra };
}

/** 所有会在这个平台上命中该事件的注册表动作，按注册顺序。 */
function actionOwners(event: ShortcutLikeEvent, platform: string): string[] {
  const shortcuts = normalizeShortcutSettings(undefined, platform);
  return SHORTCUT_DEFINITIONS.filter((definition) => matchesShortcut(event, shortcuts[definition.id], platform)).map((definition) => definition.id);
}

describe("shortcutRegistry debug scope", () => {
  it("registers the three ODC step actions in their own debug scope", () => {
    for (const [actionId, defaultShortcut, labelKey] of DEBUG_STEP_DEFAULTS) {
      expect(SHORTCUT_DEFINITIONS.find((item) => item.id === actionId)).toMatchObject({
        id: actionId,
        labelKey,
        scope: "debug",
        defaultShortcut,
      });
      expect(DEFAULT_SHORTCUT_SETTINGS[actionId]).toBe(defaultShortcut);
    }
  });

  it("keeps the three step keys free of same-scope duplicates", () => {
    for (const [actionId] of DEBUG_STEP_DEFAULTS) {
      expect(findShortcutConflict(actionId, DEFAULT_SHORTCUT_SETTINGS[actionId], DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    }
  });

  it("reports the Mod+P overlap with quickOpen as a cross-scope notice, never a blocking conflict", () => {
    // Step over 与 quickOpen 共用 Mod+P 是刻意的：由调试上下文分流。跨作用域只提示，
    // 不阻断（同作用域才会挡住 Apply）。
    expect(findCrossScopeShortcutConflicts(DEFAULT_SHORTCUT_SETTINGS).stepOver).toContain("quickOpen");
    expect(findCrossScopeShortcutConflicts(DEFAULT_SHORTCUT_SETTINGS).quickOpen).toContain("stepOver");
    expect(findShortcutConflict("stepOver", DEFAULT_SHORTCUT_SETTINGS.stepOver, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });
});

describe("resolvePlDebugStepShortcut", () => {
  it.each(["Win32", "MacIntel"])("maps Ctrl/Cmd+I, O, P to the ODC step commands on %s", (platform) => {
    const context = { isDebugTab: true, canStep: true, platform };

    expect(resolvePlDebugStepShortcut(modKeyEvent("i", platform), context)).toBe("stepInto");
    expect(resolvePlDebugStepShortcut(modKeyEvent("o", platform), context)).toBe("stepOut");
    expect(resolvePlDebugStepShortcut(modKeyEvent("p", platform), context)).toBe("stepOver");
  });

  it("claims nothing at all outside a debug tab", () => {
    // 这是本次唯一的行为边界：非调试态下三个键都必须原样下传。
    for (const platform of ["Win32", "MacIntel"]) {
      const context = { isDebugTab: false, canStep: true, platform };
      for (const key of ["i", "o", "p"]) {
        expect(resolvePlDebugStepShortcut(modKeyEvent(key, platform), context)).toBeNull();
      }
    }
  });

  it("yields the key while a dialog owns the focus", () => {
    // 对话框拥有其中的按键：调试标签页上浮着设置页（或任何对话框）时，Mod+I/O/P 必须
    // 回到它们原本的分支，而不能去单步。判定由 App.vue 提供 —— 它手上有事件目标，并沿用
    // 仓库既有的 `closest('[role="dialog"], [role="alertdialog"]')` 惯例。
    const context = { isDebugTab: true, canStep: true, platform: "Win32", insideDialog: true };
    for (const key of ["i", "o", "p"]) {
      expect(resolvePlDebugStepShortcut(modKeyEvent(key, "Win32"), context)).toBeNull();
    }
  });

  it("still claims the key when no dialog is open", () => {
    const context = { isDebugTab: true, canStep: true, platform: "Win32", insideDialog: false };
    expect(resolvePlDebugStepShortcut(modKeyEvent("i", "Win32"), context)).toBe("stepInto");
    expect(resolvePlDebugStepShortcut(modKeyEvent("p", "Win32"), context)).toBe("stepOver");
  });

  it("yields the key while the focus is in an editable element", () => {
    // 内联输入框（变量面板的筛选/改值、断点面板的条件/命中次数）拥有自己的按键：
    // 焦点在其中时三个键都让位，而不是去单步。
    const context = { isDebugTab: true, canStep: true, platform: "Win32", insideEditable: true };
    for (const key of ["i", "o", "p"]) {
      expect(resolvePlDebugStepShortcut(modKeyEvent(key, "Win32"), context)).toBeNull();
    }
    // 让位之后事件继续下传，原有的全局分支照旧：Mod+P 仍是 quickOpen（与调试页之外一致）。
    expect(matchesShortcut(modKeyEvent("p", "Win32"), DEFAULT_SHORTCUT_SETTINGS.quickOpen, "Win32")).toBe(true);
  });

  it("still claims the key when the target is not editable", () => {
    const context = { isDebugTab: true, canStep: true, platform: "Win32", insideEditable: false };
    expect(resolvePlDebugStepShortcut(modKeyEvent("i", "Win32"), context)).toBe("stepInto");
    expect(resolvePlDebugStepShortcut(modKeyEvent("p", "Win32"), context)).toBe("stepOver");
  });

  it("names the editable elements by tag or contenteditable, and nothing else", () => {
    // 判定本身：标签名大写/小写都认；contenteditable 宿主认（含焦点落在 contenteditable
    // 内部节点、由祖先链认出的情形）；按钮、普通容器、非元素目标一律不认。
    for (const tagName of ["INPUT", "input", "TEXTAREA", "SELECT"]) {
      expect(isPlDebugEditableTarget({ tagName })).toBe(true);
    }
    expect(isPlDebugEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isPlDebugEditableTarget({ tagName: "SPAN", closest: (selector: string) => (selector.includes("contenteditable") ? {} : null) })).toBe(true);
    expect(isPlDebugEditableTarget({ tagName: "DIV", isContentEditable: false, closest: () => null })).toBe(false);
    expect(isPlDebugEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isPlDebugEditableTarget(null)).toBe(false);
    expect(isPlDebugEditableTarget(undefined)).toBe(false);
    expect(isPlDebugEditableTarget("body")).toBe(false);
  });

  it("dispatches actual DOM key events and yields dialogs, editable targets and inactive contexts", () => {
    const run = vi.fn();
    const quickOpen = vi.fn();
    const context = { isDebugTab: true, canStep: true, platform: "Win32", run };
    const listener = (event: KeyboardEvent) => {
      if (dispatchPlDebugStepShortcut(event, context)) return;
      if (isQuickOpenShortcut(event, DEFAULT_SHORTCUT_SETTINGS)) quickOpen();
    };
    const root = document.createElement("div");
    root.innerHTML = '<button>Step target</button><input /><textarea></textarea><select></select><div contenteditable="true"><span>Editable child</span></div><div role="dialog"><button>Dialog action</button></div>';
    document.body.append(root);
    window.addEventListener("keydown", listener);
    const press = (target: Element, key = "p") => {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    try {
      for (const key of ["i", "o", "p"]) expect(press(root.querySelector("button")!, key).defaultPrevented).toBe(true);
      expect(run.mock.calls.map(([command]) => command)).toEqual(["stepInto", "stepOut", "stepOver"]);
      expect(quickOpen).not.toHaveBeenCalled();
      for (const target of root.querySelectorAll('input, textarea, select, span, [role="dialog"] button')) expect(press(target).defaultPrevented).toBe(false);
      expect(run).toHaveBeenCalledTimes(3);
      expect(quickOpen).toHaveBeenCalledTimes(5);
      context.isDebugTab = false;
      press(root.querySelector("button")!);
      context.isDebugTab = true;
      context.canStep = false;
      press(root.querySelector("button")!);
      expect(run).toHaveBeenCalledTimes(3);
      expect(quickOpen).toHaveBeenCalledTimes(7);
    } finally {
      window.removeEventListener("keydown", listener);
      root.remove();
    }
  });

  it("claims nothing while the session cannot accept a step", () => {
    // 与工具栏按钮的 disabled 条件同源：没有停住的会话（或一次续跑在途中）时不抢键。
    for (const platform of ["Win32", "MacIntel"]) {
      expect(resolvePlDebugStepShortcut(modKeyEvent("p", platform), { isDebugTab: true, canStep: false, platform })).toBeNull();
    }
  });

  it("ignores IME composition, unmodified keys and extra chords", () => {
    const context = { isDebugTab: true, canStep: true, platform: "Win32" };

    expect(resolvePlDebugStepShortcut({ key: "i", ctrlKey: true, isComposing: true }, context)).toBeNull();
    expect(resolvePlDebugStepShortcut({ key: "i" }, context)).toBeNull();
    expect(resolvePlDebugStepShortcut({ key: "p", ctrlKey: true, shiftKey: true }, context)).toBeNull();
    expect(resolvePlDebugStepShortcut({ key: "p", ctrlKey: true, altKey: true }, context)).toBeNull();
  });

  it("keeps plain Mod+I distinct from the AI panel chords that share the letter", () => {
    // ⌃⌘I（macOS）/ Ctrl+Alt+I（Windows）是 toggleAiPanel，绝不能被并成 Step into。
    const macAiPanel = { key: "i", metaKey: true, ctrlKey: true };
    const windowsAiPanel = { key: "i", ctrlKey: true, altKey: true };
    const stepContext = { isDebugTab: true, canStep: true };
    const defaults = DEFAULT_SHORTCUT_SETTINGS;

    expect(isToggleAiPanelShortcut(macAiPanel, defaults, "MacIntel")).toBe(true);
    expect(isToggleAiPanelShortcut(windowsAiPanel, defaults, "Win32")).toBe(true);
    expect(resolvePlDebugStepShortcut(macAiPanel, { ...stepContext, platform: "MacIntel" })).toBeNull();
    expect(resolvePlDebugStepShortcut(windowsAiPanel, { ...stepContext, platform: "Win32" })).toBeNull();
  });

  it("honours a user rebind and stops claiming the default it replaced", () => {
    const shortcuts = { stepOver: "Ctrl+Alt+O" };
    const context = { isDebugTab: true, canStep: true, shortcuts, platform: "Win32" };

    expect(resolvePlDebugStepShortcut({ key: "o", ctrlKey: true, altKey: true }, context)).toBe("stepOver");
    expect(resolvePlDebugStepShortcut(modKeyEvent("p", "Win32"), context)).toBeNull();
  });
});

describe("outside the debugger the three keys keep their existing meaning", () => {
  it("binds Ctrl/Cmd+I and Ctrl/Cmd+O to nothing but the debugger", () => {
    // 非调试态下这两个键必须“什么都不触发”，所以要证明注册表里没有别的动作认领它们。
    for (const platform of ["Win32", "MacIntel"]) {
      expect(actionOwners(modKeyEvent("i", platform), platform)).toEqual(["stepInto"]);
      expect(actionOwners(modKeyEvent("o", platform), platform)).toEqual(["stepOut"]);
    }
  });

  it("keeps Mod+P owned by quickOpen as well, so the fall-through still opens it", () => {
    for (const platform of ["Win32", "MacIntel"]) {
      const event = modKeyEvent("p", platform);
      // 跨作用域共享 Mod+P：调试作用域的 stepOver + global 作用域的 quickOpen。
      expect(actionOwners(event, platform).sort()).toEqual(["quickOpen", "stepOver"]);
      expect(matchesShortcut(event, DEFAULT_SHORTCUT_SETTINGS.quickOpen, platform)).toBe(true);
    }
    // 非 mac 的宿主环境下 isQuickOpenShortcut（无 platform 参数）也必须认下 Ctrl+P。
    expect(isQuickOpenShortcut({ key: "p", ctrlKey: true }, DEFAULT_SHORTCUT_SETTINGS)).toBe(true);
  });

  it("routes Mod+P to stepOver inside a debug tab and to quickOpen everywhere else", () => {
    // App.vue 的分支顺序镜像：先问调试上下文，未命中才轮到 quickOpen。
    // 这里只验证快捷键解析与既有quickOpen的作用域，不作为App装配证据。
    const platform = "Win32";
    const event = modKeyEvent("p", platform);
    const route = (isDebugTab: boolean) => {
      const step = resolvePlDebugStepShortcut(event, { isDebugTab, canStep: true, platform });
      if (step) return step;
      return matchesShortcut(event, DEFAULT_SHORTCUT_SETTINGS.quickOpen, platform) ? "quickOpen" : null;
    };

    expect(route(true)).toBe("stepOver");
    expect(route(false)).toBe("quickOpen");
  });
});

describe("debug scope translations", () => {
  it("resolves the real scope and action labels using the established locale fallback", async () => {
    const modules = import.meta.glob("../../../i18n/locales/*.ts");
    for (const locale of ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "pl", "ru", "th", "tr", "zh-CN", "zh-TW"]) {
      const loaded = (await modules[`../../../i18n/locales/${locale}.ts`]()) as { default: { plDebug?: typeof en.plDebug } };
      const translator = createI18n({ legacy: false, locale, fallbackLocale: "en", fallbackWarn: false, missingWarn: false, messages: { en: { plDebug: en.plDebug }, [locale]: { plDebug: loaded.default.plDebug ?? {} } } });
      for (const key of ["plDebug.start.title", "plDebug.shortcutsHint", ...DEBUG_STEP_DEFAULTS.map(([, , label]) => label)]) expect(translator.global.t(key), `${locale}:${key}`).not.toBe(key);
    }
  });
});
