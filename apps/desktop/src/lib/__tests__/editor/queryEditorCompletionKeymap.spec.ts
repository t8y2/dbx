import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function extractFunction(name: string): string {
  const start = queryEditorSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing QueryEditor function: ${name}`);
  const bodyStart = queryEditorSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < queryEditorSource.length; index++) {
    const character = queryEditorSource[index];
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return queryEditorSource.slice(start, index + 1);
  }
  throw new Error(`Unterminated QueryEditor function: ${name}`);
}

function extractDeclaration(pattern: RegExp, label: string): string {
  const match = queryEditorSource.match(pattern);
  if (!match) throw new Error(`Missing QueryEditor declaration: ${label}`);
  return match[0];
}

interface MockSelection {
  anchor: number;
  head: number;
  from: number;
  empty: boolean;
}

interface MockState {
  doc: {
    lineAt: (position: number) => { from: number; text: string };
  };
  selection: { main: MockSelection };
  replaceSelection: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

interface MockView {
  state: MockState;
  dispatch: ReturnType<typeof vi.fn>;
}

interface TabHarness {
  handleTab: (view: MockView) => boolean;
  insertNewlineWithoutCompletion: (view: MockView) => boolean;
  acceptCompletionOrNextSnippetField: (view: MockView) => boolean;
  clearPendingCompletionTab: () => void;
  consumeSqlCompletionAutoStartSuppression: () => boolean;
}

function createHarness(options: {
  completionStatus: (state: MockState) => "active" | "pending" | null;
  acceptCompletion?: (view: MockView) => boolean;
  closeCompletion?: (view: MockView) => boolean;
  insertNewlineKeepIndent?: (view: MockView) => boolean;
  nextSnippetField?: (view: MockView) => boolean;
  indentMore?: (view: MockView) => boolean;
}): TabHarness {
  const source = [
    extractDeclaration(/const COMPLETION_REMOTE_LATENCY_BUDGET_MS = \d+;/, "remote completion latency budget"),
    extractDeclaration(/const COMPLETION_DEBOUNCE_DELAY_MS = \d+;/, "completion debounce delay"),
    extractDeclaration(/const COMPLETION_TAB_RETRY_DELAY_MS = \d+;/, "completion retry delay"),
    extractDeclaration(/const COMPLETION_TAB_MAX_WAIT_MS = [^;]+;/, "completion wait timeout"),
    "let pendingCompletionTabTimer: ReturnType<typeof setTimeout> | null = null;",
    "let suppressNextSqlCompletionAutoStartUntil = 0;",
    extractFunction("editorIndentUnit"),
    extractFunction("handleTab"),
    extractFunction("performNormalTab"),
    extractFunction("insertNewlineWithoutCompletion"),
    extractFunction("acceptCompletionOrNextSnippetField"),
    extractFunction("clearPendingCompletionTab"),
    extractFunction("waitForCompletionTab"),
    extractFunction("consumeSqlCompletionAutoStartSuppression"),
  ].join("\n");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = new Function(
    "codeMirrorCompletionStatus",
    "codeMirrorAcceptCompletion",
    "codeMirrorCloseCompletion",
    "codeMirrorInsertNewlineKeepIndent",
    "codeMirrorNextSnippetField",
    "codeMirrorIndentMore",
    "settingsStore",
    `${javascript}\nreturn { handleTab, insertNewlineWithoutCompletion, acceptCompletionOrNextSnippetField, clearPendingCompletionTab, consumeSqlCompletionAutoStartSuppression };`,
  );
  return factory(options.completionStatus, options.acceptCompletion ?? (() => false), options.closeCompletion ?? (() => false), options.insertNewlineKeepIndent ?? (() => false), options.nextSnippetField ?? (() => false), options.indentMore ?? (() => false), {
    editorSettings: { sqlFormatter: { useTabs: false, tabWidth: 2 } },
  }) as TabHarness;
}

function createView(text = "SELECT", position = text.length): MockView {
  const selection: MockSelection = { anchor: position, head: position, from: position, empty: true };
  const state: MockState = {
    doc: {
      lineAt: () => ({ from: 0, text }),
    },
    selection: { main: selection },
    replaceSelection: vi.fn((insert: string) => ({ insert })),
    update: vi.fn((change: unknown, options: unknown) => ({ change, options })),
  };
  return { state, dispatch: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryEditor completion Tab keymap", () => {
  it("closes completion and suppresses its restart for the Enter newline", () => {
    const closeCompletion = vi.fn(() => true);
    let harness: TabHarness;
    const insertNewlineKeepIndent = vi.fn(() => harness.consumeSqlCompletionAutoStartSuppression());
    harness = createHarness({ completionStatus: () => "active", closeCompletion, insertNewlineKeepIndent });
    const view = createView("SELECT * FROM demo WHERE id IN ()", 32);

    expect(harness.insertNewlineWithoutCompletion(view)).toBe(true);
    expect(closeCompletion).toHaveBeenCalledWith(view);
    expect(insertNewlineKeepIndent).toHaveBeenCalledWith(view);
    expect(harness.consumeSqlCompletionAutoStartSuppression()).toBe(false);
  });

  it("does not suppress later completion when Enter cannot insert a newline", () => {
    const harness = createHarness({ completionStatus: () => null, insertNewlineKeepIndent: () => false });

    expect(harness.insertNewlineWithoutCompletion(createView())).toBe(false);
    expect(harness.consumeSqlCompletionAutoStartSuppression()).toBe(false);
  });

  it("keeps CodeMirror prefix filtering enabled for SQL completion results", () => {
    const javascript = ts.transpileModule(extractFunction("buildCompletionResult"), {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const buildCompletionResult = new Function("completionOptionForItem", `${javascript}\nreturn buildCompletionResult;`)(() => ({ label: "created_at" })) as (items: Array<{ label: string }>, from: number) => { filter?: boolean; options: Array<{ label: string }>; from: number } | null;

    const result = buildCompletionResult([{ label: "created_at" }], 0);

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("filter");
  });

  it("keeps ASCII single-character filtering while allowing Han pinyin matches", () => {
    const source = [extractFunction("completionItemsForBypassedFilter"), extractFunction("shouldBypassCompletionFilter"), extractFunction("buildCompletionResult")].join("\n");
    const javascript = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const buildCompletionResult = new Function("completionOptionForItem", "completionMatchRanges", `${javascript}\nreturn buildCompletionResult;`)(
      (item: { label: string }) => item,
      () => [],
    ) as (items: Array<{ label: string }>, from: number, validFor?: RegExp, prefix?: string) => { filter?: boolean; options: Array<{ label: string }> } | null;

    const result = buildCompletionResult([{ label: "amount" }, { label: "memo" }, { label: "明细" }], 0, undefined, "m");

    expect(result?.filter).toBe(false);
    expect(result?.options.map((item) => item.label)).toEqual(["memo", "明细"]);
  });

  it("bypasses CodeMirror filtering for Han substring matches", () => {
    const javascript = ts.transpileModule(extractFunction("shouldBypassCompletionFilter"), {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const shouldBypassCompletionFilter = new Function(`${javascript}\nreturn shouldBypassCompletionFilter;`)() as (prefix: string, items: Array<{ label: string }>) => boolean;

    expect(shouldBypassCompletionFilter("金", [{ label: "总租金" }])).toBe(true);
    expect(shouldBypassCompletionFilter("m", [{ label: "amount" }, { label: "memo" }])).toBe(false);
  });

  it("keeps normal Tab indentation when completion is inactive", () => {
    const harness = createHarness({ completionStatus: () => null });
    const view = createView();

    expect(harness.handleTab(view)).toBe(true);
    expect(view.state.replaceSelection).toHaveBeenCalledWith("  ");
    expect(view.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps snippet-field navigation when no completion is open", () => {
    const nextSnippetField = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => null, nextSnippetField });
    const view = createView();

    expect(harness.handleTab(view)).toBe(true);
    expect(nextSnippetField).toHaveBeenCalledWith(view);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("waits for pending completion before advancing a snippet field", async () => {
    vi.useFakeTimers();
    let status: "active" | "pending" | null = "pending";
    const acceptCompletion = vi.fn(() => true);
    const nextSnippetField = vi.fn(() => true);
    const indentMore = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => status, acceptCompletion, nextSnippetField, indentMore });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    expect(nextSnippetField).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    status = "active";
    await vi.advanceTimersByTimeAsync(16);

    expect(acceptCompletion).toHaveBeenCalledWith(view);
    expect(nextSnippetField).not.toHaveBeenCalled();
    expect(indentMore).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("accepts an already-open completion popup", () => {
    const acceptCompletion = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", acceptCompletion });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    expect(acceptCompletion).toHaveBeenCalledWith(view);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("waits for an immediate Tab completion that is still pending", async () => {
    vi.useFakeTimers();
    let status: "active" | "pending" | null = "pending";
    const acceptCompletion = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const harness = createHarness({ completionStatus: () => status, acceptCompletion });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    status = "active";
    await vi.advanceTimersByTimeAsync(32);

    expect(acceptCompletion).toHaveBeenCalledTimes(2);
    expect(acceptCompletion).toHaveBeenLastCalledWith(view);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("falls back to normal Tab when pending completion has no candidate", async () => {
    vi.useFakeTimers();
    let status: "active" | "pending" | null = "pending";
    const harness = createHarness({ completionStatus: () => status });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    status = null;
    await vi.advanceTimersByTimeAsync(16);

    expect(view.state.replaceSelection).toHaveBeenCalledWith("  ");
    expect(view.dispatch).toHaveBeenCalledOnce();
  });
});
