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
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";

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

function createHarness(overrides: Partial<QueryEditorProps> = {}) {
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
    lookupLocalCompletionDatabases: vi.fn(() => []),
    lookupLocalCompletionSchemas: vi.fn(() => []),
    lookupLocalCompletionForeignKeys: vi.fn(() => []),
    listCompletionTables: vi.fn(async (): Promise<SqlCompletionTable[]> => []),
    listCompletionObjects: vi.fn(async () => []),
    listCompletionColumns: vi.fn(async () => []),
    listCompletionSchemas: vi.fn(async () => []),
    listCompletionDatabases: vi.fn(async () => []),
    refreshCompletionTables: vi.fn(async () => []),
    refreshCompletionColumns: vi.fn(async () => []),
    refreshCompletionSchemas: vi.fn(async () => []),
    refreshCompletionDatabases: vi.fn(async () => []),
    listRedisCompletionCommandDocs: vi.fn(async () => commands),
    listRedisCompletionKeys: vi.fn(async () => ["user:1"]),
    listMongoCompletionCollections: vi.fn(async () => ["users"]),
    listMongoCompletionFields: vi.fn(async () => []),
    listElasticsearchCompletionIndices: vi.fn(async () => ["users"]),
    listElasticsearchCompletionFields: vi.fn(async () => []),
  };
  const connectionStore = store as unknown as Options["connectionStore"];
  const settings = reactive({ editorSettings: { completionTriggerMode: "positional", snippets: [], sqlFormatter: { keywordCase: "upper", functionCase: "upper" }, autoAliasTables: false, generateSqlQuoteIdentifiers: false } });
  const metadata = useQueryEditorCompletionMetadata({ props, view, connectionStore, sqlBehaviorDialect: () => props.dialect, remoteLatencyBudgetMs: 40, maxCompletionTables: 100, onDemandMinPrefix: 2, semanticCompletionEnabled: false });
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
    semanticCompletionEnabled: false,
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

describe("QueryEditor completion provider ownership", () => {
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

  it.each(["redis", "mongodb", "mysql"] as const)("does not query %s metadata without a connection", async (databaseType) => {
    const { store, provide } = createHarness({ databaseType, connectionId: undefined });
    expect(await provide()).toBeNull();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
    expect(store.listMongoCompletionCollections).not.toHaveBeenCalled();
    expect(store.listRedisCompletionCommandDocs).not.toHaveBeenCalled();
  });
});
