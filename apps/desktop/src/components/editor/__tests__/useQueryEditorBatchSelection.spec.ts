// @vitest-environment happy-dom

import { shallowRef } from "vue";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { snippetCompletion } from "@codemirror/autocomplete";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorBatchSelection, type QueryCompletionOption } from "../useQueryEditorBatchSelection";
import type { SqlCompletionItem } from "@/lib/sql/sqlCompletion";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));

type Options = Parameters<typeof useQueryEditorBatchSelection>[0];
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
  toast.mockReset();
});

function createHarness(doc = "SELECT  FROM users", mode: "select" | "insert" = "select") {
  const completionComp = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc, extensions: [completionComp.of([])] }) });
  const view = shallowRef<EditorView | null>(currentView);
  const runtime: Options["runtime"] = {
    completionComp,
    buildSqlCompletionExtension: vi.fn(() => []),
    codeMirrorCompletionStatus: vi.fn(() => "active"),
    codeMirrorStartCompletion: vi.fn(() => true),
    codeMirrorCurrentCompletions: vi.fn(() => []),
    codeMirrorSetSelectedCompletion: null,
    codeMirrorSelectedCompletion: vi.fn(() => null),
    codeMirrorSnippetCompletion: snippetCompletion,
  };
  const accepted = vi.fn();
  const batch = useQueryEditorBatchSelection({ view, runtime, settingsStore: { editorSettings: { sqlFormatter: { keywordCase: "upper" } } } as Options["settingsStore"], markCompletionAccepted: accepted });
  const items: SqlCompletionItem[] = ["id", "name", "email"].map((label) => ({ label, apply: label, type: "column", batchSelectionMode: mode }));
  const from = mode === "select" ? 7 : doc.length;
  const session = batch.prepareBatchColumnSelectionSession(items, doc, from, from)!;
  batch.attach(currentView, parent);
  cleanups.push(() => {
    batch.dispose();
    currentView.destroy();
    parent.remove();
  });
  function completion(index: number): QueryCompletionOption {
    return { label: items[index].label, dbxBatchColumnSelection: batch.batchColumnSelectionMarkerForItem(items[index]) };
  }
  function row(index: number) {
    const element = document.createElement("li");
    element.setAttribute("role", "option");
    const checkbox = batch.renderBatchColumnSelectionCheckbox(completion(index), currentView.state, currentView) as HTMLInputElement;
    const label = document.createElement("span");
    label.textContent = items[index].label;
    element.append(checkbox, label);
    parent.append(element);
    return { element, checkbox, label };
  }
  return { batch, currentView, view, runtime, accepted, items, session, completion, row };
}

