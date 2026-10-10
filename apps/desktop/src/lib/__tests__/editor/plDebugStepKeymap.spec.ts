// @vitest-environment happy-dom

import { defaultKeymap } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type KeyBinding } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createPlDebugStepKeyBindings } from "@/lib/editor/plDebugStepShortcut";
import { DEFAULT_SHORTCUT_SETTINGS } from "@/lib/editor/shortcutRegistry";

/**
 * 调试源码编辑器内的单步键位（App.vue 之外的第二个装配点）。
 *
 * 这里要钉死的是**与 CodeMirror 内置键位的共存**：`PlDebugSourceEditor.vue` 用
 * `basicSetup` 建视图，其中 `@codemirror/commands` 的 `defaultKeymap` 有
 * `{ key: "Mod-i", run: selectParentSyntax, preventDefault: true }`。所以
 *  - 可单步时要**赢过**它（Step into 生效，`selectParentSyntax` 不执行）；
 *  - 不可单步时要**原样让回**它（返回 false、不改写 preventDefault ⇒ 行为与加本
 *    功能之前逐位一致）。
 * 第二条是「不许静默吃掉默认键位」的护栏，因此断言必须落到「默认命令仍然执行」。
 */

// CodeMirror 在模块加载时按宿主的 navigator.platform 解析 `Mod`，合成事件影响不到它；
// 把 `Mod` 显式写成 Meta/Ctrl 并配上同形态的事件，才能在任何宿主上都是确定行为
// （与 codemirrorDefaultKeymap.spec.ts / QueryEditorSearchKeymap.spec.ts 同一套路）。
const platforms = [
  { name: "macOS", modifier: "Meta", event: { metaKey: true } },
  { name: "Windows", modifier: "Ctrl", event: { ctrlKey: true } },
  { name: "Linux", modifier: "Ctrl", event: { ctrlKey: true } },
] as const;

function rewriteMod(bindings: readonly KeyBinding[], modifier: "Meta" | "Ctrl"): KeyBinding[] {
  return bindings.map((binding) => ({ ...binding, key: binding.key?.replace("Mod", modifier) }));
}

/** 真实的 `defaultKeymap` 里那条 Mod-i（run 换成 spy，其余字段原样保留，含 preventDefault）。 */
function builtInModI(modifier: "Meta" | "Ctrl") {
  const binding = defaultKeymap.find((item) => item.key === "Mod-i");
  if (!binding?.run) throw new Error("defaultKeymap no longer binds Mod-i; the conflict this test guards has changed");
  const run = vi.fn(binding.run);
  return { bindings: [{ ...binding, key: `${modifier}-i`, run }] as KeyBinding[], run, binding };
}

interface Harness {
  view: EditorView;
  /** 单步命令的落地 spy。 */
  step: ReturnType<typeof vi.fn>;
  /** 内置 `selectParentSyntax` 是否被执行（即默认键位还在不在）。 */
  builtInParentSyntax: ReturnType<typeof vi.fn>;
  pressModI: (event: KeyboardEventInit) => boolean;
}

function mountHarness(options: { canStep: () => boolean; modifier: "Meta" | "Ctrl"; event: KeyboardEventInit }): Harness {
  const step = vi.fn();
  const builtIn = builtInModI(options.modifier);
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc: "select (a + b) as total from dual",
      selection: { anchor: 10 },
      extensions: [Prec.highest(keymap.of(rewriteMod(createPlDebugStepKeyBindings({ shortcuts: DEFAULT_SHORTCUT_SETTINGS, canStep: options.canStep, run: step, platform: "Win32" }), options.modifier))), keymap.of(builtIn.bindings)],
    }),
  });
  return {
    view,
    step,
    builtInParentSyntax: builtIn.run,
    pressModI: (event) => runScopeHandlers(view, new KeyboardEvent("keydown", { key: "i", ...event }), "editor"),
  };
}

describe("debug source editor step bindings", () => {
  it("binds the three ODC step keys and declares no preventDefault of its own", () => {
    const bindings = createPlDebugStepKeyBindings({ shortcuts: DEFAULT_SHORTCUT_SETTINGS, canStep: () => true, run: () => undefined, platform: "Win32" });

    expect(bindings.map((binding) => binding.key)).toEqual(["Mod-i", "Mod-o", "Mod-p"]);
    // 让出键位时不得改写 basicSetup 的消费语义：preventDefault 必须完全交给 defaultKeymap。
    for (const binding of bindings) expect(binding.preventDefault).toBeUndefined();
  });

  it("honours a rebind and skips actions the user unbound", () => {
    const bindings = createPlDebugStepKeyBindings({ shortcuts: { stepOver: "Ctrl+Alt+O", stepInto: "" }, canStep: () => true, run: () => undefined, platform: "Win32" });

    // 未绑定的 stepInto 直接消失；顺序仍是 stepOut → stepOver。
    expect(bindings.map((binding) => binding.key)).toEqual(["Mod-o", "Ctrl-Alt-o"]);
  });

  it("returns false from run instead of claiming a key it cannot use", () => {
    const run = vi.fn();
    const bindings = createPlDebugStepKeyBindings({ shortcuts: DEFAULT_SHORTCUT_SETTINGS, canStep: () => false, run, platform: "Win32" });

    for (const binding of bindings) expect(binding.run?.({} as never)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  for (const { name, modifier, event } of platforms) {
    it(`${name}: Step into wins Mod-i while the session can step, and selectParentSyntax does not run`, () => {
      const harness = mountHarness({ canStep: () => true, modifier, event });

      expect(harness.pressModI(event)).toBe(true);
      expect(harness.step).toHaveBeenCalledExactlyOnceWith("stepInto");
      expect(harness.builtInParentSyntax).not.toHaveBeenCalled();
      harness.view.destroy();
    });

    it(`${name}: the built-in Mod-i command still runs when the debugger cannot step`, () => {
      const harness = mountHarness({ canStep: () => false, modifier, event });

      // CodeMirror 的 keymap 对同一个键是「先跑高优先级的 run，返回 false 就继续跑下一个」，
      // 所以这条同时证明了「我们没处理」与「默认命令确实执行了」两件事。
      expect(harness.pressModI(event)).toBe(true);
      expect(harness.step).not.toHaveBeenCalled();
      expect(harness.builtInParentSyntax).toHaveBeenCalledOnce();
      harness.view.destroy();
    });

    it(`${name}: an unbindable session leaves the editor keymap exactly as it was before this feature`, () => {
      // 对照组：完全不装调试键位时，Mod-i 也照样落到内置命令上 —— 说明上面的
      // 「让回」不是巧合，也让这条护栏不会因为哪天 spy 装配方式变化而失去意义。
      const builtIn = builtInModI(modifier);
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({ doc: "select 1", selection: { anchor: 3 }, extensions: [keymap.of(builtIn.bindings)] }),
      });

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "i", ...event }), "editor")).toBe(true);
      expect(builtIn.run).toHaveBeenCalledOnce();
      view.destroy();
    });
  }
});
