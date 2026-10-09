// @vitest-environment happy-dom

import { CompletionContext, insertCompletionText, snippetCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computed, reactive, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorCompletion } from "../useQueryEditorCompletion";
import { useQueryEditorCompletionMetadata } from "../useQueryEditorCompletionMetadata";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { RedisCommandDocumentation } from "@/lib/redis/redisCommandDocs";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { analyzeSqlCompletion, type SqlCompletionAnalysisResult } from "@/lib/sql/sqlCompletionAnalysis";

vi.mock("@/stores/connectionStore", () => ({ COMPLETION_METADATA_CONCURRENCY: 4 }));
vi.mock("@/lib/backend/api", () => ({}));

type Options = Parameters<typeof useQueryEditorCompletion>[0];
const cleanups: Array<() => void> = [];
const commands: RedisCommandDocumentation[] = [
  { name: "GET", arity: 2, keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }] },
  { name: "CUSTOM.SERVER.COMMAND", keySpecs: [] },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<QueryEditorProps> = {}, configureMetadata?: (metadata: ReturnType<typeof useQueryEditorCompletionMetadata>) => void, semanticCompletionEnabled = false) {
  const props = reactive<QueryEditorProps>({ modelValue: "SEL", databaseType: "mysql", dialect: "mysql", connectionId: "connection", database: "demo", ...overrides });
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc: props.modelValue, selection: { anchor: props.modelValue.length } }) });
  const view = shallowRef<EditorView | null>(currentView);
  const store = {
    getConfig: vi.fn(() => undefined),
    lookupLocalCompletionTables: vi.fn((): SqlCompletionTable[] => []),
    lookupLocalCompletionColumns: vi.fn(() => []),
    lookupLocalCompletionColumnsByPrefix: vi.fn(() => []),
    lookupLocalCompletionObjects: vi.fn(() => []),
    lookupLocalCompletionDatabases: vi.fn((): string[] => []),
    lookupLocalCompletionSchemas: vi.fn((): string[] => []),
    lookupLocalCompletionForeignKeys: vi.fn(() => []),
    listCompletionTables: vi.fn(async (): Promise<SqlCompletionTable[]> => []),
    listCompletionObjects: vi.fn(async () => []),
    listCompletionColumns: vi.fn(async (): Promise<SqlCompletionColumn[]> => []),
    listCompletionSchemas: vi.fn(async (): Promise<string[]> => []),
    listCompletionDatabases: vi.fn(async (): Promise<string[]> => []),
    refreshCompletionTables: vi.fn(async () => []),
    refreshCompletionColumns: vi.fn(async () => []),
    refreshCompletionSchemas: vi.fn(async () => []),
    refreshCompletionDatabases: vi.fn(async () => []),
    listRedisCompletionCommandDocs: vi.fn(async () => commands),
    listRedisCompletionKeys: vi.fn(async () => ["user:1"]),
    listMongoCompletionCollections: vi.fn(async () => ["users"]),
    listMongoCompletionFields: vi.fn(async () => []),
    listMongoCompletionIndexes: vi.fn(async () => []),
    listElasticsearchCompletionIndices: vi.fn(async () => ["users"]),
    listElasticsearchCompletionFields: vi.fn(async () => []),
  };
  const connectionStore = store as unknown as Options["connectionStore"];
  const settings = reactive({ editorSettings: { completionTriggerMode: "positional", snippets: [], sqlFormatter: { keywordCase: "upper", functionCase: "upper" }, autoAliasTables: false, tableCompletionSchemaQualification: "collision", generateSqlQuoteIdentifiers: false } });
  const metadata = useQueryEditorCompletionMetadata({ props, view, connectionStore, sqlBehaviorDialect: () => props.dialect, remoteLatencyBudgetMs: 40, maxCompletionTables: 100, onDemandMinPrefix: 2, semanticCompletionEnabled });
  configureMetadata?.(metadata);
  const startCompletion = vi.fn(() => true);
  const runtime: Options["runtime"] = { codeMirrorStartCompletion: startCompletion, codeMirrorInsertCompletionText: insertCompletionText, codeMirrorSnippetCompletion: snippetCompletion, codeMirrorCompletionStatus: () => null, imeCompositionActive: false };
  const batchSelection = {
    clearBatchColumnSelectionSession: vi.fn(),
    prepareBatchColumnSelectionSession: vi.fn(() => null),
    isBatchColumnSelectionAction: () => false,
    batchColumnSelectionMarkerForItem: () => undefined,
    cacheBatchColumnSelectionOption: (_marker: unknown, option: unknown) => option,
  } as unknown as Options["batchSelection"];
  const completion = useQueryEditorCompletion({
    props,
    view,
    connectionStore,
    settingsStore: settings as Options["settingsStore"],
    sqlDriverProfile: computed(() => undefined),
    t: ((key: string) => key) as Options["t"],
    metadata,
    batchSelection,
    runtime,
    isEditorComposing: () => runtime.imeCompositionActive,
    debounceDelayMs: 30,
    triggerDeferDelayMs: 25,
    maxCompletionTables: 100,
    onDemandTableLimit: 100,
    semanticCompletionEnabled,
  });
  cleanups.push(() => {
    completion.clearDeferredCompletionTrigger();
    completion.invalidateRequests();
    currentView.destroy();
    parent.remove();
  });
  const provide = (explicit = true) => completion.provideSqlCompletions(new CompletionContext(currentView.state, currentView.state.selection.main.head, explicit));
  return { props, currentView, view, store, settings, runtime, completion, provide, startCompletion };
}

