// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { reactive, ref, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorHover } from "../useQueryEditorHover";
import { useQueryEditorCompletionMetadata } from "../useQueryEditorCompletionMetadata";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sql/sqlCompletion";

const { loadDdl, getColumns, listIndexes, getTableComment } = vi.hoisted(() => ({ loadDdl: vi.fn(), getColumns: vi.fn(), listIndexes: vi.fn(), getTableComment: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ COMPLETION_METADATA_CONCURRENCY: 4 }));
vi.mock("@/lib/backend/api", () => ({ getColumns, listIndexes, getTableComment }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: loadDdl }));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: async (_request: unknown, _facet: string, load: () => Promise<unknown>) => ({ value: await load(), cacheStatus: "remote" }) }));
type Options = Parameters<typeof useQueryEditorHover>[0];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  loadDdl.mockResolvedValue({ ddl: 'CREATE TABLE "users" ("id" INTEGER);' });
  getColumns.mockResolvedValue([{ name: "id", data_type: "INTEGER", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
  listIndexes.mockResolvedValue([]);
  getTableComment.mockResolvedValue(null);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}, semanticCompletionEnabled = false) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT * FROM users", connectionId: "connection", database: "demo", schema: "public", databaseType: "postgres", dialect: "postgres", ...overrides });
  const currentView = new EditorView({ state: EditorState.create({ doc: props.modelValue }) });
  cleanups.push(() => currentView.destroy());
  const store = {
    getConfig: vi.fn(() => undefined),
    lookupLocalCompletionTables: vi.fn((): SqlCompletionTable[] => []),
    listCompletionTables: vi.fn<Options["connectionStore"]["listCompletionTables"]>(async () => []),
    lookupLocalCompletionColumns: vi.fn((): SqlCompletionColumn[] => []),
    listCompletionColumns: vi.fn(async (): Promise<SqlCompletionColumn[]> => []),
  };
  const connectionStore = store as unknown as Options["connectionStore"];
  const metadata = useQueryEditorCompletionMetadata({ props, view: shallowRef<EditorView | null>(currentView), connectionStore, sqlBehaviorDialect: () => props.dialect, maxCompletionTables: 200, remoteLatencyBudgetMs: 40, onDemandMinPrefix: 2, semanticCompletionEnabled });
  const settings = reactive({ editorSettings: { tableHoverLookupMode: "fallback", showTableDdlHoverPreview: true, generateSqlQuoteIdentifiers: true, generateSqlIncludeDatabaseName: false, excludeDdlStorage: false, sqlFormatter: {} } });
  const contextMenuOpen = ref(false);
  const createHoverDom = vi.fn((_title: string, _detail: string, _sql?: string, _rows?: string[]) => ({ dom: document.createElement("div") }));
  const hover = useQueryEditorHover({ props, contextMenuOpen, settingsStore: settings as Options["settingsStore"], connectionStore, metadata, createHoverDom, maxCompletionTables: 200, semanticCompletionEnabled });
  const resolve = (position = props.modelValue.lastIndexOf("users") + 2) => hover.resolveSqlHoverTooltip(currentView, position);
  return { props, currentView, store, metadata, settings, contextMenuOpen, createHoverDom, resolve };
}

