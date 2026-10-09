// @vitest-environment happy-dom

import { computed, createApp, h, reactive, shallowRef } from "vue";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorDiagnostics } from "../useQueryEditorDiagnostics";
import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { SqlReferenceAnalysis } from "@/types/database";

const { analyze, buildDiagnostics } = vi.hoisted(() => ({ analyze: vi.fn(), buildDiagnostics: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ analyzeSqlReferences: analyze }));
vi.mock("@/lib/sql/semantic/diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sql/semantic/diagnostics")>()),
  buildSqlSemanticDiagnostics: buildDiagnostics,
}));

type Options = Parameters<typeof useQueryEditorDiagnostics>[0];
const cleanups: Array<() => void> = [];
const diagnostic: SqlSemanticDiagnostic = { message: "missing field", severity: "error", span: { start_line: 1, start_column: 8, end_line: 1, end_column: 15 } };

beforeEach(() => {
  vi.useFakeTimers();
  analyze.mockResolvedValue({ tables: [], columns: [] });
  buildDiagnostics.mockReturnValue([diagnostic]);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT missing;", databaseType: "mysql", dialect: "mysql", connectionId: "connection", database: "demo", ...overrides });
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc: props.modelValue }) });
  const view = shallowRef<EditorView | null>(currentView);
  const runtime: Options["runtime"] = { editorIsActive: true, executableStatementRangeCache: null, setSqlDiagnosticsEffect: StateEffect.define<SqlSemanticDiagnostic[]>(), diagnosticComp: null, buildSqlDiagnosticExtension: null, codeMirrorCompletionStatus: () => null };
  const settingsStore = { editorSettings: { sqlSemanticDiagnosticsEnabled: true } } as Options["settingsStore"];
  let diagnostics!: ReturnType<typeof useQueryEditorDiagnostics>;
  const host = document.createElement("div");
  const app = createApp({
    setup() {
      diagnostics = useQueryEditorDiagnostics({
        props,
        view,
        runtime,
        settingsStore,
        connectionStore: { connectionIdentifierQuote: () => "`" } as Options["connectionStore"],
        sqlDriverProfile: computed(() => undefined),
        sqlStatementParameterOptions: () => ({}),
        sqlBehaviorDialect: () => props.dialect,
        semanticCompletionEnabled: false,
        maxCompletionTables: 100,
        metadata: {
          cachedTables: [],
          cachedColumnsByTable: new Map(),
          loadedColumnsByTable: new Set(),
          usesOracleSessionCompletionColumns: () => false,
          findExactSemanticDiagnosticTable: vi.fn().mockResolvedValue(null),
          completionCacheKey: (table) => table.name,
          ensureColumnsForTable: vi.fn().mockResolvedValue(false),
          isMissingTableMetadataError: () => false,
        },
      });
      return () => h("div");
    },
  });
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
  };
  cleanups.push(() => {
    unmount();
    currentView.destroy();
    parent.remove();
  });
  return { diagnostics, props, runtime, settingsStore, currentView, unmount };
}

describe("QueryEditor diagnostic scheduling ownership", () => {
  it("coalesces timers and shares the latest executable statement cache", async () => {
    const { diagnostics, currentView, runtime } = createHarness();
    diagnostics.scheduleSemanticDiagnostics(50);
    diagnostics.scheduleSemanticDiagnostics(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(analyze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(analyze).toHaveBeenCalledOnce();
    expect(diagnostics.diagnostics).toEqual([diagnostic]);
    expect(runtime.executableStatementRangeCache).not.toBeNull();
    const cache = runtime.executableStatementRangeCache;
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.executableStatementRangeCache).toBe(cache);
    expect(currentView.state.doc.toString()).toBe("SELECT missing;");
  });

  it("clears old decorations and pending work when SQL diagnostics are disabled", async () => {
    const { diagnostics, settingsStore } = createHarness();
    diagnostics.setSemanticDiagnostics([diagnostic]);
    diagnostics.scheduleSemanticDiagnostics(10);
    settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled = false;
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(diagnostics.diagnostics).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("does not schedule work while the editor is inactive", async () => {
    const { diagnostics, runtime } = createHarness();
    runtime.editorIsActive = false;
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([{ connectionId: undefined }, { database: undefined }, { modelValue: "  " }, { databaseType: "elasticsearch" as const }])("clears diagnostics without SQL analysis for unsupported context %j", async (overrides) => {
    const { diagnostics } = createHarness(overrides);
    diagnostics.setSemanticDiagnostics([diagnostic]);
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.diagnostics).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects an old analysis after document invalidation", async () => {
    let resolve!: (analysis: SqlReferenceAnalysis) => void;
    analyze.mockImplementationOnce(
      () =>
        new Promise<SqlReferenceAnalysis>((done) => {
          resolve = done;
        }),
    );
    const { diagnostics, currentView } = createHarness();
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledOnce();
    currentView.dispatch({ changes: { from: 0, to: currentView.state.doc.length, insert: "SELECT 1;" } });
    diagnostics.invalidateSemanticDiagnosticsForDocumentChange();
    resolve({ tables: [], columns: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(buildDiagnostics).not.toHaveBeenCalled();
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("invalidates in-flight analysis on unmount and cancels scheduled work", async () => {
    let resolve!: (analysis: SqlReferenceAnalysis) => void;
    analyze.mockImplementationOnce(
      () =>
        new Promise<SqlReferenceAnalysis>((done) => {
          resolve = done;
        }),
    );
    const { diagnostics, unmount, currentView } = createHarness();
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    diagnostics.scheduleSemanticDiagnostics(500);
    unmount();
    const dispatch = vi.spyOn(currentView, "dispatch");
    resolve({ tables: [], columns: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(analyze).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(buildDiagnostics).not.toHaveBeenCalled();
  });

  it.each([
    { databaseType: "redis" as const, modelValue: "GET" },
    { databaseType: "mongodb" as const, modelValue: "db.users.unknownMethod()" },
  ])("preserves native diagnostics with SQL diagnostics disabled for $databaseType", async (overrides) => {
    const { diagnostics, settingsStore } = createHarness(overrides);
    settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled = false;
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.diagnostics.length).toBeGreaterThan(0);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps unfinished MongoDB expressions under the cursor free of premature errors", async () => {
    const { diagnostics } = createHarness({ databaseType: "mongodb", modelValue: "db.users.find({" });
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.diagnostics).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps completed MongoDB warnings while the cursor is in a later unfinished command", async () => {
    const sql = "db.a.deleteMany({});\ndb.b.find({";
    const { diagnostics, currentView } = createHarness({ databaseType: "mongodb", modelValue: sql });
    currentView.dispatch({ selection: { anchor: sql.length } });
    diagnostics.scheduleSemanticDiagnostics(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.diagnostics).toHaveLength(1);
    expect(diagnostics.diagnostics[0].severity).toBe("warning");
    expect(diagnostics.diagnostics[0].message).toContain("every document in a");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("does not dispatch unchanged diagnostics or rewrite editor selection", () => {
    const { diagnostics, currentView } = createHarness();
    currentView.dispatch({ selection: { anchor: 3 } });
    const dispatch = vi.spyOn(currentView, "dispatch");
    diagnostics.setSemanticDiagnostics([diagnostic]);
    diagnostics.setSemanticDiagnostics([structuredClone(diagnostic)]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty("selection");
    expect(currentView.state.selection.main.head).toBe(3);
  });
});