describe.each([false, true])("Snowflake namespace completion (semantic=%s)", (semanticCompletionEnabled) => {
  beforeEach(() => vi.useRealTimers());

  function snowflakeHarness(sql: string, schema: string | undefined = "PUBLIC") {
    const harness = createHarness({ databaseType: "snowflake", dialect: "sql", database: "DEFAULT_DB", schema, modelValue: sql }, undefined, semanticCompletionEnabled);
    const catalogs: Record<string, Record<string, string[]>> = {
      DEFAULT_DB: { PUBLIC: ["DEFAULT_TABLE"] },
      OTHER_DB: { PUBLIC: ["OTHER_TABLE"] },
      ADVENTUREWORKS2025: { PUBLIC: ["DIMCUSTOMER"] },
      Other_Db: { PUBLIC: ["QUOTED_TABLE"] },
      "My.DB": { "Sales Area": ["Dim.Customer"], 'A"B': ["ESCAPED_TABLE"] },
    };
    const databases = Object.keys(catalogs);
    harness.store.listCompletionDatabases.mockResolvedValue(databases);
    harness.store.listCompletionSchemas.mockImplementation(async (...args: unknown[]) => Object.keys(catalogs[String(args[1])] ?? {}));
    harness.store.listCompletionTables.mockImplementation(async (...args: unknown[]) => (catalogs[String(args[1])]?.[String(args[4])] ?? []).map((name) => ({ name, schema: String(args[4]) })));
    return { ...harness, catalogs };
  }

  it.each(["DEFAULT_DB", "OTHER_DB", "ADVENTUREWORKS2025", "Adventureworks2025"])("lists schemas for explicit database %s with no selected schema", async (database) => {
    const { provide, store, props } = snowflakeHarness(`SELECT * FROM ${database}.`);
    props.schema = undefined;
    const result = await provide();
    expect(result?.options.map((option) => option.label)).toContain("PUBLIC");
    expect(store.listCompletionSchemas).toHaveBeenCalledWith("connection", database.toUpperCase());
    expect(result?.options.map((option) => option.label)).toEqual(["PUBLIC"]);
  });

  it.each([
    ['"Other_Db"', "Other_Db", ["PUBLIC"]],
    ['"My.DB"', "My.DB", ['A"B', "Sales Area"]],
  ] as const)("keeps the exact quoted database %s when listing schemas", async (qualifier, database, schemas) => {
    const { provide, store } = snowflakeHarness(`SELECT * FROM ${qualifier}.`);
    expect((await provide())?.options.map((option) => option.label).sort()).toEqual(schemas);
    expect(store.listCompletionSchemas).toHaveBeenCalledWith("connection", database);
  });

  it.each([
    ["DEFAULT_DB.PUBLIC", "DEFAULT_DB", "PUBLIC", "DEFAULT_TABLE"],
    ["other_db.public", "OTHER_DB", "PUBLIC", "OTHER_TABLE"],
    ["Adventureworks2025.Public", "ADVENTUREWORKS2025", "PUBLIC", "DIMCUSTOMER"],
    ['"Other_Db".PUBLIC', "Other_Db", "PUBLIC", "QUOTED_TABLE"],
    ['"My.DB"."Sales Area"', "My.DB", "Sales Area", "Dim.Customer"],
    ['"My.DB"."A""B"', "My.DB", 'A"B', "ESCAPED_TABLE"],
  ])("loads only tables in %s and preserves the typed prefix", async (qualifier, database, schema, table) => {
    const sql = `SELECT * FROM ${qualifier}.`;
    const { provide, store, currentView, settings } = snowflakeHarness(sql);
    settings.editorSettings.tableCompletionSchemaQualification = "always";
    settings.editorSettings.generateSqlQuoteIdentifiers = true;
    const result = await provide();
    expect(store.listCompletionTables.mock.calls.map((args) => (args as unknown[]).slice(0, 5))).toContainEqual(["connection", database, "", 100, schema]);
    expect(result?.options.map((option) => option.label)).toEqual([table]);
    const option = result!.options[0]!;
    if (typeof option.apply === "function") option.apply(currentView, option, result!.from, currentView.state.doc.length);
    else currentView.dispatch(insertCompletionText(currentView.state, option.apply ?? option.label, result!.from, currentView.state.doc.length));
    expect(currentView.state.doc.toString()).toBe(`${sql}${table.includes(".") ? `"${table}"` : table}`);
  });

  it.each(["collision", "always", "never"])("preserves %s schema qualification for default tables", async (setting) => {
    const { provide, settings, currentView } = snowflakeHarness("SELECT * FROM ");
    settings.editorSettings.tableCompletionSchemaQualification = setting;
    const result = (await provide())!;
    const table = result.options.find((option) => option.label === "DEFAULT_TABLE")!;
    if (typeof table.apply === "function") table.apply(currentView, table, result.from, currentView.state.doc.length);
    else currentView.dispatch(insertCompletionText(currentView.state, table.apply ?? table.label, result.from, currentView.state.doc.length));
    expect(currentView.state.doc.toString()).toBe(`SELECT * FROM ${setting === "always" ? "PUBLIC.DEFAULT_TABLE" : "DEFAULT_TABLE"}`);
  });

  it("prefers a known schema over a same-name database after uppercase folding", async () => {
    const { catalogs, provide, store } = snowflakeHarness("SELECT * FROM other_db.");
    catalogs.DEFAULT_DB!.OTHER_DB = ["SCHEMA_TABLE"];
    expect((await provide())?.options.map((option) => option.label)).toEqual(["SCHEMA_TABLE"]);
    expect(store.listCompletionSchemas).not.toHaveBeenCalledWith("connection", "OTHER_DB");
  });

  it.each(['"other_db".', '"other_db".PUBLIC.', "MISSING_DB.", '"OTHER_DB"."public".'])("does not substitute case-distinct or unknown namespaces for %s", async (qualifier) => {
    const { provide } = snowflakeHarness(`SELECT * FROM ${qualifier}`);
    expect((await provide())?.options ?? []).toEqual([]);
  });

  it.each(["empty", "denied"])("does not invent tables when explicit schema metadata is %s", async (failure) => {
    const { provide, store } = snowflakeHarness("SELECT * FROM OTHER_DB.PUBLIC.");
    if (failure === "empty") store.listCompletionTables.mockResolvedValue([]);
    else store.listCompletionTables.mockRejectedValue(new Error("permission denied"));
    expect((await provide())?.options ?? []).toEqual([]);
  });

  it("offers accessible database names alongside the default schema and tables", async () => {
    const { provide } = snowflakeHarness("SELECT * FROM ");
    expect((await provide())?.options.map((option) => option.label)).toEqual(expect.arrayContaining(["DEFAULT_DB", "OTHER_DB", "PUBLIC", "DEFAULT_TABLE"]));
  });

  it("keeps cached table metadata separate when moving between databases", async () => {
    const { provide, currentView, props } = snowflakeHarness("SELECT * FROM OTHER_DB.PUBLIC.");
    expect((await provide())?.options.map((option) => option.label)).toEqual(["OTHER_TABLE"]);
    const sql = "SELECT * FROM DEFAULT_DB.PUBLIC.";
    props.modelValue = sql;
    currentView.dispatch({ changes: { from: 0, to: currentView.state.doc.length, insert: sql }, selection: { anchor: sql.length } });
    expect((await provide())?.options.map((option) => option.label)).toEqual(["DEFAULT_TABLE"]);
    const quotedSql = 'SELECT * FROM "Other_Db".PUBLIC.';
    props.modelValue = quotedSql;
    currentView.dispatch({ changes: { from: 0, to: currentView.state.doc.length, insert: quotedSql }, selection: { anchor: quotedSql.length } });
    expect((await provide())?.options.map((option) => option.label)).toEqual(["QUOTED_TABLE"]);
  });

  it.each([false, true])("preserves the quote-identifiers preference (%s) for mixed-case table insertion", async (quoteIdentifiers) => {
    const { catalogs, provide, currentView, settings } = snowflakeHarness("SELECT * FROM ");
    catalogs.DEFAULT_DB!.PUBLIC = ["DimCustomer"];
    settings.editorSettings.generateSqlQuoteIdentifiers = quoteIdentifiers;
    settings.editorSettings.tableCompletionSchemaQualification = "always";
    const result = (await provide())!;
    const table = result.options.find((option) => option.label === "DimCustomer")!;
    if (typeof table.apply === "function") table.apply(currentView, table, result.from, currentView.state.doc.length);
    else currentView.dispatch(insertCompletionText(currentView.state, table.apply ?? table.label, result.from, currentView.state.doc.length));
    expect(currentView.state.doc.toString()).toBe(`SELECT * FROM PUBLIC.${quoteIdentifiers ? '"DimCustomer"' : "DimCustomer"}`);
  });

  it.each(["collision", "always", "never"])("preserves %s behavior when table names collide across schemas", async (setting) => {
    const { provide, store, currentView, settings } = snowflakeHarness("SELECT * FROM ");
    store.listCompletionTables.mockResolvedValue([
      { name: "SHARED", schema: "PUBLIC" },
      { name: "SHARED", schema: "SALES" },
    ]);
    settings.editorSettings.tableCompletionSchemaQualification = setting;
    const result = (await provide())!;
    const table = result.options.find((option) => option.label === "SHARED")!;
    if (typeof table.apply === "function") table.apply(currentView, table, result.from, currentView.state.doc.length);
    else currentView.dispatch(insertCompletionText(currentView.state, table.apply ?? table.label, result.from, currentView.state.doc.length));
    expect(currentView.state.doc.toString()).toBe(`SELECT * FROM ${setting === "never" ? "SHARED" : "PUBLIC.SHARED"}`);
  });

  it.each([
    ["other_db.public.other_table", "OTHER_DB", "PUBLIC", "OTHER_TABLE"],
    ['"Other_Db".PUBLIC.QUOTED_TABLE', "Other_Db", "PUBLIC", "QUOTED_TABLE"],
    ['"My.DB"."Sales Area"."Dim.Customer"', "My.DB", "Sales Area", "Dim.Customer"],
  ])("loads columns from the explicit reference %s", async (reference, database, schema, table) => {
    const { provide, store } = snowflakeHarness(`SELECT * FROM ${reference} t WHERE t.`);
    store.listCompletionColumns.mockImplementation(async (...args: unknown[]) => (args[1] === database && args[2] === table && args[3] === schema ? [{ name: "ID", table, schema, dataType: "NUMBER" }] : []));
    const result = await provide();
    expect(store.listCompletionColumns.mock.calls.map((args) => (args as unknown[]).slice(0, 4))).toContainEqual(["connection", database, table, schema]);
    expect(result?.options.map((option) => option.label)).toContain("ID");
  });

  it.each(["empty", "denied"])("does not invent schemas when metadata is %s", async (failure) => {
    const { provide, store } = snowflakeHarness("SELECT * FROM OTHER_DB.");
    if (failure === "empty") store.listCompletionSchemas.mockResolvedValue([]);
    else store.listCompletionSchemas.mockRejectedValue(new Error("permission denied"));
    expect((await provide())?.options ?? []).toEqual([]);
  });

  it("uses locally cached database and schema metadata", async () => {
    const { provide, store } = snowflakeHarness("SELECT * FROM Other_Db.");
    store.lookupLocalCompletionDatabases.mockReturnValue(["OTHER_DB"]);
    store.lookupLocalCompletionSchemas.mockImplementation((...args: unknown[]) => (args[1] === "OTHER_DB" ? ["PUBLIC"] : []));
    expect((await provide())?.options.map((option) => option.label)).toEqual(["PUBLIC"]);
    expect(store.refreshCompletionSchemas).toHaveBeenCalledWith("connection", "OTHER_DB");
  });
});

