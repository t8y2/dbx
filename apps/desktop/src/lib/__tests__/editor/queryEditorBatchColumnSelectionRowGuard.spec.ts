// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression coverage for #9433: clicking anywhere in a batch-selection
// completion row other than the checkbox itself used to fall through to
// CodeMirror's own list-item click handler, which applied that single row
// as the completion and silently discarded every other checked field. See
// onBatchColumnSelectionRowGuard in useQueryEditorBatchSelection.ts.
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
  throw new Error(`Unterminated QueryEditor function: ${name}`);
}

interface FakeMouseEvent {
  button: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
  type: "mousedown" | "click";
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface RowGuardHarness {
  onBatchColumnSelectionRowGuard: (event: FakeMouseEvent) => void;
  setSession: (session: { key: string; candidates: Array<{ key: string; apply: string }>; selectedKeys: Set<string> }) => void;
  registerCheckbox: (checkbox: Element, marker: { sessionKey: string; candidateKey: string }) => void;
  getSelectedKeys: () => Set<string>;
}

function createHarness(view: { value: unknown }): RowGuardHarness {
  const source = [
    "let batchColumnSelectionSession = null;",
    "const batchColumnSelectionCheckboxMarkers = new WeakMap();",
    extractFunction("batchColumnSelectionMarkerAtPoint"),
    extractFunction("setBatchColumnSelectionValue"),
    // The row guard delegates to these for the label refresh and the
    // virtualized-list reopen; neither affects the toggle decision under
    // test, so they're stubbed instead of dragging in their own DOM/timer
    // machinery.
    "function updateBatchColumnSelectionActionLabel() {}",
    "function scheduleBatchColumnSelectionRefresh() {}",
    extractFunction("toggleBatchColumnSelection"),
    extractFunction("onBatchColumnSelectionRowGuard"),
  ].join("\n");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = new Function(
    "view",
    `${javascript}
return {
  onBatchColumnSelectionRowGuard,
  setSession: (session) => { batchColumnSelectionSession = session; },
  registerCheckbox: (checkbox, marker) => batchColumnSelectionCheckboxMarkers.set(checkbox, marker),
  getSelectedKeys: () => batchColumnSelectionSession.selectedKeys,
};`,
  );
  return factory(view) as RowGuardHarness;
}

function createCompletionRow(label: string) {
  const li = document.createElement("li");
  li.setAttribute("role", "option");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "cm-batch-column-selection-checkbox";
  li.appendChild(checkbox);
  const span = document.createElement("span");
  span.className = "cm-completionLabel";
  span.textContent = label;
  li.appendChild(span);
  return { li, checkbox, label: span };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onBatchColumnSelectionRowGuard (#9433)", () => {
  it("adds the clicked row to the selection instead of letting CodeMirror apply it alone", () => {
    const harness = createHarness({ value: {} });
    const session = {
      key: "select\u0000wide_table",
      candidates: [
        { key: "c1", apply: "col_01" },
        { key: "c2", apply: "col_02" },
        { key: "c3", apply: "col_03" },
      ],
      selectedKeys: new Set(["c1", "c2"]),
    };
    harness.setSession(session);

    const row = createCompletionRow("col_03");
    harness.registerCheckbox(row.checkbox, { sessionKey: session.key, candidateKey: "c3" });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(row.label);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    harness.onBatchColumnSelectionRowGuard({ button: 0, target: row.label, clientX: 10, clientY: 20, type: "mousedown", preventDefault, stopPropagation });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    // Before the fix, applying this row as CodeMirror's default single
    // completion would replace the selection with just {c3}.
    expect(harness.getSelectedKeys()).toEqual(new Set(["c1", "c2", "c3"]));
  });

  it("steps aside for a click on the checkbox itself", () => {
    const harness = createHarness({ value: {} });
    const session = { key: "s1", candidates: [{ key: "c1", apply: "col_01" }], selectedKeys: new Set<string>() };
    harness.setSession(session);

    const row = createCompletionRow("col_01");
    harness.registerCheckbox(row.checkbox, { sessionKey: "s1", candidateKey: "c1" });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    harness.onBatchColumnSelectionRowGuard({ button: 0, target: row.checkbox, clientX: 10, clientY: 20, type: "mousedown", preventDefault, stopPropagation });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(harness.getSelectedKeys().size).toBe(0);
  });

  it("no-ops when no batch selection session is active", () => {
    const harness = createHarness({ value: {} });
    const row = createCompletionRow("SELECT");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(row.label);

    const preventDefault = vi.fn();
    harness.onBatchColumnSelectionRowGuard({ button: 0, target: row.label, clientX: 0, clientY: 0, type: "mousedown", preventDefault, stopPropagation: vi.fn() });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
