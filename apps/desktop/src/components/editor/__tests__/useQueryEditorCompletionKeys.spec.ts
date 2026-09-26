// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorCodeMirrorRuntime } from "../queryEditorCodeMirrorRuntime";
import { useQueryEditorCompletionKeys } from "../useQueryEditorCompletionKeys";
import type { QueryEditorProps } from "../queryEditorTypes";

type Options = Parameters<typeof useQueryEditorCompletionKeys>[0];
const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}) {
  const props = reactive<QueryEditorProps>({ modelValue: "abc", databaseType: "postgres", ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: props.modelValue, selection: { anchor: props.modelValue.length }, extensions: [EditorState.allowMultipleSelections.of(true)] }) });
  const runtime = createQueryEditorCodeMirrorRuntime();
  const status = vi.fn<NonNullable<typeof runtime.codeMirrorCompletionStatus>>(() => null);
  const accept = vi.fn(() => false);
  const snippet = vi.fn(() => false);
  const indent = vi.fn(() => true);
  const composing = vi.fn(() => false);
  const batch = vi.fn(() => false);
  const newline = vi.fn((currentView: EditorView) => {
    currentView.dispatch(currentView.state.replaceSelection("\n"));
    return true;
  });
  Object.assign(runtime, {
    codeMirrorCompletionStatus: status,
    codeMirrorAcceptCompletion: accept,
    codeMirrorNextSnippetField: snippet,
    codeMirrorIndentMore: indent,
    codeMirrorCloseCompletion: vi.fn(() => false),
    codeMirrorSelectedCompletionIndex: vi.fn(() => null),
    codeMirrorSelectFirstCompletion: vi.fn(() => false),
    codeMirrorInsertNewlineKeepIndent: newline,
  });
  const settings = reactive({ editorSettings: { sqlFormatter: { useTabs: false, tabWidth: 2 }, shortcuts: { acceptCompletion: "Tab" }, selectFirstCompletionOnOpen: false, sqlServerSpaceConfirmsCompletion: true } });
  const completion = { suppressAutoStartUntil: 0 };
  const keys = useQueryEditorCompletionKeys({ props, settingsStore: settings as Options["settingsStore"], runtime, completion, batchSelection: { applySelectedBatchColumnSelection: batch }, isEditorComposing: composing, retryDelayMs: 5, tabMaxWaitMs: 40, enterMaxWaitMs: 20 });
  cleanups.push(() => {
    keys.clearPendingCompletionEnter();
    keys.clearPendingCompletionTab();
    view.destroy();
    host.remove();
  });
  return { props, view, runtime, status, accept, snippet, indent, composing, batch, newline, settings, completion, keys };
}

describe("QueryEditor completion-key ownership", () => {
  it.each(["handleTab", "handleEnter", "acceptCompletionOrNextSnippetField"] as const)("leaves %s to an active IME", (method) => {
    const { keys, view, composing, accept, snippet, indent } = createHarness();
    composing.mockReturnValue(true);
    expect(keys[method](view)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
    expect(snippet).not.toHaveBeenCalled();
    expect(indent).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("preserves ordinary Tab indentation when completion acceptance is remapped", () => {
    const { keys, view, settings, status, accept } = createHarness();
    settings.editorSettings.shortcuts.acceptCompletion = "Enter";
    status.mockReturnValue("active");
    expect(keys.handleTab(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("abc  ");
    expect(accept).not.toHaveBeenCalled();
    settings.editorSettings.sqlFormatter.useTabs = true;
    expect(keys.editorIndentUnit()).toBe("\t");
  });

  it("prioritizes a selected snippet field over ordinary indentation", () => {
    const { keys, view, snippet, indent, accept } = createHarness();
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    snippet.mockReturnValueOnce(true);
    expect(keys.handleTab(view)).toBe(true);
    expect(indent).not.toHaveBeenCalled();
    expect(keys.handleTab(view)).toBe(true);
    expect(indent).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["handleEnter", "acceptCompletionOrNextSnippetField"] as const)("gives checked-column insertion priority in %s", (method) => {
    const { keys, view, status, batch, accept } = createHarness();
    status.mockReturnValue("active");
    batch.mockReturnValue(true);
    expect(keys[method](view)).toBe(true);
    expect(batch).toHaveBeenCalledWith(view);
    expect(accept).not.toHaveBeenCalled();
  });

  it("accepts a pending Tab only after completion becomes available", async () => {
    const { keys, view, status, runtime, accept, snippet } = createHarness();
    status.mockReturnValue("pending");
    expect(keys.handleTab(view)).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    accept.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(accept).toHaveBeenCalledOnce();
    expect(snippet).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("falls back to normal Tab once the pending completion budget expires", async () => {
    const { keys, view, status, snippet } = createHarness();
    status.mockReturnValue("pending");
    keys.handleTab(view);
    await vi.advanceTimersByTimeAsync(45);
    expect(snippet).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("abc  ");
  });

  it.each(["document", "secondary-selection", "composition", "cancel"])("invalidates queued Tab after %s changes", async (change) => {
    const { keys, view, status, composing, accept, snippet } = createHarness();
    status.mockReturnValue("pending");
    keys.handleTab(view);
    if (change === "document") view.dispatch({ changes: { from: 0, insert: "x" } });
    if (change === "secondary-selection") view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)], 1) });
    if (change === "composition") composing.mockReturnValue(true);
    if (change === "cancel") keys.clearPendingCompletionTab();
    const document = view.state.doc.toString();
    await vi.advanceTimersByTimeAsync(50);
    expect(view.state.doc.toString()).toBe(document);
    expect(accept).not.toHaveBeenCalled();
    expect(snippet).not.toHaveBeenCalled();
  });

  it("inserts one newline and suppresses automatic completion after an Enter retry expires", async () => {
    const { keys, view, status, settings, newline, completion } = createHarness();
    status.mockReturnValue("active");
    settings.editorSettings.selectFirstCompletionOnOpen = true;
    expect(keys.handleEnter(view)).toBe(true);
    expect(newline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(newline).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("abc\n");
    expect(completion.suppressAutoStartUntil).toBeGreaterThan(Date.now());
  });

  it("cancels Enter retries without cancelling another editor's pending Tab", async () => {
    const first = createHarness();
    const second = createHarness();
    first.settings.editorSettings.selectFirstCompletionOnOpen = true;
    first.status.mockReturnValue("active");
    second.status.mockReturnValue("pending");
    first.keys.handleEnter(first.view);
    second.keys.handleTab(second.view);
    first.keys.clearPendingCompletionEnter();
    await vi.advanceTimersByTimeAsync(50);
    expect(first.view.state.doc.toString()).toBe("abc");
    expect(first.newline).not.toHaveBeenCalled();
    expect(second.view.state.doc.toString()).toBe("abc  ");
  });

  it.each(["users", "users "])("preserves SQL Server Space acceptance and existing whitespace in %s", (sql) => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: sql, databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 5 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "users", type: "table" });
    accept.mockReturnValue(true);
    expect(keys.acceptSqlServerCompletionOnSpace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("users ");
    expect(view.state.selection.main.head).toBe(6);
  });
});