describe("QueryEditor completion provider ownership", () => {
  it.each(["cursor", "document", "view", "composition", "mode"])("rejects asynchronous analysis after a %s change", async (change) => {
    let resolve!: (result: SqlCompletionAnalysisResult) => void;
    const pending = new Promise<SqlCompletionAnalysisResult>((done) => {
      resolve = done;
    });
    const { currentView, view, runtime, settings, completion, startCompletion } = createHarness({}, (metadata) => {
      vi.spyOn(metadata, "getEditorSqlCompletionAnalysis").mockReturnValue(pending);
    });
    completion.scheduleDeferredCompletionTrigger(currentView, "L", "");
    await vi.advanceTimersByTimeAsync(25);
    expect(startCompletion).not.toHaveBeenCalled();
    if (change === "cursor") currentView.dispatch({ selection: { anchor: 0 } });
    if (change === "document") currentView.dispatch({ changes: { from: 0, insert: " " } });
    if (change === "view") view.value = null;
    if (change === "composition") runtime.imeCompositionActive = true;
    if (change === "mode") settings.editorSettings.completionTriggerMode = "manual";
    resolve(analyzeSqlCompletion({ sql: "SEL", cursor: 3, databaseType: "mysql", semanticCompletionEnabled: false }));
    await vi.advanceTimersByTimeAsync(50);
    expect(startCompletion).not.toHaveBeenCalled();
  });

  it("discards a provider result invalidated while background analysis is running", async () => {
    let resolve!: (result: SqlCompletionAnalysisResult) => void;
    const pending = new Promise<SqlCompletionAnalysisResult>((done) => {
      resolve = done;
    });
    const { provide, completion } = createHarness({}, (metadata) => {
      vi.spyOn(metadata, "getEditorSqlCompletionAnalysis").mockReturnValue(pending);
    });
    const result = provide();
    completion.invalidateRequests();
    resolve(analyzeSqlCompletion({ sql: "SEL", cursor: 3, databaseType: "mysql", semanticCompletionEnabled: false }));
    await expect(result).resolves.toBeNull();
  });
  it("keeps manual completion available while automatic completion is disabled", async () => {
    const { settings, provide, completion, currentView, startCompletion } = createHarness({ database: undefined });
    settings.editorSettings.completionTriggerMode = "manual";
    expect(await provide(false)).toBeNull();
    completion.activeOrigin = null;
    const manual = await provide(true);
    expect(manual?.options.map((option) => option.label)).toContain("SELECT");
    expect(completion.triggerSqlCompletion(currentView)).toBe(true);
    expect(startCompletion).toHaveBeenCalledWith(currentView);
  });

  it("does not request metadata or start completion during IME composition", async () => {
    const { runtime, provide, completion, currentView, store, startCompletion } = createHarness({ databaseType: "redis" });
    runtime.imeCompositionActive = true;
    expect(await provide()).toBeNull();
    expect(completion.triggerSqlCompletion(currentView)).toBe(false);
    completion.scheduleSqlCompletionStart(currentView);
    await vi.advanceTimersByTimeAsync(1);
    expect(startCompletion).not.toHaveBeenCalled();
    expect(store.listRedisCompletionCommandDocs).not.toHaveBeenCalled();
  });

  it.each(["cursor", "document", "view", "composition", "cancel"])("rejects deferred triggers after a %s change", async (change) => {
    const { currentView, view, runtime, completion, startCompletion } = createHarness();
    completion.scheduleDeferredCompletionTrigger(currentView, "L", "");
    if (change === "cursor") currentView.dispatch({ selection: { anchor: 0 } });
    if (change === "document") currentView.dispatch({ changes: { from: 0, insert: " " } });
    if (change === "view") view.value = null;
    if (change === "composition") runtime.imeCompositionActive = true;
    if (change === "cancel") completion.clearDeferredCompletionTrigger();
    await vi.advanceTimersByTimeAsync(50);
    expect(startCompletion).not.toHaveBeenCalled();
  });

  it("coalesces valid deferred input and reads late runtime initialization", async () => {
    const { currentView, runtime, completion, startCompletion } = createHarness();
    runtime.codeMirrorStartCompletion = null;
    expect(completion.triggerSqlCompletion(currentView)).toBe(false);
    completion.scheduleDeferredCompletionTrigger(currentView, "E", "");
    completion.scheduleDeferredCompletionTrigger(currentView, "L", "");
    runtime.codeMirrorStartCompletion = startCompletion;
    await vi.advanceTimersByTimeAsync(50);
    expect(startCompletion).toHaveBeenCalledOnce();
  });

  it("consumes completion suppression once and respects expiry", () => {
    const { completion } = createHarness();
    completion.suppressAutoStartUntil = Date.now() + 100;
    expect(completion.consumeSqlCompletionAutoStartSuppression()).toBe(true);
    expect(completion.consumeSqlCompletionAutoStartSuppression()).toBe(false);
    completion.suppressAutoStartUntil = Date.now() - 1;
    expect(completion.consumeSqlCompletionAutoStartSuppression()).toBe(false);
  });

  it("uses only server-provided Redis commands and never fabricates fallback metadata", async () => {
    const { store, provide } = createHarness({ databaseType: "redis", database: undefined, modelValue: "" });
    const result = await provide();
    expect(result?.options.map((option) => option.label)).toEqual(expect.arrayContaining(["GET", "CUSTOM.SERVER.COMMAND"]));
    expect(result?.options.map((option) => option.label)).not.toContain("SET");
    expect(store.listRedisCompletionCommandDocs).toHaveBeenCalledWith("connection", "0");
    expect(store.listRedisCompletionKeys).not.toHaveBeenCalled();
    store.listRedisCompletionCommandDocs.mockRejectedValue(new Error("unavailable"));
    expect(await provide()).toBeNull();
  });

  it("loads Redis keys only for a key argument with a resolved database", async () => {
    const { props, store, provide } = createHarness({ databaseType: "redis", database: "", modelValue: "GET " });
    await provide();
    expect(store.listRedisCompletionKeys).not.toHaveBeenCalled();
    props.database = "3";
    const result = await provide();
    expect(store.listRedisCompletionKeys).toHaveBeenCalledWith("connection", "3");
    expect(result?.options.map((option) => option.label)).toContain("user:1");
  });

  it("rejects stale Mongo collection loads after request invalidation", async () => {
    const { store, provide, completion } = createHarness({ databaseType: "mongodb", modelValue: "db.us" });
    let resolve!: (collections: string[]) => void;
    store.listMongoCompletionCollections.mockReturnValue(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const pending = provide();
    expect(store.listMongoCompletionCollections).toHaveBeenCalledWith("connection", "demo");
    completion.invalidateRequests();
    resolve(["users"]);
    expect(await pending).toBeNull();
    store.listMongoCompletionCollections.mockResolvedValue(["users"]);
    expect((await provide())?.options.map((option) => option.label)).toContain("users");
  });

  it.each(["mongodb", "elasticsearch", "easysearch"] as const)("preserves %s completion and tolerates metadata failures", async (databaseType) => {
    const { store, provide } = createHarness({ databaseType, modelValue: databaseType === "mongodb" ? "db.us" : "GET /us" });
    expect((await provide())?.options.map((option) => option.label)).toContain("users");
    store.listMongoCompletionCollections.mockRejectedValue(new Error("offline"));
    store.listElasticsearchCompletionIndices.mockRejectedValue(new Error("offline"));
    const fallback = await provide();
    expect(fallback?.options.some((option) => option.label === "users") ?? false).toBe(false);
  });

  it("rejects pending SQL metadata after the editor invalidates the request", async () => {
    const { store, completion, provide } = createHarness({ modelValue: "SELECT * FROM us" });
    let resolve!: (tables: SqlCompletionTable[]) => void;
    store.listCompletionTables.mockReturnValue(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const pending = provide();
    await vi.advanceTimersByTimeAsync(31);
    expect(store.listCompletionTables).toHaveBeenCalled();
    completion.invalidateRequests();
    resolve([{ name: "users" }]);
    expect(await pending).toBeNull();
  });

  it("does not double the separator when a Mongo key is re-picked in front of an existing colon", async () => {
    const accept = async (doc: string, cursor: number) => {
      const { store, provide, currentView } = createHarness({ databaseType: "mongodb", modelValue: doc });
      store.listMongoCompletionFields.mockResolvedValue([{ name: "name", type: "string" }]);
      currentView.dispatch({ selection: { anchor: cursor } });
      const result = await provide();
      const option = result?.options.find((candidate) => candidate.label === "name");
      expect(option, "the field is offered").toBeDefined();
      (option!.apply as (view: EditorView, completion: unknown, from: number, to: number) => void)(currentView, option, result!.from, cursor);
      return { doc: currentView.state.doc.toString(), cursor: currentView.state.selection.main.head };
    };

    // Editing the key of an existing entry: the colon already there is kept, not doubled.
    expect(await accept("db.users.find({ na: 1 })", 18)).toEqual({ doc: "db.users.find({ name: 1 })", cursor: 20 });
    expect(await accept("db.users.find({ na : 1 })", 18)).toEqual({ doc: "db.users.find({ name : 1 })", cursor: 20 });
    // A fresh key still gets its separator.
    expect(await accept("db.users.find({ na", 18)).toEqual({ doc: "db.users.find({ name: ", cursor: 22 });
    expect(await accept("db.users.find({ na })", 18)).toEqual({ doc: "db.users.find({ name:  })", cursor: 22 });
  });

  it("completes MongoDB index names in dropIndex and replaces closing quote", async () => {
    const doc = 'db.users.dropIndex("")';
    const cursor = doc.indexOf('""') + 1;
    const { store, provide, currentView } = createHarness({ databaseType: "mongodb", modelValue: doc });
    store.listMongoCompletionIndexes.mockResolvedValue([{ name: "email_1", keyPattern: "{ email: 1 }" }]);
    currentView.dispatch({ selection: { anchor: cursor } });
    const result = await provide();
    expect(store.listMongoCompletionIndexes).toHaveBeenCalledWith("connection", "demo", "users");
    const option = result?.options.find((candidate) => candidate.displayLabel === "email_1" || candidate.label === "email_1");
    expect(option).toBeDefined();
    expect(option?.detail).toBe("{ email: 1 }");
    (option!.apply as (view: EditorView, completion: unknown, from: number, to: number) => void)(currentView, option, result!.from, cursor);
    expect(currentView.state.doc.toString()).toBe('db.users.dropIndex("email_1")');
  });

  it.each(["redis", "mongodb", "mysql"] as const)("does not query %s metadata without a connection", async (databaseType) => {
    const { store, provide } = createHarness({ databaseType, connectionId: undefined });
    expect(await provide()).toBeNull();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
    expect(store.listMongoCompletionCollections).not.toHaveBeenCalled();
    expect(store.listRedisCompletionCommandDocs).not.toHaveBeenCalled();
  });
});
