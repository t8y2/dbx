// @vitest-environment happy-dom

import { createApp, h, nextTick, ref, shallowRef, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { foldedRanges, language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH, QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT } from "@/lib/editor/queryEditorLargeDocument";
import type { QueryEditorProps } from "../queryEditorTypes";

const analysisProbe = vi.hoisted(() => ({
  documentLengths: [] as number[],
  documentLineCounts: [] as number[],
  backgroundDocuments: [] as string[],
  backgroundGate: null as Promise<void> | null,
  failAtLength: Number.POSITIVE_INFINITY,
  failAtLineCount: Number.POSITIVE_INFINITY,
}));

vi.mock("@/lib/sql/executableStatementRangeCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sql/executableStatementRangeCache")>();
  return {
    ...actual,
    executableStatementRangeCacheForDoc: (...args: Parameters<typeof actual.executableStatementRangeCacheForDoc>) => {
      if (args[0]?.doc === args[1]) return actual.executableStatementRangeCacheForDoc(...args);
      analysisProbe.documentLengths.push(args[1].length);
      analysisProbe.documentLineCounts.push(args[1].lines);
      if (args[1].length >= analysisProbe.failAtLength || args[1].lines >= analysisProbe.failAtLineCount) throw new Error("unbounded statement analysis");
      return actual.executableStatementRangeCacheForDoc(...args);
    },
  };
});

vi.mock("@/lib/sql/sqlStatementAnalysisWorker", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sql/executableStatementRangeCache")>("@/lib/sql/executableStatementRangeCache");
  const { EditorState, Text } = await import("@codemirror/state");
  const langSql = await import("@codemirror/lang-sql");
  const { ensureSyntaxTree } = await import("@codemirror/language");
  const { createDbxCodeMirrorSqlDialect } = await import("@/lib/editor/codemirrorSqlDialect");
  const { computeBlockFoldRanges } = await import("@/lib/editor/codemirrorSqlBlockFolding");
  return {
    createSqlStatementAnalysisWorker: () => {
      let generation = 0;
      return {
        async analyze(request: import("@/lib/sql/sqlStatementAnalysis").SqlStatementAnalysisRequest) {
          const current = ++generation;
          analysisProbe.backgroundDocuments.push(request.sql);
          if (analysisProbe.backgroundGate) await analysisProbe.backgroundGate;
          await Promise.resolve();
          if (current !== generation) return null;
          const { doc: _doc, ...result } = actual.executableStatementRangeCacheForDoc(null, Text.of(request.sql.split("\n")), request.databaseType, request.parameterOptions);
          if (!request.includeFolds) return result;
          const state = EditorState.create({ doc: request.sql, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, request.syntaxDialect ?? "mysql", request.databaseType, request.driverProfile) })] });
          let tree = ensureSyntaxTree(state, state.doc.length, 1000);
          while (!tree) tree = ensureSyntaxTree(state, state.doc.length, 1000);
          return { ...result, folds: computeBlockFoldRanges(state, request.databaseType, tree) };
        },
        cancel() {
          generation++;
        },
        dispose() {
          generation++;
        },
      };
    },
  };
});

import QueryEditor from "../QueryEditor.vue";

function oraclePackage(procedureCount: number): string {
  const procedures = Array.from(
    { length: procedureCount },
    (_, index) => `  PROCEDURE process_order_${index}(p_order_id NUMBER) IS
    l_status VARCHAR2(30);
  BEGIN
    SELECT status INTO l_status FROM orders WHERE id = p_order_id;
    IF l_status = 'PENDING' THEN
      UPDATE orders SET status = 'PROCESSED' WHERE id = p_order_id;
    END IF;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN NULL;
  END process_order_${index};
`,
  ).join("");
  return `CREATE OR REPLACE PACKAGE BODY huge_pkg AS\n${procedures}END huge_pkg;\n/\n`;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  analysisProbe.documentLengths = [];
  analysisProbe.documentLineCounts = [];
  analysisProbe.backgroundDocuments = [];
  analysisProbe.backgroundGate = null;
  analysisProbe.failAtLength = Number.POSITIVE_INFINITY;
  analysisProbe.failAtLineCount = Number.POSITIVE_INFINITY;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function mountEditor(modelValue: string, overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const source = ref(modelValue);
  const onUpdateModelValue = vi.fn((value: string) => {
    source.value = value;
  });
  const app: App = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: source.value,
        tabId: "oracle-source",
        databaseType: "oracle",
        dialect: "postgres",
        autoFocus: false,
        ref: editor,
        "onUpdate:modelValue": onUpdateModelValue,
        ...overrides,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { editor: editor.value!, host, onUpdateModelValue, view };
}

function foldedRangeCount(view: EditorView): number {
  let count = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => count++);
  return count;
}

