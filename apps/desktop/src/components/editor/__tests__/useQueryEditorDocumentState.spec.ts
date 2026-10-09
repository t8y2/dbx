// @vitest-environment happy-dom

import { createApp, h, nextTick, onBeforeUnmount, reactive, ref, shallowRef } from "vue";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorDocumentState } from "../useQueryEditorDocumentState";
import type { QueryEditorProps } from "../queryEditorTypes";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(EditorView.prototype, "focus").mockImplementation(() => {});
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT 1;", tabId: "tab-a", autoFocus: false, ...overrides });
  const historyResetComp = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc: props.modelValue, extensions: [historyResetComp.of(history())] }) });
  const view = shallowRef<EditorView | null>(currentView);
  const runtime = { historyResetComp, codeMirrorHistory: history, codeMirrorEditorSelection: EditorSelection, editorIsActive: true };
  const emit = vi.fn();
  const callbacks = {
    scheduleSemanticDiagnostics: vi.fn(),
    clearScheduledPreviewContextRefresh: vi.fn(),
    syncContextMenuState: vi.fn(),
    applyEditorAppearance: vi.fn().mockResolvedValue(undefined),
    applyEditorShortcutKeymaps: vi.fn(),
    applyEditorIndentExtension: vi.fn(),
    applyEditorCompletionExtension: vi.fn(),
    invalidateSemanticDiagnosticsForDocumentChange: vi.fn(),
    currentEditorDocText: (editor: EditorView) => editor.state.doc.toString(),
    scheduleDocumentSearchUpdate: vi.fn(),
    isEditorComposing: vi.fn(() => false),
  };
  let state!: ReturnType<typeof useQueryEditorDocumentState>;
  const app = createApp({
    setup() {
      state = useQueryEditorDocumentState({ props, view, runtime, emit, previewContextSql: ref(""), ...callbacks });
      state.attach();
      onBeforeUnmount(() => {
        state.flushBeforeDeactivation();
        state.dispose();
      });
      return () => h("div");
    },
  });
  const host = document.createElement("div");
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
  };
  cleanups.push(() => {
    unmount();
    currentView.destroy();
    parent.remove();
  });
  async function activate(tabId: string, modelValue: string, saved: Partial<QueryEditorProps> = {}) {
    Object.assign(props, { tabId, modelValue, initialSelection: undefined, initialViewport: undefined }, saved);
    await nextTick();
  }
  async function append(text: string) {
    currentView.dispatch({ changes: { from: currentView.state.doc.length, insert: text } });
    props.modelValue = currentView.state.doc.toString();
    await nextTick();
  }
  return { state, props, runtime, emit, callbacks, currentView, activate, append, unmount };
}