describe("QueryEditor batch selection ownership", () => {
  it("keeps checked fields and cached options across refreshes, pruning removed fields", () => {
    const { batch, session, items, completion, currentView } = createHarness();
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    const option = completion(0);
    expect(batch.cacheBatchColumnSelectionOption(option.dbxBatchColumnSelection, option)).toBe(option);
    expect(batch.cacheBatchColumnSelectionOption(option.dbxBatchColumnSelection, completion(0))).toBe(option);
    const refreshed = batch.prepareBatchColumnSelectionSession(items.slice(0, 2), session.document, session.from, session.to)!;
    expect(refreshed).toBe(session);
    expect(refreshed.selectedKeys).toEqual(new Set(refreshed.candidates.map((candidate) => candidate.key)));
    expect(refreshed.completionOptions.size).toBe(1);
  });

  it("starts a fresh session when the document changes and ignores old select-all actions", () => {
    const { batch, session, items, currentView } = createHarness();
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    const next = batch.prepareBatchColumnSelectionSession(items, session.document + " ", session.from, session.to)!;
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    expect(next.selectedKeys.size).toBe(0);
    expect(next.completionOptions.size).toBe(0);
    batch.prepareBatchColumnSelectionSession([], next.document, next.from, next.to);
    expect(batch.expandedRendering).toBe(false);
  });

  it("guards label clicks and applies checked fields together, never an individual row", () => {
    const { batch, session, currentView, row, accepted } = createHarness();
    const { label } = row(1);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(label);
    const mouseDown = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    label.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(session.selectedKeys).toEqual(new Set([session.candidates[1].key]));
    expect(currentView.state.doc.toString()).toBe(session.document);
    expect(batch.applySelectedBatchColumnSelection(currentView)).toBe(true);
    expect(currentView.state.doc.toString()).toBe("SELECT name FROM users");
    expect(accepted).toHaveBeenCalledOnce();
    expect(batch.expandedRendering).toBe(false);
  });

  it("uses the live selected completion and inserts fields in candidate order", () => {
    const { batch, session, runtime, currentView, completion } = createHarness();
    runtime.codeMirrorSelectedCompletion = () => completion(2);
    expect(batch.toggleSelectedBatchColumnSelection(currentView)).toBe(true);
    runtime.codeMirrorSelectedCompletion = () => completion(0);
    batch.toggleSelectedBatchColumnSelection(currentView);
    expect(session.selectedKeys.size).toBe(2);
    expect(batch.applySelectedBatchColumnSelection(currentView)).toBe(true);
    expect(currentView.state.doc.toString()).toBe("SELECT id, email FROM users");
  });

  it("rejects stale documents and pending completion without recording acceptance", () => {
    const { batch, session, runtime, currentView, accepted } = createHarness();
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    runtime.codeMirrorCompletionStatus = () => "pending";
    expect(batch.applySelectedBatchColumnSelection(currentView)).toBe(false);
    runtime.codeMirrorCompletionStatus = () => "active";
    currentView.dispatch({ changes: { from: 0, insert: " " } });
    expect(batch.applySelectedBatchColumnSelection(currentView)).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("preserves the empty-selection warning and INSERT snippet application", () => {
    const { batch, session, currentView, accepted } = createHarness("INSERT INTO users (", "insert");
    const action = { label: "insert", type: "text" as const, detail: "", boost: 0, batchColumnSelectionAction: true as const, sessionKey: session.key };
    batch.applyBatchColumnSelection(currentView, action, session.from, session.to);
    expect(toast).toHaveBeenCalledWith("editor.completion.selectColumnsBeforeInsert", 3000);
    expect(accepted).not.toHaveBeenCalled();
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    batch.applySelectedBatchColumnSelection(currentView);
    expect(currentView.state.doc.toString()).toMatch(/^INSERT INTO users \(id, name, email\) VALUES \(/);
    expect(currentView.state.doc.toString()).not.toContain("${");
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("restores selection styles and cancels refresh work when disposed during a drag", () => {
    const { batch, row, currentView, runtime } = createHarness();
    const { checkbox } = row(0);
    document.body.style.userSelect = "text";
    checkbox.dispatchEvent(new PointerEvent("pointerdown", { button: 0, buttons: 1, isPrimary: true, pointerId: 9, bubbles: true }));
    expect(document.body.style.userSelect).toBe("none");
    const remove = vi.spyOn(window, "removeEventListener");
    batch.dispose();
    expect(document.body.style.userSelect).toBe("text");
    expect(remove.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel", "blur"]));
    const dispatch = vi.spyOn(currentView, "dispatch");
    vi.advanceTimersByTime(2000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(runtime.codeMirrorStartCompletion).not.toHaveBeenCalled();
    expect(batch.applySelectedBatchColumnSelection(currentView)).toBe(false);
    document.body.style.userSelect = "";
  });

  it("cancels pending refresh timers and document row guards on disposal", () => {
    const { batch, session, currentView, runtime, row } = createHarness();
    const { label } = row(0);
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    batch.dispose();
    vi.advanceTimersByTime(2000);
    expect(runtime.codeMirrorStartCompletion).not.toHaveBeenCalled();
    const mouseDown = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    label.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
  });

  it("does not reconfigure a replaced editor through an old render timer", () => {
    const { view, currentView } = createHarness();
    const dispatch = vi.spyOn(currentView, "dispatch");
    view.value = null;
    vi.advanceTimersByTime(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not consume an INSERT completion before the lazy snippet API is ready", () => {
    const { batch, session, currentView, accepted, runtime } = createHarness("INSERT INTO users (", "insert");
    Object.assign(runtime, { codeMirrorSnippetCompletion: undefined });
    batch.toggleAllBatchColumnSelection(currentView, session.key);
    batch.applySelectedBatchColumnSelection(currentView);
    expect(accepted).not.toHaveBeenCalled();
    expect(currentView.state.doc.toString()).toBe(session.document);
    expect(batch.expandedRendering).toBe(false);
  });
});
