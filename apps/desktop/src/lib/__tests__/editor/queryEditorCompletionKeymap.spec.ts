import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptSelectedCompletionWithRetry, acceptSelectedOrFirstCompletion } from "@/lib/editor/queryEditorCompletionAcceptance";
import { DEFAULT_SHORTCUT_SETTINGS, normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

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
  selection: { main: MockSelection; ranges: MockSelection[] };
  replaceSelection: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

interface MockView {
  state: MockState;
  dispatch: ReturnType<typeof vi.fn>;
}

interface TabHarness {
  handleTab: (view: MockView) => boolean;
  handleEnter: (view: MockView) => boolean;
  insertNewlineWithoutCompletion: (view: MockView) => boolean;
  acceptCompletionOrNextSnippetField: (view: MockView) => boolean;
  clearPendingCompletionTab: () => void;
  consumeSqlCompletionAutoStartSuppression: () => boolean;
}

function createHarness(options: {
  completionStatus: (state: MockState) => "active" | "pending" | null;
  acceptCompletion?: (view: MockView) => boolean;
  selectedCompletionIndex?: (state: MockState) => number | null;
  selectFirstCompletion?: (view: MockView) => boolean;
  applySelectedBatchColumnSelection?: (view: MockView) => boolean;
  closeCompletion?: (view: MockView) => boolean;
  insertNewlineKeepIndent?: (view: MockView) => boolean;
  nextSnippetField?: (view: MockView) => boolean;
  indentMore?: (view: MockView) => boolean;
  acceptCompletionShortcut?: string;
  selectFirstCompletionOnOpen?: boolean;
  imeComposing?: (view: MockView) => boolean;
}): TabHarness {
  const source = [
    extractDeclaration(/const COMPLETION_REMOTE_LATENCY_BUDGET_MS = \d+;/, "remote completion latency budget"),
    extractDeclaration(/const COMPLETION_DEBOUNCE_DELAY_MS = \d+;/, "completion debounce delay"),
    extractDeclaration(/const COMPLETION_TAB_RETRY_DELAY_MS = \d+;/, "completion retry delay"),
    extractDeclaration(/const COMPLETION_TAB_MAX_WAIT_MS = [^;]+;/, "completion wait timeout"),
    extractDeclaration(/const COMPLETION_ENTER_MAX_WAIT_MS = \d+;/, "completion Enter wait timeout"),
    "let pendingCompletionTabTimer: ReturnType<typeof setTimeout> | null = null;",
    "let cancelPendingCompletionEnter: (() => void) | null = null;",
    "let suppressNextSqlCompletionAutoStartUntil = 0;",
    extractFunction("editorIndentUnit"),
    extractFunction("handleTab"),
    extractFunction("tabKeyAcceptsCompletion"),
    extractFunction("handleTabWithoutAcceptingCompletion"),
    extractFunction("performNormalTab"),
    extractFunction("handleEnter"),
    extractFunction("clearPendingCompletionEnter"),
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
    "isBatchColumnSelectionCompletionActive",
    "codeMirrorAcceptCompletion",
    "codeMirrorSelectedCompletionIndex",
    "codeMirrorSelectFirstCompletion",
    "acceptSelectedCompletionWithRetry",
    "acceptSelectedOrFirstCompletion",
    "applySelectedBatchColumnSelection",
    "codeMirrorCloseCompletion",
    "codeMirrorInsertNewlineKeepIndent",
    "insertQueryEditorNewline",
    "codeMirrorNextSnippetField",
    "codeMirrorIndentMore",
    "settingsStore",
    "normalizeShortcutSettings",
    "shortcutToCodeMirrorKey",
    "props",
    "isEditorComposing",
    `${javascript}\nreturn { handleTab, handleEnter, insertNewlineWithoutCompletion, acceptCompletionOrNextSnippetField, clearPendingCompletionTab, consumeSqlCompletionAutoStartSuppression };`,
  );
  return factory(
    options.completionStatus,
    (status: "active" | "pending" | null) => status === "active",
    options.acceptCompletion ?? (() => false),
    options.selectedCompletionIndex ?? (() => 0),
    options.selectFirstCompletion ?? (() => false),
    acceptSelectedCompletionWithRetry,
    acceptSelectedOrFirstCompletion,
    options.applySelectedBatchColumnSelection ?? (() => false),
    options.closeCompletion ?? (() => false),
    options.insertNewlineKeepIndent ?? (() => false),
    (view: MockView, fallback: ((view: MockView) => boolean) | null | undefined) => fallback?.(view) ?? false,
    options.nextSnippetField ?? (() => false),
    options.indentMore ?? (() => false),
    {
      editorSettings: {
        sqlFormatter: { useTabs: false, tabWidth: 2 },
        shortcuts: { ...DEFAULT_SHORTCUT_SETTINGS, acceptCompletion: options.acceptCompletionShortcut ?? DEFAULT_SHORTCUT_SETTINGS.acceptCompletion },
        selectFirstCompletionOnOpen: options.selectFirstCompletionOnOpen ?? false,
      },
    },
    normalizeShortcutSettings,
    shortcutToCodeMirrorKey,
    { databaseType: "mysql" },
    options.imeComposing ?? ((view: MockView) => (view as MockView & { composing?: boolean }).composing === true || (view as MockView & { compositionStarted?: boolean }).compositionStarted === true),
  ) as TabHarness;
}

function createView(text = "SELECT", position = text.length, selectionOverrides: Partial<MockSelection> = {}, additionalRanges: MockSelection[] = []): MockView {
  const selection: MockSelection = { anchor: position, head: position, from: position, empty: true, ...selectionOverrides };
  const state: MockState = {
    doc: {
      lineAt: () => ({ from: 0, text }),
    },
    selection: { main: selection, ranges: [selection, ...additionalRanges] },
    replaceSelection: vi.fn((insert: string) => ({ insert })),
    update: vi.fn((change: unknown, options: unknown) => ({ change, options })),
  };
  return { state, dispatch: vi.fn() };
}

function createMultiLineSelectionView(text = "SELECT 1\nSELECT 2"): MockView {
  return createView(text, 0, { anchor: 0, head: text.length, from: 0, empty: false });
}

function createMixedMultiRangeView(text = "SELECT 1\nSELECT 2"): MockView {
  return createView(text, text.length, {}, [{ anchor: 0, head: 6, from: 0, empty: false }]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryEditor completion Tab keymap", () => {
  it("guards the batch INSERT snippet factory before applying", () => {
    expect(queryEditorSource).toContain('if (session.mode === "insert" && !codeMirrorSnippetCompletion)');
  });
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

  it("accepts the selected completion on Enter only in first-option mode", () => {
    const acceptCompletion = vi.fn(() => true);
    const closeCompletion = vi.fn(() => true);
    const insertNewlineKeepIndent = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", acceptCompletion, closeCompletion, insertNewlineKeepIndent, selectFirstCompletionOnOpen: true });
    const view = createView();

    expect(harness.handleEnter(view)).toBe(true);
    expect(acceptCompletion).toHaveBeenCalledWith(view);
    expect(closeCompletion).not.toHaveBeenCalled();
    expect(insertNewlineKeepIndent).not.toHaveBeenCalled();
  });

  it("lets the IME keep Enter while a composition is active instead of accepting a completion (#8029)", () => {
    const acceptCompletion = vi.fn(() => true);
    const closeCompletion = vi.fn(() => true);
    const insertNewlineKeepIndent = vi.fn(() => true);
    const harness = createHarness({
      completionStatus: () => "active",
      acceptCompletion,
      closeCompletion,
      insertNewlineKeepIndent,
      selectFirstCompletionOnOpen: true,
      imeComposing: () => true,
    });
    const view = createView();

    expect(harness.handleEnter(view)).toBe(false);
    expect(acceptCompletion).not.toHaveBeenCalled();
    expect(closeCompletion).not.toHaveBeenCalled();
    expect(insertNewlineKeepIndent).not.toHaveBeenCalled();
  });

  it("lets the IME keep Tab while a composition is active instead of accepting a completion (#8029)", () => {
    const acceptCompletion = vi.fn(() => true);
    const nextSnippetField = vi.fn(() => true);
    const harness = createHarness({
      completionStatus: () => "active",
      acceptCompletion,
      nextSnippetField,
      imeComposing: () => true,
    });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(false);
    expect(acceptCompletion).not.toHaveBeenCalled();
    expect(nextSnippetField).not.toHaveBeenCalled();
  });

  it("does not suppress later completion when Enter cannot insert a newline", () => {
    const harness = createHarness({ completionStatus: () => null, insertNewlineKeepIndent: () => false });

    expect(harness.insertNewlineWithoutCompletion(createView())).toBe(false);
    expect(harness.consumeSqlCompletionAutoStartSuppression()).toBe(false);
  });

  it("does not apply a stale batch selection after the completion popup closes", () => {
    const applySelectedBatchColumnSelection = vi.fn(() => true);
    const insertNewlineKeepIndent = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => null, applySelectedBatchColumnSelection, insertNewlineKeepIndent, acceptCompletionShortcut: "Tab" });
    const view = createView();

    expect(harness.handleEnter(view)).toBe(true);
    expect(harness.handleTab(view)).toBe(true);
    expect(applySelectedBatchColumnSelection).not.toHaveBeenCalled();
    expect(insertNewlineKeepIndent).toHaveBeenCalled();
  });

  it("applies a batch selection only while the completion popup is active", () => {
    const applySelectedBatchColumnSelection = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", applySelectedBatchColumnSelection });

    expect(harness.handleEnter(createView())).toBe(true);
    expect(applySelectedBatchColumnSelection).toHaveBeenCalledOnce();
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
    const source = [extractFunction("isBatchColumnSelectionAction"), extractFunction("completionItemsForBypassedFilter"), extractFunction("shouldBypassCompletionFilter"), extractFunction("buildCompletionResult")].join("\n");
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

  it("does not accept an open completion popup on Tab when the configured accept-completion shortcut is Enter (dbx#6236)", () => {
    const acceptCompletion = vi.fn(() => true);
    const nextSnippetField = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", acceptCompletion, nextSnippetField, acceptCompletionShortcut: "Enter" });
    const view = createView();

    expect(harness.handleTab(view)).toBe(true);
    expect(acceptCompletion).not.toHaveBeenCalled();
    expect(nextSnippetField).not.toHaveBeenCalled();
    expect(view.state.replaceSelection).toHaveBeenCalledWith("  ");
  });

  it("still accepts an open completion popup on Tab when the configured shortcut is left at its Tab default", () => {
    const acceptCompletion = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", acceptCompletion, acceptCompletionShortcut: "Tab" });
    const view = createView();

    expect(harness.handleTab(view)).toBe(true);
    expect(acceptCompletion).toHaveBeenCalledWith(view);
  });

  it("keeps indenting a multi-line selection instead of letting a completion popup hijack Tab (#5419)", () => {
    const acceptCompletion = vi.fn(() => true);
    const indentMore = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "active", acceptCompletion, indentMore });
    const view = createMultiLineSelectionView();

    expect(harness.handleTab(view)).toBe(true);
    expect(indentMore).toHaveBeenCalledWith(view);
    expect(acceptCompletion).not.toHaveBeenCalled();
  });

  it("does not let a pending completion hijack a second Tab press while indenting a selection (#5419)", async () => {
    vi.useFakeTimers();
    let status: "active" | "pending" | null = "pending";
    const acceptCompletion = vi.fn(() => true);
    const indentMore = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => status, acceptCompletion, indentMore });
    const view = createMultiLineSelectionView();

    expect(harness.handleTab(view)).toBe(true);
    status = "active";
    await vi.advanceTimersByTimeAsync(32);

    expect(indentMore).toHaveBeenCalledWith(view);
    expect(acceptCompletion).not.toHaveBeenCalled();
  });

  it("indents mixed multi-range selections instead of accepting an active completion", () => {
    const completionStatus = vi.fn(() => "active" as const);
    const acceptCompletion = vi.fn(() => true);
    const nextSnippetField = vi.fn(() => true);
    const indentMore = vi.fn(() => true);
    const harness = createHarness({ completionStatus, acceptCompletion, nextSnippetField, indentMore });
    const view = createMixedMultiRangeView();

    expect(harness.handleTab(view)).toBe(true);
    expect(indentMore).toHaveBeenCalledWith(view);
    expect(completionStatus).not.toHaveBeenCalled();
    expect(acceptCompletion).not.toHaveBeenCalled();
    expect(nextSnippetField).not.toHaveBeenCalled();
    expect(view.state.replaceSelection).not.toHaveBeenCalled();
  });

  it("does not accept or wait for completion when a mixed multi-range selection is active", async () => {
    vi.useFakeTimers();
    let status: "active" | "pending" | null = "pending";
    const completionStatus = vi.fn(() => status);
    const acceptCompletion = vi.fn(() => true);
    const harness = createHarness({ completionStatus, acceptCompletion });
    const view = createMixedMultiRangeView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(false);
    status = "active";
    await vi.advanceTimersByTimeAsync(32);

    expect(completionStatus).not.toHaveBeenCalled();
    expect(acceptCompletion).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.state.replaceSelection).not.toHaveBeenCalled();
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

  it("triggers completion on Alt+/ through the manual shortcut and skips while composing", () => {
    const source = [extractDeclaration(/const COMPLETION_DEBOUNCE_DELAY_MS = \d+;/, "completion debounce delay"), "let imeCompositionActive = false;", extractFunction("isEditorComposing"), extractFunction("triggerSqlCompletion")].join("\n");
    const javascript = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const factory = new Function("codeMirrorStartCompletion", `${javascript}\nreturn { triggerSqlCompletion, isEditorComposing };`);
    const startCompletion = vi.fn(() => true);
    const { triggerSqlCompletion } = factory(startCompletion) as {
      triggerSqlCompletion: (view: MockView) => boolean;
    };
    const view = createView();

    expect(triggerSqlCompletion(view)).toBe(true);
    expect(startCompletion).toHaveBeenCalledWith(view);

    startCompletion.mockClear();
    (view as MockView & { composing: boolean }).composing = true;
    expect(triggerSqlCompletion(view)).toBe(false);
    expect(startCompletion).not.toHaveBeenCalled();
  });
});
