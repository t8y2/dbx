// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Regression coverage for #9122: the batch-selection completion list offered a
// per-field checkbox plus an "insert selected fields" row, but no way to check
// every field at once. See toggleAllBatchColumnSelection in useQueryEditorBatchSelection.ts.
// happy-dom's global URL polyfill rejects the file: scheme, so resolve the
// path with Node's own path/url helpers instead of `new URL(..., import.meta.url)`.
const queryEditorSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../components/editor/useQueryEditorBatchSelection.ts"), "utf8");

function extractFunction(name: string): string {
  const start = queryEditorSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing QueryEditor function: ${name}`);
  // The signature can carry an inline object return type (its own `{ }`)
  // before the body starts, so take the *last* brace on the signature line
  // rather than the first brace after the function name.
  const signatureEnd = queryEditorSource.indexOf("\n", start);
  const bodyStart = queryEditorSource.lastIndexOf("{", signatureEnd);
  let depth = 0;
  for (let index = bodyStart; index < queryEditorSource.length; index++) {
    const character = queryEditorSource[index];
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return queryEditorSource.slice(start, index + 1);
  }
  throw new Error("Unterminated QueryEditor function: " + name);
}

interface Session {
  key: string;
  candidates: Array<{ key: string; apply: string }>;
  selectedKeys: Set<string>;
}

interface SelectAllHarness {
  toggleAllBatchColumnSelection: (view: unknown, sessionKey: string) => void;
  setSession: (session: Session | null) => void;
  getSelectedKeys: () => Set<string>;
  refreshCalls: Array<{ sessionKey: string; focusCandidateKey: string }>;
}

function createHarness(): SelectAllHarness {
  const refreshCalls: Array<{ sessionKey: string; focusCandidateKey: string }> = [];
  const source = [
    "let batchColumnSelectionSession = null;",
    extractFunction("batchColumnSelectionAllSelected"),
    // The label refresh and list reopen are UI side effects; the selection
    // decision itself is what this spec covers.
    "function updateBatchColumnSelectionActionLabel() {}",
    "function scheduleBatchColumnSelectionRefresh(view, sessionKey, focusCandidateKey) { __onRefresh(sessionKey, focusCandidateKey); }",
    extractFunction("toggleAllBatchColumnSelection"),
  ].join("\n");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = new Function(
    "view",
    "__onRefresh",
    `${javascript}
return {
  toggleAllBatchColumnSelection,
  setSession: (session) => { batchColumnSelectionSession = session; },
  getSelectedKeys: () => batchColumnSelectionSession.selectedKeys,
};`,
  );
  const harness = factory({}, (sessionKey: string, focusCandidateKey: string) => {
    refreshCalls.push({ sessionKey, focusCandidateKey });
  }) as Omit<SelectAllHarness, "refreshCalls">;
  return Object.assign(harness, { refreshCalls });
}

function createSession(selected: string[] = []): Session {
  return {
    key: "select\u0000wide_table",
    candidates: [
      { key: "c1", apply: "col_01" },
      { key: "c2", apply: "col_02" },
      { key: "c3", apply: "col_03" },
    ],
    selectedKeys: new Set(selected),
  };
}

describe("toggleAllBatchColumnSelection (#9122)", () => {
  it("selects every candidate field when the selection is empty", () => {
    const harness = createHarness();
    const session = createSession();
    harness.setSession(session);

    harness.toggleAllBatchColumnSelection({}, session.key);

    expect(harness.getSelectedKeys()).toEqual(new Set(["c1", "c2", "c3"]));
    // The list is reopened so every rendered checkbox shows the new state.
    expect(harness.refreshCalls).toEqual([{ sessionKey: session.key, focusCandidateKey: "c1" }]);
  });

  it("selects the remaining fields when only some are checked", () => {
    const harness = createHarness();
    const session = createSession(["c2"]);
    harness.setSession(session);

    harness.toggleAllBatchColumnSelection({}, session.key);

    expect(harness.getSelectedKeys()).toEqual(new Set(["c1", "c2", "c3"]));
  });

  it("clears the selection once every field is checked", () => {
    const harness = createHarness();
    const session = createSession(["c1", "c2", "c3"]);
    harness.setSession(session);

    harness.toggleAllBatchColumnSelection({}, session.key);

    expect(harness.getSelectedKeys()).toEqual(new Set());
  });

  it("ignores a stale session key", () => {
    const harness = createHarness();
    const session = createSession(["c1"]);
    harness.setSession(session);

    harness.toggleAllBatchColumnSelection({}, "another-session");

    expect(harness.getSelectedKeys()).toEqual(new Set(["c1"]));
    expect(harness.refreshCalls).toEqual([]);
  });

  it("does not reopen the list when no session is active", () => {
    const harness = createHarness();
    harness.setSession(null);

    expect(() => harness.toggleAllBatchColumnSelection({}, "select\u0000wide_table")).not.toThrow();
    expect(harness.refreshCalls).toEqual([]);
    vi.restoreAllMocks();
  });
});
