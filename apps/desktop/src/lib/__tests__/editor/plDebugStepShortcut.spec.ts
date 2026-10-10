import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isQuickOpenShortcut, isToggleAiPanelShortcut, matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { resolvePlDebugStepShortcut, type PlDebugStepCommand } from "@/lib/editor/plDebugStepShortcut";
import { DEFAULT_SHORTCUT_SETTINGS, findCrossScopeShortcutConflicts, findShortcutConflict, normalizeShortcutSettings, SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";

/**
 * D1：PL/SQL 调试器单步快捷键（Ctrl/Cmd+I 进入 / O 跳出 / P 跳过）。
 *
 * 本文件把两件容易在重构里悄悄失守的事钉死：
 *  1. **语义**：三个键来自 ODC 客户端源码而非猜测，映射到 store 的
 *     stepIn / stepOut / stepOver。
 *  2. **边界**：它们只在调试标签页被认领。调试页之外 `Mod+P` 必须仍是
 *     quickOpen，`Mod+I` / `Mod+O` 必须什么都不触发 —— 这是本次唯一的行为边界。
 */

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const debugEditorSource = readFileSync(new URL("../../../components/debug/PlDebugSourceEditor.vue", import.meta.url), "utf8");

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

  it("gates the window branch on the event target, as the neighbouring shortcuts do", () => {
    // 源码断言：App.vue 的调试分支必须真的把对话框判定传进来，否则上面两条语义在窗口级
    // 路径上没有生效（这是本次新增的门控，容易在重构里悄悄丢掉）。
    expect(appSource).toMatch(/insideDialog:\s*e\.target instanceof Element[^;]*closest\('\[role="dialog"\], \[role="alertdialog"\]'\)/);
    // 仍需排在 quickOpen 之前（D1 的既有边界）。
    expect(appSource.indexOf("resolvePlDebugStepShortcut(e, {")).toBeLessThan(appSource.indexOf("isQuickOpenShortcut(e, shortcuts)"));
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
      expect(actionOwners(event, platform)).toEqual(["quickOpen", "stepOver"]);
      expect(matchesShortcut(event, DEFAULT_SHORTCUT_SETTINGS.quickOpen, platform)).toBe(true);
    }
    // 非 mac 的宿主环境下 isQuickOpenShortcut（无 platform 参数）也必须认下 Ctrl+P。
    expect(isQuickOpenShortcut({ key: "p", ctrlKey: true }, DEFAULT_SHORTCUT_SETTINGS)).toBe(true);
  });

  it("routes Mod+P to stepOver inside a debug tab and to quickOpen everywhere else", () => {
    // App.vue 的分支顺序镜像：先问调试上下文，未命中才轮到 quickOpen。
    // 真实顺序由下面 “App.vue dispatch order” 的源码断言看住，防止这份镜像私自漂移。
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

describe("App.vue dispatch order", () => {
  it("resolves the debugger step keys before the quickOpen branch", () => {
    const debugBranch = appSource.indexOf("resolvePlDebugStepShortcut(e, {");
    const quickOpenBranch = appSource.indexOf("if (isQuickOpenShortcut(e, shortcuts))");

    expect(debugBranch).toBeGreaterThan(-1);
    expect(quickOpenBranch).toBeGreaterThan(debugBranch);
  });

  it("gates the debugger branch on the debug tab and a steppable session", () => {
    expect(appSource).toContain('isDebugTab: activeTab.value?.mode === "debug"');
    expect(appSource).toContain("canStep: plDebugStore.hasSession && !plDebugStore.busy");
  });

  it("keeps the window-level branch focus-agnostic so panels and the toolbar can step too", () => {
    // 编辑器内由 PlDebugSourceEditor 的 keymap 负责（见 plDebugStepKeymap.spec.ts）；
    // 这里是要保证窗口级分支**不**被限制在编辑器焦点上 —— 焦点在工具栏/变量面板/
    // 调用栈时同样生效，这正是它相对编辑器内绑定的不可替代之处。
    const branch = appSource.slice(appSource.indexOf("const plDebugStep = resolvePlDebugStepShortcut(e, {"), appSource.indexOf("if (isFocusWhereShortcut(e, shortcuts)"));
    // 焦点无关：绝不按"焦点是否在编辑器里"决定放行（面板与工具栏也要能单步）。唯一允许的
    // 目标判定是对话框门控（§1-2 新增的边界）：对话框里的按键属于对话框，不能拿去单步。
    expect(branch).not.toMatch(/e\.target[^;]*(cm-editor|data-query-editor-root)/);
    expect(branch).toContain(`e.target.closest('[role="dialog"], [role="alertdialog"]')`);
    expect(branch).not.toContain("data-query-editor-root");
  });
});

describe("debug source editor wiring", () => {
  it("installs the step bindings at the highest precedence, ahead of basicSetup", () => {
    // 组件侧的装配契约：优先级或顺序错一个，Mod-i 就会重新被 defaultKeymap 的
    // selectParentSyntax 抢走（CodeMirror 层面的共存证明见 plDebugStepKeymap.spec.ts）。
    expect(debugEditorSource).toContain("Prec.highest(");
    expect(debugEditorSource).toContain("createPlDebugStepKeyBindings({");
    expect(debugEditorSource).toContain("plDebugStepKeymapCompartment.of(plDebugStepKeymapContent())");
    expect(debugEditorSource).toContain("canStep: () => store.hasSession && !store.busy");
    expect(debugEditorSource.indexOf("plDebugStepKeymapExtension()")).toBeLessThan(debugEditorSource.indexOf("basicSetup,"));
    // 改键要立刻生效，不能等重新挂载编辑器。
    expect(debugEditorSource).toContain("plDebugStepKeymapCompartment.reconfigure(plDebugStepKeymapContent())");
  });
});

describe("debug scope translations", () => {
  const locales = ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "ru", "tr", "zh-CN", "zh-TW"];

  it("labels the debug scope group in every supported locale", () => {
    for (const locale of locales) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(source, locale).toMatch(/shortcutScopeDebug:\s*"..*"/);
      expect(source, locale).toMatch(/shortcutScopeHintDebug:\s*"..*"/);
    }
  });

  it("reuses the debugger toolbar labels that every locale carrying plDebug already has", () => {
    for (const locale of locales) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      // id.ts 尚无 plDebug 命名空间，由 fallbackLocale=en 兜底，与调试工具栏现状一致。
      if (!/^\s*plDebug:\s*\{/m.test(source)) continue;
      for (const key of ["stepIn", "stepOut", "stepOver"]) {
        expect(source, `${locale}.${key}`).toMatch(new RegExp(`${key}:\\s*"..*"`));
      }
    }
  });
});