describe("QueryEditor large document mode", () => {
  it("keeps the full editor feature path for ordinary documents", async () => {
    const source = oraclePackage(8);
    const { host, view } = await mountEditor(source);

    expect(host.firstElementChild?.hasAttribute("data-large-document-mode")).toBe(false);
    expect(analysisProbe.documentLengths).toContain(source.length);
    expect(view.state.facet(language)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps SQL language features while bounding statement analysis above the line budget", async () => {
    const lineCount = QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT + 1;
    const source = Array.from({ length: lineCount }, (_, index) => `SELECT ${index};`).join("\n");
    expect(source.length).toBeLessThan(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH);
    analysisProbe.failAtLineCount = lineCount;

    const { host, view } = await mountEditor(source);

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(analysisProbe.documentLineCounts).not.toContain(lineCount);
    expect(view.state.facet(language)).not.toBeNull();
    expect(analysisProbe.backgroundDocuments).toContain(source);
  });

  it("waits for background fold analysis before folding a large document", async () => {
    const source = `BEGIN\n${"SELECT 1;\n".repeat(QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT)}END;`;
    let releaseBackgroundAnalysis!: () => void;
    analysisProbe.backgroundGate = new Promise<void>((resolve) => {
      releaseBackgroundAnalysis = resolve;
    });
    const { editor, view } = await mountEditor(source);

    expect(editor.foldAll()).toBe(true);
    expect(foldedRangeCount(view)).toBe(0);
    releaseBackgroundAnalysis();
    await vi.waitFor(() => expect(foldedRangeCount(view)).toBe(1), { timeout: 5000 });
    expect(editor.unfoldAll()).toBe(true);
    expect(foldedRangeCount(view)).toBe(0);
  });

  it("enters bounded mode when typing crosses the line budget", async () => {
    const source = Array.from({ length: QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT }, (_, index) => `SELECT ${index};`).join("\n");
    const { host, view } = await mountEditor(source);
    analysisProbe.documentLengths = [];
    analysisProbe.documentLineCounts = [];

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\nS" },
      selection: { anchor: view.state.doc.length + 2 },
      userEvent: "input.type",
    });
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(view.state.doc.lines).toBe(QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT + 1);
    expect(view.state.facet(language)).not.toBeNull();
    expect(analysisProbe.documentLineCounts).not.toContain(QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT + 1);
  });

  it("keeps a realistically large package editable and searchable without full-document analysis", async () => {
    const source = oraclePackage(4_000);
    expect(source.length).toBeGreaterThan(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH);
    analysisProbe.failAtLength = QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1;

    const { editor, host, onUpdateModelValue, view } = await mountEditor(source);

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(analysisProbe.documentLengths).not.toContain(source.length);
    expect(view.state.facet(language)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.sliceDoc(0, 24)).toBe(source.slice(0, 24));
    expect(editor.openSearch()).toBe(true);
    await nextTick();
    expect(host.querySelector(".editor-search-panel input")).not.toBeNull();

    view.dispatch({ changes: { from: source.length, insert: "-- edited\n" }, userEvent: "input" });
    await nextTick();
    expect(onUpdateModelValue).toHaveBeenLastCalledWith(`${source}-- edited\n`);
  });

  it("preserves read-only state when full-document analysis would fail", async () => {
    const source = oraclePackage(4_000);
    analysisProbe.failAtLength = QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1;

    const { host, view } = await mountEditor(source, { readOnly: true });

    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
    expect(analysisProbe.documentLengths).not.toContain(source.length);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
  });

  it("returns to the ordinary path after shrinking and preserves undo", async () => {
    const source = Array.from({ length: 2_001 }, (_, index) => `SELECT ${index};`).join("\n");
    const { host, view } = await mountEditor(source);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 1;" }, userEvent: "input" });
    await nextTick();
    expect(host.firstElementChild?.hasAttribute("data-large-document-mode")).toBe(false);
    expect(view.state.facet(language)).not.toBeNull();
    const { undo } = await import("@codemirror/commands");
    expect(undo(view)).toBe(true);
    await nextTick();
    expect(view.state.doc.toString()).toBe(source);
    expect(host.firstElementChild?.getAttribute("data-large-document-mode")).toBe("true");
  });
});
