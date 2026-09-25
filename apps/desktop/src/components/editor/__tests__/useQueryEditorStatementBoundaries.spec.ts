// @vitest-environment happy-dom

import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorCodeMirrorRuntime } from "../queryEditorCodeMirrorRuntime";
import { useQueryEditorStatementBoundaries } from "../useQueryEditorStatementBoundaries";
import { statementGutterStartIndexHasStartAt, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHarness() {
  const view = shallowRef<EditorView | null>(null);
  const cache = { value: null as ExecutableStatementRangeCache | null };
  const runtime = createQueryEditorCodeMirrorRuntime();
  runtime.statementBoundariesRefreshEffect = StateEffect.define<null>();
  const boundaries = useQueryEditorStatementBoundaries({
    props: { modelValue: "", databaseType: "mysql" },
    view,
    cache,
    runtime,
    sqlStatementParameterOptions: () => ({}),
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc: "SELECT 1;\nSELECT 2;", extensions: [boundaries.createTrackingPlugin(ViewPlugin)] }) });
  view.value = currentView;
  cleanups.push(() => {
    currentView.destroy();
    parent.remove();
  });
  return { view, currentView, cache, runtime, boundaries, parent };
}

describe("QueryEditor shared statement boundaries", () => {
  it("does not parse or schedule refreshes before any consumer requests boundaries", async () => {
    const { currentView, cache } = createHarness();
    currentView.dispatch({ changes: { from: 7, insert: "0" } });
    await vi.advanceTimersByTimeAsync(200);
    expect(cache.value).toBeNull();
  });

  it("maps positions during typing and refreshes the shared cache only after the debounce", async () => {
    const { currentView, cache, boundaries } = createHarness();
    const initial = boundaries.statementBoundariesForState(currentView.state);
    const exactCache = cache.value;
    initial.frameRange = { from: 10, to: 18 };
    expect(boundaries.statementBoundariesForState(currentView.state)).toBe(initial);
    currentView.dispatch({ changes: { from: 0, insert: " " } });
    const mapped = boundaries.statementBoundariesForState(currentView.state);
    expect(mapped.fresh).toBe(false);
    expect(mapped.frameRange).toEqual({ from: 11, to: 19 });
    expect(statementGutterStartIndexHasStartAt(mapped.startsIndex, 11)).toBe(true);
    expect(cache.value).toBe(exactCache);
    await vi.advanceTimersByTimeAsync(100);
    currentView.dispatch({ changes: { from: 0, insert: " " } });
    await vi.advanceTimersByTimeAsync(149);
    expect(cache.value).toBe(exactCache);
    await vi.advanceTimersByTimeAsync(1);
    const refreshed = boundaries.statementBoundariesForState(currentView.state);
    expect(refreshed.fresh).toBe(true);
    expect(refreshed.doc).toBe(currentView.state.doc);
    expect(cache.value).not.toBe(exactCache);
    expect(refreshed.frameRange).toBeNull();
  });

  it("rebuilds when the dialect generation or tab state changes", () => {
    const { currentView, boundaries } = createHarness();
    const initial = boundaries.statementBoundariesForState(currentView.state);
    boundaries.invalidate();
    const invalidated = boundaries.statementBoundariesForState(currentView.state);
    expect(invalidated).not.toBe(initial);
    expect(invalidated.generation).toBe(initial.generation + 1);
    const anotherTab = EditorState.create({ doc: "SELECT 3;" });
    expect(boundaries.statementBoundariesForState(anotherTab).doc).toBe(anotherTab.doc);
    expect(boundaries.statementBoundariesForState(currentView.state).doc).toBe(currentView.state.doc);
  });

  it.each(["destroyed", "replaced", "detached"])("does not refresh an editor that was %s", async (reason) => {
    const { currentView, view, parent, boundaries, cache } = createHarness();
    boundaries.statementBoundariesForState(currentView.state);
    const previousCache = cache.value;
    currentView.dispatch({ changes: { from: 0, insert: " " } });
    if (reason === "destroyed") currentView.destroy();
    if (reason === "replaced") view.value = null;
    if (reason === "detached") parent.remove();
    const dispatch = vi.spyOn(currentView, "dispatch");
    await vi.advanceTimersByTimeAsync(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(cache.value).toBe(previousCache);
  });
});
