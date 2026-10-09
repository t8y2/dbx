import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { restoreGlobalNavigationEntry } from "../globalNavigationExecutor";
import type { NavigationOpenOptions, NavigationTarget } from "@/composables/useNavigationTargets";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { connectionObjectTreeNodeSchema } from "@/lib/database/jdbcDialect";
import { useNavigationStore } from "@/stores/navigationStore";
import { handleTabHistoryNavigationShortcut } from "@/lib/editor/keyboardShortcuts";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";
import type { QueryTab } from "@/types/database";
import { navigationEntryKey, type GlobalNavigationEntry } from "../navigationEntry";
import * as restoreTargets from "../navigationRestoreTargets";

// Exercise App's actual recording, keyboard admission and restore functions
// without mounting its unrelated desktop services (same harness as dialog tests).
const app = parse(readFileSync(new URL("../../../App.vue", import.meta.url), "utf8"));
const source = ts.createSourceFile("App.vue.ts", app.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNames = ["currentGlobalNavigationEntry", "isGlobalNavigationEntryAvailable", "canRestoreGlobalNavigationEntry", "navigateGlobal", "completeGlobalNavigation", "restoreQueryNavigationEntry"];
const declarations = functionNames.map((name) => {
  const node = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing App function: ${name}`);
  return node.getText();
});
const javascript = ts.transpileModule(declarations.join("\n"), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;

function dataTab(id: string, tableName: string, overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id,
    title: tableName,
    connectionId: "connection",
    database: "db",
    schema: "public",
    mode: "data",
    sql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    tableMeta: { database: "db", schema: "public", tableName, tableType: "TABLE", columns: [], primaryKeys: [] },
    ...overrides,
  };
}

function harness(tabs: QueryTab[], reuseMode: DataTabReuseMode = "active-tab") {
  setActivePinia(createPinia());
  const navigationStore = useNavigationStore();
  const queryStore = reactive({
    tabs,
    activeTabId: tabs[0]?.id,
    openObjectSourceTabPending: vi.fn((target) => {
      const tab = dataTab("source-restored", "unused", { mode: "query", tableMeta: undefined, sourceView: true, sourceLoad: { startedAt: 1, request: target.request, initialEditing: target.initialEditing } });
      queryStore.tabs.push(tab);
      return tab.id;
    }),
    openTableStructure: vi.fn(),
  });
  const showSettingsPage = ref(false),
    showDriverStore = ref(false),
    showPluginCenter = ref(false);
  const activateQueryTab = vi.fn((id: string) => {
    if (!queryStore.tabs.some((tab) => tab.id === id)) return false;
    queryStore.activeTabId = id;
    showSettingsPage.value = showDriverStore.value = showPluginCenter.value = false;
    return true;
  });
  const openObjectBrowserTableTarget = vi.fn(async (target: NavigationTarget, options: NavigationOpenOptions = {}) => {
    const tab = dataTab("restored", target.tableName, { connectionId: target.connectionId, database: target.database, catalog: target.catalog, schema: target.schema });
    Object.assign(tab.tableMeta!, target);
    queryStore.tabs.push(tab);
    queryStore.activeTabId = tab.id;
    options.onOpened?.(tab.id);
  });
  const bindings = {
    ...restoreTargets,
    connectionStore: { getConfig: vi.fn(() => ({ db_type: "postgres" })) },
    connectionObjectTreeNodeSchema,
    navigationEntryKey,
    navigationStore,
    queryStore,
    nextTick,
    restoreGlobalNavigationEntry,
    activeTab: computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)),
    settingsStore: { editorSettings: { dataTabReuseMode: reuseMode } },
    sourceNavigationIdentity: new Map(),
    showSettingsPage,
    showDriverStore,
    showPluginCenter,
    settingsPageTabOpen: ref(true),
    driverStoreTabOpen: ref(true),
    pluginCenterTabOpen: ref(true),
    activateSettingsPage: () => {
      showSettingsPage.value = true;
      showDriverStore.value = showPluginCenter.value = false;
    },
    openDriverStorePage: () => {
      showDriverStore.value = true;
      showSettingsPage.value = showPluginCenter.value = false;
    },
    openPluginCenterPage: () => {
      showPluginCenter.value = true;
      showSettingsPage.value = showDriverStore.value = false;
    },
    activateQueryTab,
    openObjectBrowserTableTarget,
  };
  const functions = new Function(...Object.keys(bindings), `${javascript}\nreturn { ${functionNames.join(",")} };`)(...Object.values(bindings)) as {
    currentGlobalNavigationEntry: () => GlobalNavigationEntry;
    navigateGlobal: (direction: -1 | 1) => boolean;
    restoreQueryNavigationEntry: (entry: GlobalNavigationEntry) => Promise<boolean>;
  };
  // Use the real App watch expression and callback, including Vue's flush order.
  const recorder = source.statements.find((node) => ts.isExpressionStatement(node) && node.getText().startsWith("watch(") && node.getText().includes("navigationStore.record(entry)"));
  if (!recorder) throw new Error("Missing navigation watcher");
  const recorderJs = ts.transpileModule(recorder.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const startRecording = () => new Function(...Object.keys(bindings), "watch", "currentGlobalNavigationEntry", recorderJs)(...Object.values(bindings), watch, functions.currentGlobalNavigationEntry);
  return { ...functions, ...bindings, startRecording };
}

async function flushNavigation() {
  for (let i = 0; i < 8; i++) await nextTick();
}

function seedBack(h: ReturnType<typeof harness>, previous: GlobalNavigationEntry) {
  h.navigationStore.record(previous);
  h.navigationStore.record(h.currentGlobalNavigationEntry());
  h.startRecording();
}

describe("App navigation restore regressions", () => {
  it.each([{ pendingDataChangeCount: 1 }, { hasPendingDataEditorDraft: true }])("does not consume Back or move history when a data draft blocks restoration: %j", (draft) => {
    const h = harness([dataTab("current", "b", draft)]);
    h.navigationStore.record({ id: "a", surface: "query", kind: "data", connectionId: "connection", database: "db", schema: "public", tableName: "a" });
    h.navigationStore.record(h.currentGlobalNavigationEntry());
    const before = h.navigationStore.snapshot();
    const consumed = handleTabHistoryNavigationShortcut({ key: "ArrowLeft", altKey: true }, { navigateTabHistoryBack: "Alt+ArrowLeft" }, h.navigateGlobal, "Win32");
    expect(consumed).toBe(false);
    expect(h.navigationStore.snapshot()).toEqual(before);
    expect(h.navigationStore.restoring).toBe(false);
    expect(h.openObjectBrowserTableTarget).not.toHaveBeenCalled();
  });

  it("admits Back synchronously when the same target is already open, even with a dirty active tab", () => {
    const h = harness([dataTab("current", "b", { pendingDataChangeCount: 1 }), dataTab("previous", "a")]);
    h.navigationStore.record({ id: "a", surface: "query", kind: "data", connectionId: "connection", database: "db", schema: "public", tableName: "a" });
    h.navigationStore.record(h.currentGlobalNavigationEntry());
    expect(handleTabHistoryNavigationShortcut({ key: "ArrowLeft", altKey: true }, { navigateTabHistoryBack: "Alt+ArrowLeft" }, h.navigateGlobal, "Win32")).toBe(true);
    expect(h.navigationStore.currentIndex).toBe(0);
    expect(h.queryStore.activeTabId).toBe("previous");
  });

  it("does not consume a shortcut when all earlier tabs have been closed", () => {
    const h = harness([dataTab("current", "b")]);
    h.navigationStore.record({ id: "closed", surface: "query", kind: "query", tabId: "closed" });
    h.navigationStore.record(h.currentGlobalNavigationEntry());
    expect(h.navigateGlobal(-1)).toBe(false);
    expect(h.navigationStore.currentIndex).toBe(1);
    expect(h.openObjectBrowserTableTarget).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves sequence initialEditing=%s after loading and reopening a closed source tab", async (initialEditing) => {
    const tab = dataTab("source", "unused", { mode: "query", tableMeta: undefined, sourceView: true, sourceLoad: { startedAt: 1, initialEditing, request: { name: "SEQ_USERS", objectType: "SEQUENCE" } } });
    const h = harness([tab]);
    const pending = h.currentGlobalNavigationEntry();
    tab.sourceLoad = undefined;
    if (initialEditing) tab.objectSource = { name: "SEQ_USERS", objectType: "SEQUENCE", schema: "public" };
    const loaded = h.currentGlobalNavigationEntry();
    expect(loaded.initialEditing).toBe(initialEditing);
    expect(loaded.id).toBe(pending.id);
    h.queryStore.tabs.length = 0;
    expect(await h.restoreQueryNavigationEntry(loaded)).toBe(true);
    expect(h.queryStore.openObjectSourceTabPending).toHaveBeenCalledWith(expect.objectContaining({ initialEditing, request: { name: "SEQ_USERS", objectType: "SEQUENCE", signature: undefined } }));
  });

  it.each(["TABLE", "VIEW", "MATERIALIZED_VIEW"])("reopens data with its original %s type", async (tableType) => {
    const tab = dataTab("original", "target");
    tab.tableMeta!.tableType = tableType;
    const h = harness([tab]);
    const recorded = h.currentGlobalNavigationEntry();
    h.queryStore.tabs.length = 0;
    expect(await h.restoreQueryNavigationEntry(recorded)).toBe(true);
    expect(h.openObjectBrowserTableTarget).toHaveBeenCalledWith(expect.objectContaining({ tableName: "target", tableType }), expect.objectContaining({ onOpened: expect.any(Function) }));
  });
  it.each(["always-new", "same-table", "active-tab"] as const)("returns to the original duplicate tab in %s mode", async (mode) => {
    const h = harness([dataTab("second", "a"), dataTab("first", "a"), dataTab("other", "b")], mode);
    const target = h.currentGlobalNavigationEntry();
    h.queryStore.tabs.reverse(); // first match is now the wrong duplicate
    h.activateQueryTab("other");
    seedBack(h, target);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.activeTabId).toBe("second");
    expect(h.navigationStore.entries[h.navigationStore.currentIndex]?.tabId).toBe("second");
    expect(h.navigateGlobal(1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.activeTabId).toBe("other");
  });

  it.each(["showSettingsPage", "showDriverStore", "showPluginCenter"] as const)("leaves %s when the underlying active tab is restored", async (surface) => {
    const h = harness([dataTab("same", "a")]);
    const target = h.currentGlobalNavigationEntry();
    h[surface].value = true;
    seedBack(h, target);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h[surface].value).toBe(false);
    expect(h.queryStore.activeTabId).toBe("same");
    expect(h.navigationStore.currentIndex).toBe(0);
    expect(h.navigateGlobal(1)).toBe(true);
    await flushNavigation();
    expect(h[surface].value).toBe(true);
  });

  it.each(["dynamodb", "elasticsearch", "mongodb"])("keeps ordinary %s tabs navigable without SQL restoration", async (dbType) => {
    const h = harness([dataTab("document", "a", { mode: "mongo", tableMeta: dbType === "mongodb" ? undefined : dataTab("meta", "a").tableMeta }), dataTab("other", "b")]);
    h.connectionStore.getConfig.mockReturnValue({ db_type: dbType });
    const entry = h.currentGlobalNavigationEntry();
    expect(entry.kind).toBe("query");
    h.activateQueryTab("other");
    seedBack(h, entry);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.activeTabId).toBe("document");
    expect(h.openObjectBrowserTableTarget).not.toHaveBeenCalled();
  });

  it("restores Mongo collections A → B → A within the same tab", async () => {
    const h = harness([dataTab("mongo", "a", { mode: "mongo", sql: "a", schema: undefined })]);
    h.queryStore.tabs[0]!.tableMeta!.schema = undefined;
    h.connectionStore.getConfig.mockReturnValue({ db_type: "mongodb" });
    const a = h.currentGlobalNavigationEntry();
    expect(a.kind).toBe("data");
    h.queryStore.tabs[0]!.sql = "b";
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    h.openObjectBrowserTableTarget.mockImplementation(async (target, options) => {
      h.queryStore.tabs[0]!.sql = target.tableName;
      h.queryStore.tabs[0]!.tableMeta!.tableName = target.tableName;
      options?.onOpened?.("mongo");
    });
    seedBack(h, a);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.tabs[0]!.sql).toBe("a");
    expect(h.navigateGlobal(1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.tabs[0]!.sql).toBe("b");
  });

  it.each(["resolve", "reject"])("keeps a new user visit after a background load %s", async (outcome) => {
    const h = harness([dataTab("original", "a"), dataTab("other", "a", { connectionId: "different" })]);
    const a = h.currentGlobalNavigationEntry();
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    let finish!: () => void;
    h.openObjectBrowserTableTarget.mockImplementation(async (target, options) => {
      h.queryStore.tabs[0]!.tableMeta!.tableName = target.tableName;
      options?.onOpened?.("original");
      await new Promise<void>((resolve, reject) => {
        finish = () => (outcome === "resolve" ? resolve() : reject(new Error("late load")));
      });
    });
    seedBack(h, { ...a, tableInfoTab: "indexes" });
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.navigationStore.restoring).toBe(false); // no wait for database I/O
    h.activateQueryTab("other");
    await flushNavigation();
    const history = h.navigationStore.snapshot();
    finish();
    await flushNavigation();
    expect(h.queryStore.activeTabId).toBe("other");
    expect(h.queryStore.tabs[1]!.tableInfoTab).toBeUndefined();
    expect(h.navigationStore.snapshot()).toEqual(history);
  });

  it.each(["switch", "close", "clear"])("invalidates a pending restore after %s without rolling back newer history", async (action) => {
    const h = harness([dataTab("original", "a"), dataTab("other", "c")]);
    const a = h.currentGlobalNavigationEntry();
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    let finish!: () => void;
    h.openObjectBrowserTableTarget.mockImplementation(async (_target, options) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (options?.isCurrent?.()) throw new Error("obsolete restore still current");
    });
    seedBack(h, a);
    expect(h.navigateGlobal(-1)).toBe(true);
    if (action === "switch") h.activateQueryTab("other");
    if (action === "close") {
      h.queryStore.tabs.length = 0;
      h.queryStore.activeTabId = undefined;
    }
    if (action === "clear") h.navigationStore.clear();
    await flushNavigation();
    const history = h.navigationStore.snapshot();
    expect(h.navigationStore.restoring).toBe(false);
    finish();
    await flushNavigation();
    expect(h.navigationStore.snapshot()).toEqual(history);
  });

  it.each(["connectionId", "database", "schema", "catalog"] as const)("does not activate a same-name table from another %s", async (field) => {
    const h = harness([dataTab("original", "a"), dataTab("wrong", "a")]);
    const target = h.currentGlobalNavigationEntry();
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    if (field === "connectionId") h.queryStore.tabs[1]!.connectionId = "different";
    else {
      h.queryStore.tabs[1]![field] = "different";
      h.queryStore.tabs[1]!.tableMeta![field] = "different";
    }
    seedBack(h, target);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.queryStore.activeTabId).toBe("restored");
    expect(h.queryStore.tabs[1]!.tableInfoTab).toBeUndefined();
    expect(h.navigationStore.entries[0]).toMatchObject({ tabId: "restored", tableName: "a", connectionId: "connection", database: "db", schema: "public" });
  });

  it("accepts canonical MySQL schema when reopening a legacy history entry", async () => {
    const h = harness([dataTab("original", "a")]);
    h.connectionStore.getConfig.mockReturnValue({ db_type: "mysql" });
    h.queryStore.tabs[0]!.schema = "db";
    h.queryStore.tabs[0]!.tableMeta!.schema = "db";
    const target = h.currentGlobalNavigationEntry();
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    h.openObjectBrowserTableTarget.mockImplementation(async (_target, options) => {
      const tab = h.queryStore.tabs[0]!;
      tab.schema = undefined;
      tab.tableMeta!.schema = undefined;
      tab.tableMeta!.tableName = "a";
      options?.onOpened?.(tab.id);
    });
    seedBack(h, target);
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.navigationStore.currentIndex).toBe(0);
    expect(h.navigationStore.entries[0]?.schema).toBeUndefined();
    expect(h.navigationStore.entries[0]?.tableName).toBe("a");
  });

  it("does not let an obsolete failure undo a subsequent Back navigation", async () => {
    const h = harness([dataTab("original", "a"), dataTab("other", "c")]);
    const target = h.currentGlobalNavigationEntry();
    h.queryStore.tabs[0]!.tableMeta!.tableName = "b";
    let rejectOld!: (error: Error) => void;
    h.openObjectBrowserTableTarget.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    seedBack(h, target);
    expect(h.navigateGlobal(-1)).toBe(true);
    h.activateQueryTab("other");
    await flushNavigation();
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    const snapshot = h.navigationStore.snapshot();
    rejectOld(new Error("obsolete failure"));
    await flushNavigation();
    expect(h.navigationStore.snapshot()).toEqual(snapshot);
    expect(h.queryStore.activeTabId).toBe("original");
  });

  it("rolls back an open that fails before selecting a target", async () => {
    const h = harness([dataTab("current", "b")]);
    seedBack(h, { ...h.currentGlobalNavigationEntry(), id: "missing", tabId: "missing", tableName: "a" });
    const before = h.navigationStore.snapshot();
    h.openObjectBrowserTableTarget.mockRejectedValueOnce(new Error("cannot open"));
    expect(h.navigateGlobal(-1)).toBe(true);
    await flushNavigation();
    expect(h.navigationStore.snapshot()).toEqual(before);
    expect(h.navigationStore.restoring).toBe(false);
  });
});