describe("QueryEditor hover resolution", () => {
  it.each(["connection", "database", "menu"])("does no metadata work without an available %s context", async (missing) => {
    const harness = createHarness();
    if (missing === "connection") harness.props.connectionId = undefined;
    if (missing === "database") harness.props.database = undefined;
    if (missing === "menu") harness.contextMenuOpen.value = true;
    expect(await harness.resolve()).toBeNull();
    expect(harness.store.lookupLocalCompletionTables).not.toHaveBeenCalled();
    expect(loadDdl).not.toHaveBeenCalled();
  });

  it("prefers local tables and preserves catalog scope for persisted DDL", async () => {
    const { store, metadata, resolve, createHoverDom } = createHarness({ catalog: "catalog" });
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "users", schema: "public", database: "demo", catalog: "catalog" }]);
    const tooltip = await resolve();
    expect(tooltip).not.toBeNull();
    tooltip!.create();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
    expect(loadDdl).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection", database: "demo", schema: "public", tableName: "users", catalog: "catalog" }));
    expect(metadata.cachedTables).toHaveLength(1);
    expect(createHoverDom).toHaveBeenCalledWith("users", expect.any(String), expect.stringContaining("create table"), undefined);
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("falls back from scoped to global metadata only in fallback mode", async () => {
    const { store, resolve } = createHarness();
    store.listCompletionTables.mockResolvedValueOnce([]).mockResolvedValueOnce([{ name: "users", schema: "archive" }]);
    expect(await resolve()).not.toBeNull();
    expect(store.listCompletionTables.mock.calls.map((call) => [call[4], call[5]])).toEqual([
      ["public", false],
      [undefined, true],
    ]);
    expect(loadDdl).toHaveBeenCalledWith(expect.objectContaining({ schema: "archive" }));
  });

  it("falls back to column metadata when DDL loading fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    loadDdl.mockRejectedValue(new Error("DDL unavailable"));
    listIndexes.mockRejectedValue(new Error("indexes unavailable"));
    const { store, resolve, createHoverDom } = createHarness();
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "users", schema: "public" }]);
    const tooltip = await resolve();
    tooltip!.create();
    expect(getColumns).toHaveBeenCalledWith("connection", "demo", "public", "users", undefined);
    expect(createHoverDom.mock.calls[0][2]).toContain("create table");
    expect(createHoverDom.mock.calls[0][2]).toContain("id");
    expect(createHoverDom.mock.calls[0][3]).toBeUndefined();
  });

  it("shows an explicit structure failure instead of inventing an empty DDL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    loadDdl.mockRejectedValue(new Error("offline"));
    getColumns.mockRejectedValue(new Error("offline"));
    const { store, resolve, createHoverDom } = createHarness();
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "users", schema: "public" }]);
    (await resolve())!.create();
    expect(createHoverDom).toHaveBeenCalledWith("users", expect.any(String), undefined, ["[DBX] Failed to load table structure — check connection"]);
  });

  it("suppresses a late DDL tooltip when a context menu opens during its request", async () => {
    let finish!: (result: { ddl: string }) => void;
    loadDdl.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { store, resolve, contextMenuOpen } = createHarness();
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "users", schema: "public" }]);
    const pending = resolve();
    await vi.waitFor(() => expect(loadDdl).toHaveBeenCalled());
    contextMenuOpen.value = true;
    finish({ ddl: "CREATE TABLE users (id INTEGER);" });
    expect(await pending).toBeNull();
  });

  it("keeps column hover when table DDL preview is disabled", async () => {
    const { store, settings, resolve, createHoverDom } = createHarness({ modelValue: "SELECT u.name FROM users u" });
    settings.editorSettings.showTableDdlHoverPreview = false;
    store.lookupLocalCompletionColumns.mockReturnValue([{ name: "name", table: "users", schema: "public", dataType: "varchar", comment: "Display name" }]);
    (await resolve(10))!.create();
    expect(createHoverDom).toHaveBeenCalledWith("name", "varchar", undefined, ["public.users", "Display name"]);
    expect(loadDdl).not.toHaveBeenCalled();
  });

  it("resolves CTE column origins through the shared cache before physical-table fallback", async () => {
    const sql = "WITH named_users AS (SELECT name FROM users) SELECT name FROM named_users";
    const { store, resolve, createHoverDom, metadata } = createHarness({ modelValue: sql }, true);
    store.lookupLocalCompletionColumns.mockReturnValue([{ name: "name", table: "users", schema: "public", dataType: "varchar" }]);
    (await resolve(sql.lastIndexOf("SELECT name") + 8))!.create();
    expect(createHoverDom).toHaveBeenCalledWith("name", "varchar", undefined, ["public.users"]);
    expect(metadata.cachedColumnsByTable.get("public.users")).toHaveLength(1);
    expect(store.lookupLocalCompletionTables).not.toHaveBeenCalled();
    expect(loadDdl).not.toHaveBeenCalled();
  });
});
