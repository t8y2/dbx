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
  acceptCompletionOrNextSnippetField: (view: MockView) => boolean;
  clearPendingCompletionTab: () => void;
}

function createHarness(options: { completionStatus: (state: MockState) => "active" | "pending" | null; acceptCompletion?: (view: MockView) => boolean; nextSnippetField?: (view: MockView) => boolean; indentMore?: (view: MockView) => boolean }): TabHarness {
  const source = [
    extractDeclaration(/const COMPLETION_REMOTE_LATENCY_BUDGET_MS = \d+;/, "remote completion latency budget"),
    extractDeclaration(/const COMPLETION_DEBOUNCE_DELAY_MS = \d+;/, "completion debounce delay"),
    extractDeclaration(/const COMPLETION_TAB_RETRY_DELAY_MS = \d+;/, "completion retry delay"),
    extractDeclaration(/const COMPLETION_TAB_MAX_WAIT_MS = [^;]+;/, "completion wait timeout"),
    "let pendingCompletionTabTimer: ReturnType<typeof setTimeout> | null = null;",
    extractFunction("editorIndentUnit"),
    extractFunction("handleTab"),
    extractFunction("performNormalTab"),
    extractFunction("acceptCompletionOrNextSnippetField"),
    extractFunction("clearPendingCompletionTab"),
    extractFunction("waitForCompletionTab"),
  ].join("\n");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = new Function("codeMirrorCompletionStatus", "codeMirrorAcceptCompletion", "codeMirrorNextSnippetField", "codeMirrorIndentMore", "settingsStore", `${javascript}\nreturn { handleTab, acceptCompletionOrNextSnippetField, clearPendingCompletionTab };`);
  return factory(options.completionStatus, options.acceptCompletion ?? (() => false), options.nextSnippetField ?? (() => false), options.indentMore ?? (() => false), { editorSettings: { sqlFormatter: { useTabs: false, tabWidth: 2 } } }) as TabHarness;
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

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    expect(nextSnippetField).toHaveBeenCalledWith(view);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("advances an available snippet field immediately while completion is pending", () => {
    vi.useFakeTimers();
    const nextSnippetField = vi.fn(() => true);
    const indentMore = vi.fn(() => true);
    const harness = createHarness({ completionStatus: () => "pending", nextSnippetField, indentMore });
    const view = createView();

    expect(harness.acceptCompletionOrNextSnippetField(view)).toBe(true);
    expect(nextSnippetField).toHaveBeenCalledWith(view);
    expect(vi.getTimerCount()).toBe(0);
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