describe("QueryEditor document and viewport ownership", () => {
  it("isolates undo on new tabs and restores each cached tab's own history", async () => {
    const { currentView, activate, append, callbacks } = createHarness();
    await append(" -- a");
    await activate("tab-b", "SELECT 2;");
    expect(undo(currentView)).toBe(false);
    await append(" -- b");
    await activate("tab-a", "SELECT 1; -- a");
    expect(undo(currentView)).toBe(true);
    expect(currentView.state.doc.toString()).toBe("SELECT 1;");
    await activate("tab-b", "SELECT 2; -- b");
    expect(undo(currentView)).toBe(true);
    expect(currentView.state.doc.toString()).toBe("SELECT 2;");
    expect(callbacks.applyEditorAppearance).toHaveBeenCalledTimes(2);
    expect(callbacks.applyEditorShortcutKeymaps).toHaveBeenCalledTimes(2);
    expect(callbacks.applyEditorIndentExtension).toHaveBeenCalledTimes(2);
    expect(callbacks.applyEditorCompletionExtension).toHaveBeenCalledTimes(2);
    expect(callbacks.scheduleDocumentSearchUpdate).toHaveBeenCalledTimes(2);
  });

  it("bounds cached histories and treats an evicted tab as a fresh document", async () => {
    const { currentView, activate, append } = createHarness();
    await append(" -- a");
    for (let index = 0; index < 17; index++) await activate(`tab-${index}`, `SELECT ${index};`);
    await activate("tab-a", "SELECT 1; -- a");
    expect(currentView.state.doc.toString()).toBe("SELECT 1; -- a");
    expect(undo(currentView)).toBe(false);
  });

  it("keeps external edits to a cached inactive document undoable", async () => {
    const { currentView, activate } = createHarness();
    await activate("tab-b", "SELECT 2;");
    await activate("tab-a", "SELECT 100;");
    expect(undo(currentView)).toBe(true);
    expect(currentView.state.doc.toString()).toBe("SELECT 1;");
  });

  it("restores saved selection and viewport, without leaking them into a brand-new tab", async () => {
    const { currentView, activate, callbacks } = createHarness();
    await activate("tab-b", "SELECT 200;", { initialSelection: { anchor: 7, head: 10 }, initialViewport: { scrollTop: 300, scrollLeft: 40 } });
    expect(currentView.state.selection.main.anchor).toBe(7);
    expect(currentView.state.selection.main.head).toBe(10);
    expect(currentView.scrollDOM.scrollTop).toBe(300);
    expect(currentView.scrollDOM.scrollLeft).toBe(40);
    expect(callbacks.syncContextMenuState).toHaveBeenCalledWith(currentView);
    await activate("tab-c", "SELECT 3;");
    expect(currentView.state.selection.main.head).toBe(0);
    expect(currentView.scrollDOM.scrollTop).toBe(0);
    expect(currentView.scrollDOM.scrollLeft).toBe(0);
  });

  it("flushes a deferred viewport with its outgoing tab owner and deduplicates emissions", async () => {
    const { state, currentView, activate, emit } = createHarness();
    currentView.scrollDOM.scrollTop = 240;
    state.scheduleEditorViewportEmit();
    await activate("tab-b", "SELECT 2;");
    expect(emit.mock.calls.filter(([event]) => event === "viewportChange")).toEqual([["viewportChange", { scrollTop: 240, scrollLeft: 0 }, "tab-a"]]);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit.mock.calls.filter(([event]) => event === "viewportChange")).toHaveLength(1);
    currentView.scrollDOM.scrollTop = 100;
    state.scheduleEditorViewportEmit();
    await vi.advanceTimersByTimeAsync(200);
    expect(emit).toHaveBeenCalledWith("viewportChange", { scrollTop: 100, scrollLeft: 0 }, "tab-b");
  });

  it("captures state before tab deactivation and never flushes a reset inactive viewport", () => {
    const { state, currentView, runtime, emit } = createHarness();
    currentView.scrollDOM.scrollTop = 220;
    currentView.dispatch({ selection: { anchor: 4 } });
    window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { fromTabId: "another-tab" } }));
    expect(emit).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { fromTabId: "tab-a" } }));
    expect(emit).toHaveBeenCalledWith("viewportChange", { scrollTop: 220, scrollLeft: 0 }, "tab-a");
    expect(emit).toHaveBeenCalledWith("selectionStateChange", { anchor: 4, head: 4 });
    emit.mockClear();
    currentView.scrollDOM.scrollTop = 0;
    state.flushBeforeDeactivation();
    runtime.editorIsActive = false;
    state.flushBeforeDeactivation();
    expect(emit).not.toHaveBeenCalled();
  });

  it("hydrates saved state after mount and respects IME composition for external content updates", async () => {
    const { props, currentView, callbacks } = createHarness();
    props.initialViewport = { scrollTop: 280, scrollLeft: 30 };
    props.initialSelection = { anchor: 3, head: 3 };
    await nextTick();
    expect(currentView.scrollDOM.scrollTop).toBe(280);
    expect(currentView.state.selection.main.head).toBe(3);
    callbacks.isEditorComposing.mockReturnValue(true);
    props.modelValue = "SELECT blocked;";
    await nextTick();
    expect(currentView.state.doc.toString()).toBe("SELECT 1;");
    callbacks.isEditorComposing.mockReturnValue(false);
    props.modelValue = "SELECT allowed;";
    await nextTick();
    expect(currentView.state.doc.toString()).toBe("SELECT allowed;");
  });

  it("cancels pending viewport work and removes listeners when unmounted", async () => {
    const { state, currentView, runtime, emit, unmount } = createHarness();
    currentView.scrollDOM.scrollTop = 500;
    state.scheduleEditorViewportEmit();
    state.restoreEditorViewport({ scrollTop: 500, scrollLeft: 0 });
    await nextTick();
    runtime.editorIsActive = false;
    unmount();
    emit.mockClear();
    window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { fromTabId: "tab-a" } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(emit).not.toHaveBeenCalled();
  });
});
