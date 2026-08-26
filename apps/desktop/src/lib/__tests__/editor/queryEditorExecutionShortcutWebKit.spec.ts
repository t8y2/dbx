// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

const safariNavigator = {
  maxTouchPoints: 0,
  platform: "MacIntel",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  vendor: "Apple Computer, Inc.",
};

async function createSafariShortcutHarness() {
  vi.stubGlobal("navigator", safariNavigator);
  vi.resetModules();

  const [{ EditorState }, { EditorView, keymap }, { createQueryEditorExecutionShortcutBindings, createQueryEditorPostCompositionKeyGuard }] = await Promise.all([import("@codemirror/state"), import("@codemirror/view"), import("../../editor/queryEditorExecutionShortcut")]);
  const execute = vi.fn(() => true);
  const fallbackExecute = vi.fn();
  const root = document.createElement("div");
  root.dataset.queryEditorRoot = "";
  document.body.append(root);
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      extensions: [keymap.of(createQueryEditorExecutionShortcutBindings("Mod+Enter", execute, (currentView) => currentView.compositionStarted || currentView.composing))],
    }),
  });
  const postCompositionKeyGuard = createQueryEditorPostCompositionKeyGuard();
  const detachGuard = postCompositionKeyGuard.attach(view.contentDOM);
  let defaultPreventedBeforeFallback = false;
  root.addEventListener("keydown", (event) => {
    defaultPreventedBeforeFallback = event.defaultPrevented;
  });
  const handleAppFallback = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!event.metaKey || event.key !== "Enter" || !(event.target instanceof Element) || !event.target.closest("[data-query-editor-root]")) return;
    event.preventDefault();
    event.stopPropagation();
    if (!(view.compositionStarted || view.composing || postCompositionKeyGuard.blocks(event))) fallbackExecute();
  };
  window.addEventListener("keydown", handleAppFallback);

  return {
    defaultPreventedBeforeFallback: () => defaultPreventedBeforeFallback,
    destroy() {
      window.removeEventListener("keydown", handleAppFallback);
      detachGuard();
      view.destroy();
      root.remove();
    },
    execute,
    fallbackExecute,
    view,
  };
}

function dispatchComposition(target: HTMLElement, type: "compositionstart" | "compositionend") {
  target.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}

function dispatchExecuteShortcut(target: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

describe("QueryEditor Safari post-composition execution guard", () => {
  it("does not block immediate post-composition keys outside desktop Safari", async () => {
    const { createQueryEditorPostCompositionKeyGuard } = await import("../../editor/queryEditorExecutionShortcut");
    const guard = createQueryEditorPostCompositionKeyGuard({
      navigator: {
        maxTouchPoints: 0,
        userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
        vendor: "Google Inc.",
      },
    });
    const target = document.createElement("div");
    const detachGuard = guard.attach(target);

    dispatchComposition(target, "compositionstart");
    dispatchComposition(target, "compositionend");
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(guard.blocks(event)).toBe(false);
    detachGuard();
  });

  it("blocks the bubbled App fallback for Safari pending composition key", async () => {
    const harness = await createSafariShortcutHarness();

    dispatchComposition(harness.view.contentDOM, "compositionstart");
    dispatchComposition(harness.view.contentDOM, "compositionend");
    const pendingKey = dispatchExecuteShortcut(harness.view.contentDOM);

    expect(harness.defaultPreventedBeforeFallback()).toBe(false);
    expect(pendingKey.defaultPrevented).toBe(true);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.fallbackExecute).not.toHaveBeenCalled();

    dispatchExecuteShortcut(harness.view.contentDOM);
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.fallbackExecute).not.toHaveBeenCalled();
    harness.destroy();
  });

  it("allows a real execution shortcut after the pending-key window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00Z"));
    const harness = await createSafariShortcutHarness();

    dispatchComposition(harness.view.contentDOM, "compositionstart");
    dispatchComposition(harness.view.contentDOM, "compositionend");
    vi.advanceTimersByTime(101);
    dispatchExecuteShortcut(harness.view.contentDOM);

    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.fallbackExecute).not.toHaveBeenCalled();
    harness.destroy();
  });
});
