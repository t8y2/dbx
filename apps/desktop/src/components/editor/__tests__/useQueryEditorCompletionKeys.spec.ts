// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as langSql from "@codemirror/lang-sql";
import { reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
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

function sqlEditor(doc: string, databaseType: "postgres" | "mysql" | "sqlserver" = "postgres", cursor = doc.length) {
  const host = document.createElement("div");
  document.body.append(host);
  const dialectName = databaseType === "sqlserver" ? "sqlserver" : databaseType === "mysql" ? "mysql" : "postgres";
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialectName, databaseType) })],
    }),
  });
  cleanups.push(() => {
    view.destroy();
    host.remove();
  });
  return view;
}

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
  const settings = reactive({
    editorSettings: {
      sqlFormatter: { useTabs: false, tabWidth: 2, keywordCase: "upper" as "upper" | "lower" | "preserve", autoCaseKeywordsOnSpace: false },
      shortcuts: { acceptCompletion: "Tab" },
      selectFirstCompletionOnOpen: false,
      sqlServerSpaceConfirmsCompletion: true,
      snippetTriggerKey: "tab" as const,
    },
  });
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

  it("accepts the first completion once a pending Enter retry becomes active", async () => {
    const { keys, view, status, runtime, accept, newline, settings } = createHarness();
    status.mockReturnValue("pending");
    settings.editorSettings.selectFirstCompletionOnOpen = true;
    expect(keys.handleEnter(view)).toBe(true);
    expect(newline).not.toHaveBeenCalled();
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    accept.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(accept).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("inserts one newline when a pending Enter retry expires", async () => {
    const { keys, view, status, settings, newline, completion } = createHarness();
    status.mockReturnValue("pending");
    settings.editorSettings.selectFirstCompletionOnOpen = true;
    expect(keys.handleEnter(view)).toBe(true);
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

  it("accepts the first unselected keyword completion on Space in SQL Server", () => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "select", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 6 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => null;
    runtime.codeMirrorCurrentCompletions = () => [{ label: "SELECT", type: "keyword" }];
    runtime.codeMirrorSelectFirstCompletion = vi.fn(() => {
      runtime.codeMirrorSelectedCompletionIndex = () => 0;
      runtime.codeMirrorSelectedCompletion = () => ({ label: "SELECT", type: "keyword" });
      return true;
    });
    accept.mockImplementation((currentView: EditorView) => {
      currentView.dispatch({ changes: { from: 0, to: 6, insert: "SELECT" }, selection: { anchor: 6 } });
      return true;
    });

    expect(keys.handleSpace(view)).toBe(true);
    expect(runtime.codeMirrorSelectFirstCompletion).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("SELECT ");
    expect(view.state.selection.main.head).toBe(7);
  });

  it("keeps the cursor on the typed line when Space confirms a completion above existing code (#15241)", () => {
    // Issue repro: a statement already exists below the line being typed and the
    // accepted keyword sits directly against its newline, so the typed space must
    // be inserted on the new line instead of dropping the cursor onto the old
    // statement's line.
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "select 1", databaseType: "sqlserver" });
    view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
    view.dispatch({ changes: { from: 0, insert: "insert" }, selection: { anchor: 6 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "INSERT", type: "keyword" });
    accept.mockImplementation((currentView: EditorView) => {
      currentView.dispatch({ changes: { from: 0, to: 6, insert: "INSERT" }, selection: { anchor: 6 } });
      return true;
    });

    expect(keys.handleSpace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("INSERT \nselect 1");
    expect(view.state.selection.main.head).toBe(7);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
  });

  it("does not commit an unrelated fuzzy match on Space in SQL Server", () => {
    // #14698: typing the JOIN keyword `on` opens the popup with fuzzy column
    // matches; Space must stay a literal space instead of rewriting the word.
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "inner join t on", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 15 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => null;
    runtime.codeMirrorCurrentCompletions = () => [{ label: "tbml.FMEMONICCODE", apply: "FMEMONICCODE", type: "column" }];
    runtime.codeMirrorSelectFirstCompletion = vi.fn(() => false);
    accept.mockReturnValue(true);

    expect(keys.handleSpace(view)).toBe(false);
    expect(runtime.codeMirrorSelectFirstCompletion).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("inner join t on");
  });

  it("does not commit an unrelated selected fuzzy match on Space in SQL Server", () => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "inner join t on", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 15 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "tbml.FMEMONICCODE", apply: "FMEMONICCODE", type: "column" });
    accept.mockReturnValue(true);

    expect(keys.acceptSqlServerCompletionOnSpace(view)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("inner join t on");
  });

  it("keeps confirming a keyword that continues the typed word on Space", () => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "on", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 2 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "only", type: "keyword" });
    accept.mockReturnValue(true);

    expect(keys.acceptSqlServerCompletionOnSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("keeps confirming a qualified column continuation on Space in SQL Server", () => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "select tbml.f", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 13 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "tbml.FMEMONICCODE", apply: "FMEMONICCODE", type: "column" });
    accept.mockImplementation((currentView: EditorView) => {
      currentView.dispatch({ changes: { from: 7, to: 13, insert: "FMEMONICCODE" }, selection: { anchor: 19 } });
      return true;
    });

    expect(keys.acceptSqlServerCompletionOnSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("select FMEMONICCODE ");
    expect(view.state.selection.main.head).toBe(20);
  });

  it("keeps confirming a completion right after a dot qualifier on Space", () => {
    const { keys, view, runtime, status, accept } = createHarness({ modelValue: "select tbml.", databaseType: "sqlserver" });
    view.dispatch({ selection: { anchor: 12 } });
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "tbml.FMEMONICCODE", apply: "FMEMONICCODE", type: "column" });
    accept.mockReturnValue(true);

    expect(keys.acceptSqlServerCompletionOnSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("accepts snippet completion on Tab when snippetTriggerKey is tab or both", () => {
    const { keys, view, status, runtime, accept } = createHarness();
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    runtime.codeMirrorSelectedCompletion = () => ({ label: "sel", type: "snippet" });
    accept.mockReturnValue(true);

    expect(keys.handleTab(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("does not accept snippet completion on Tab when snippetTriggerKey is space", () => {
    const { keys, view, status, runtime, accept, settings } = createHarness();
    settings.editorSettings.snippetTriggerKey = "space";
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    runtime.codeMirrorSelectedCompletion = () => ({ label: "sel", type: "snippet" });
    accept.mockReturnValue(true);

    expect(keys.handleTab(view)).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("abc  ");
  });

  it("accepts snippet completion on Space when snippetTriggerKey is space or both", () => {
    const { keys, view, status, runtime, accept, settings } = createHarness();
    settings.editorSettings.snippetTriggerKey = "space";
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    runtime.codeMirrorSelectedCompletion = () => ({ label: "sel", type: "snippet" });
    accept.mockReturnValue(true);

    expect(keys.handleSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();

    accept.mockClear();
    settings.editorSettings.snippetTriggerKey = "both";
    expect(keys.handleSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("does not accept snippet completion on Space when snippetTriggerKey is tab", () => {
    const { keys, view, status, runtime, accept, settings } = createHarness();
    settings.editorSettings.snippetTriggerKey = "tab";
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    runtime.codeMirrorSelectedCompletion = () => ({ label: "sel", type: "snippet" });
    accept.mockReturnValue(true);

    expect(keys.handleSpace(view)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it("recases a finished keyword on Space when auto-case is enabled", () => {
    const { keys, settings } = createHarness({ databaseType: "postgres" });
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    const view = sqlEditor("select");

    expect(keys.handleSpace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT ");
    expect(view.state.selection.main.head).toBe(7);
  });

  it("lowercases a finished keyword when keyword case is lower", () => {
    const { keys, settings } = createHarness({ databaseType: "mysql" });
    settings.editorSettings.sqlFormatter.keywordCase = "lower";
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    const view = sqlEditor("CREATE", "mysql");

    expect(keys.handleSpace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("create ");
  });

  it("leaves Space alone when auto-case is off, case is preserved, or the word is already cased", () => {
    const off = createHarness({ databaseType: "postgres" });
    const offView = sqlEditor("select");
    expect(off.keys.handleSpace(offView)).toBe(false);
    expect(offView.state.doc.toString()).toBe("select");

    const preserved = createHarness({ databaseType: "postgres" });
    preserved.settings.editorSettings.sqlFormatter.keywordCase = "preserve";
    preserved.settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    const preservedView = sqlEditor("select");
    expect(preserved.keys.handleSpace(preservedView)).toBe(false);
    expect(preservedView.state.doc.toString()).toBe("select");

    const ready = createHarness({ databaseType: "postgres" });
    ready.settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    const readyView = sqlEditor("SELECT");
    expect(ready.keys.handleSpace(readyView)).toBe(false);
    expect(readyView.state.doc.toString()).toBe("SELECT");
  });

  it("does not recase names, qualified words, strings, or comments", () => {
    const { keys, settings } = createHarness({ databaseType: "postgres" });
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;

    const samples: Array<[string, number]> = [
      ["select name", "select name".length],
      ["select t.order", "select t.order".length],
      ["select 'select'", "select 'select".length],
      ['select "select"', 'select "select'.length],
      ["-- select", "-- select".length],
      ["/* select */", "/* select ".length],
    ];
    for (const [source, cursor] of samples) {
      const view = sqlEditor(source, "postgres", cursor);
      expect(keys.handleSpace(view), source).toBe(false);
      expect(view.state.doc.toString(), source).toBe(source);
    }
  });

  it("keeps the SQL Server space-confirm recase when the new switch is off", () => {
    const { keys, settings, props } = createHarness({ databaseType: "sqlserver" });
    props.databaseType = "sqlserver";
    settings.editorSettings.sqlServerSpaceConfirmsCompletion = true;
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = false;
    const view = sqlEditor("select", "sqlserver");

    expect(keys.handleSpace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT ");
  });

  it("does not recase on SQL Server once space-confirm and the new switch are both off", () => {
    const { keys, settings } = createHarness({ databaseType: "sqlserver" });
    settings.editorSettings.sqlServerSpaceConfirmsCompletion = false;
    const view = sqlEditor("select", "sqlserver");

    expect(keys.handleSpace(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("select");
  });

  it("lets an open SQL Server completion consume Space before keyword recasing", () => {
    const { keys, settings, status, runtime, accept } = createHarness({ databaseType: "sqlserver", modelValue: "select" });
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    const view = sqlEditor("select", "sqlserver");
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletion = () => ({ label: "SELECT", type: "keyword" });
    accept.mockReturnValue(true);

    expect(keys.handleSpace(view)).toBe(true);
    expect(accept).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("select ");
  });

  it("ignores Space for keyword recasing while an IME composition is active", () => {
    const { keys, settings, composing } = createHarness({ databaseType: "postgres" });
    settings.editorSettings.sqlFormatter.autoCaseKeywordsOnSpace = true;
    composing.mockReturnValue(true);
    const view = sqlEditor("select");

    expect(keys.handleSpace(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("select");
  });

  it("ignores Space for snippet completion while an IME composition is active", () => {
    const { keys, view, status, runtime, accept, composing, settings } = createHarness();
    settings.editorSettings.snippetTriggerKey = "space";
    status.mockReturnValue("active");
    runtime.codeMirrorSelectedCompletionIndex = () => 0;
    runtime.codeMirrorSelectedCompletion = () => ({ label: "sel", type: "snippet" });
    composing.mockReturnValue(true);

    expect(keys.handleSpace(view)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });
});
