// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { reactive, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorCompletionMetadata } from "../useQueryEditorCompletionMetadata";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sql/sqlCompletion";

vi.mock("@/stores/connectionStore", () => ({ COMPLETION_METADATA_CONCURRENCY: 4 }));
vi.mock("@/lib/backend/api", () => ({}));

type Options = Parameters<typeof useQueryEditorCompletionMetadata>[0];
const columns: SqlCompletionColumn[] = [{ name: "id", table: "users", dataType: "int" }];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT id FROM users", databaseType: "postgres", dialect: "postgres", connectionId: "connection", database: "demo", schema: "public", ...overrides });
  const store = {
    getConfig: vi.fn(() => undefined),
    lookupLocalCompletionColumns: vi.fn((): SqlCompletionColumn[] => []),
    listCompletionColumns: vi.fn(async (): Promise<SqlCompletionColumn[]> => []),
    lookupLocalCompletionTables: vi.fn((): SqlCompletionTable[] => []),
    listCompletionTables: vi.fn(async (): Promise<SqlCompletionTable[]> => []),
  };
  const metadata = useQueryEditorCompletionMetadata({
    props,
    view: shallowRef<EditorView | null>(null),
    connectionStore: store as unknown as Options["connectionStore"],
    sqlBehaviorDialect: () => props.dialect,
    remoteLatencyBudgetMs: 40,
    maxCompletionTables: 100,
    onDemandMinPrefix: 2,
    semanticCompletionEnabled: true,
  });
  return { metadata, store, props };
}

describe("QueryEditor completion metadata ownership", () => {
  it.each(["getEditorSqlCompletionContext", "getEditorSemanticModel"] as const)("keys %s by document, editor state, position and dialect", (method) => {
    const { metadata, props } = createHarness();
    const state = EditorState.create({ doc: props.modelValue });
    const first = metadata[method](props.modelValue, 8, state);
    expect(first).not.toBeNull();
    expect(metadata[method](props.modelValue, 8, state)).toBe(first);
    const moved = metadata[method](props.modelValue, 9, state);
    expect(moved).not.toBe(first);
    const selected = state.update({ selection: { anchor: 3 } }).state;
    expect(selected.doc).toBe(state.doc);
    expect(metadata[method](props.modelValue, 9, selected)).not.toBe(moved);
    props.dialect = "mysql";
    const changedDialect = metadata[method](props.modelValue, 9, selected);
    expect(metadata[method](props.modelValue, 9, selected)).toBe(changedDialect);
    props.databaseType = "mysql";
    expect(metadata[method](props.modelValue, 9, selected)).not.toBe(changedDialect);
    const edited = state.update({ changes: { from: 0, insert: " " } }).state;
    expect(metadata[method](edited.doc.toString(), 9, edited)).not.toBe(first);
  });

  it("prefers local columns and shares successful loads with subsequent callers", async () => {
    const { metadata, store } = createHarness();
    store.lookupLocalCompletionColumns.mockReturnValue(columns);
    expect(await metadata.ensureColumnsForTable({ name: "users" })).toBe(true);
    expect(metadata.cachedColumnsByTable.get("public.users")).toBe(columns);
    expect(metadata.loadedColumnsByTable.has("public.users")).toBe(true);
    expect(metadata.getInsertValueHintTableColumns("users")).toEqual(["id"]);
    await metadata.ensureColumnsForTable({ name: "users" });
    expect(store.lookupLocalCompletionColumns).toHaveBeenCalledOnce();
    expect(store.listCompletionColumns).not.toHaveBeenCalled();
  });

  it("retries empty remote responses rather than marking them as loaded", async () => {
    const { metadata, store } = createHarness();
    store.listCompletionColumns.mockResolvedValueOnce([]).mockResolvedValueOnce(columns);
    await metadata.ensureColumnsForTable({ name: "users" });
    expect(metadata.cachedColumnsByTable.has("public.users")).toBe(false);
    expect(metadata.loadedColumnsByTable.size).toBe(0);
    await metadata.ensureColumnsForTable({ name: "users" });
    expect(store.listCompletionColumns).toHaveBeenCalledTimes(2);
    expect(metadata.cachedColumnsByTable.get("public.users")).toBe(columns);
  });

  it("isolates quoted names and prefix caches by table and schema", () => {
    const { metadata } = createHarness();
    const table = { name: "users", schema: "public" };
    expect(metadata.completionCacheKey({ ...table, nameQuoted: true })).not.toBe(metadata.completionCacheKey(table));
    metadata.cachedPrefixColumnsByTable.set(metadata.completionPrefixCacheKey(table, undefined, "us"), [
      { name: "user_id", table: "users" },
      { name: "username", table: "users" },
    ]);
    expect(metadata.lookupCachedPrefixColumns(table, undefined, " USER_ ")).toEqual([{ name: "user_id", table: "users" }]);
    expect(metadata.lookupCachedPrefixColumns({ ...table, schema: "archive" }, undefined, "user_")).toBeUndefined();
  });

  it("returns local tables within the latency budget but still merges scoped remote metadata", async () => {
    vi.useFakeTimers();
    const { metadata, store } = createHarness({ catalog: "catalog" });
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "local", schema: "public" }]);
    let resolve!: (tables: SqlCompletionTable[]) => void;
    store.listCompletionTables.mockReturnValue(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const loading = metadata.listCompletionTablesWithLatencyBudget("connection", "demo", "", 100, "public");
    await vi.advanceTimersByTimeAsync(40);
    expect(await loading).toEqual([{ name: "local", schema: "public", database: "demo", catalog: "catalog" }]);
    resolve([{ name: "remote", schema: "public" }]);
    await Promise.resolve();
    expect(metadata.cachedTables).toEqual([{ name: "remote", schema: "public", database: "demo", catalog: "catalog" }]);
  });

  it("clears shared maps in place and exposes replacement table arrays live", async () => {
    const { metadata, store } = createHarness();
    const cachedColumns = metadata.cachedColumnsByTable;
    store.lookupLocalCompletionColumns.mockReturnValue(columns);
    await metadata.ensureColumnsForTable({ name: "users" });
    metadata.cachedTables = [{ name: "users" }];
    metadata.cachedPrefixColumnsByTable.set("prefix", columns);
    metadata.cachedForeignKeysByTable.set("table", []);
    metadata.cachedCompletionObjectsByScope.set("scope", []);
    expect(metadata.cachedTables).toEqual([{ name: "users" }]);
    metadata.refreshCompletionCache();
    expect(metadata.cachedColumnsByTable).toBe(cachedColumns);
    expect(cachedColumns.size).toBe(0);
    expect(metadata.cachedPrefixColumnsByTable.size).toBe(0);
    expect(metadata.cachedForeignKeysByTable.size).toBe(0);
    expect(metadata.cachedCompletionObjectsByScope.size).toBe(0);
    expect(metadata.loadedColumnsByTable.size).toBe(0);
    expect(metadata.cachedTables).toEqual([]);
  });
});
