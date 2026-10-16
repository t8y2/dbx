import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DataCompareSessionConfig, DataCompareTableResult } from "@/composables/useDataCompareSession";
import type { DataCompareTabState } from "@/types/database";

const apiMocks = vi.hoisted(() => ({
  rollbackManualTransaction: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  rollbackManualTransaction: apiMocks.rollbackManualTransaction,
}));

const toastMocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMocks.toast }) }));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
  return data;
}

const QUERY_STORE_TEST_TIMEOUT = 60_000;

function makeConfig(overrides: Partial<DataCompareSessionConfig> = {}): DataCompareSessionConfig {
  return {
    sourceConnectionId: "conn-src",
    sourceDatabase: "srcdb",
    sourceSchema: "public",
    sourceDatabases: ["srcdb"],
    sourceSchemas: ["public"],
    sourceTables: ["users"],
    selectedSourceTables: ["users"],
    targetConnectionId: "conn-tgt",
    targetDatabase: "tgtdb",
    targetSchema: "public",
    targetDatabases: ["tgtdb"],
    targetSchemas: ["public"],
    targetTables: ["users"],
    targetTable: "users",
    keyColumnsByTable: {},
    label: "conn-src/srcdb/public → conn-tgt/tgtdb/public",
    ...overrides,
  };
}

function makeResult(sourceTable: string): DataCompareTableResult {
  return {
    sourceTable,
    targetTable: sourceTable,
    keyColumns: ["id"],
    columns: ["id"],
    columnInfo: [],
    status: "different",
    added: 1,
    removed: 0,
    modified: 0,
    sourceRowCount: 10,
    targetRowCount: 11,
    sourceTruncated: false,
    targetTruncated: false,
    rowBudget: 1000,
    diff: { added: [], removed: [], modified: [] },
    expanded: false,
    showAll: { added: false, removed: false, modified: false },
  };
}

describe("queryStore data-compare tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens a new data-compare tab with initial state",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const state: DataCompareTabState = { config: makeConfig(), results: [makeResult("users")] };
      const tabId = store.openDataCompare(state);

      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === tabId);
      expect(tab).toBeDefined();
      expect(tab?.mode).toBe("data-compare");
      expect(tab?.connectionId).toBe("conn-src");
      expect(tab?.database).toBe("srcdb");
      expect(tab?.schema).toBe("public");
      expect(tab?.dataCompareState).toStrictEqual(state);
      expect(tab?.title).toContain("conn-src/srcdb/public → conn-tgt/tgtdb/public");
      expect(store.activeTabId).toBe(tabId);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "reuses an existing data-compare tab for the same pair and merges incoming state",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openDataCompare({ config: makeConfig(), results: [makeResult("users")] });
      const secondId = store.openDataCompare({ config: makeConfig({ selectedSourceTables: ["users", "orders"] }) });

      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.dataCompareState?.config.selectedSourceTables).toEqual(["users", "orders"]);
      // incoming state without results keeps the existing results
      expect(tab?.dataCompareState?.results).toHaveLength(1);
      expect(store.activeTabId).toBe(firstId);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens distinct tabs for different pairs and normalizes schema",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const id1 = store.openDataCompare({ config: makeConfig() });
      const id2 = store.openDataCompare({ config: makeConfig({ targetDatabase: "otherdb" }) });
      const id3 = store.openDataCompare({ config: makeConfig({ sourceConnectionId: "conn-other" }) });

      expect(store.tabs).toHaveLength(3);
      expect(new Set([id1, id2, id3]).size).toBe(3);

      // undefined schema normalizes to the same key as empty-string schema
      const idA = store.openDataCompare({ config: makeConfig({ sourceConnectionId: "conn-x", sourceSchema: "" }) });
      const idB = store.openDataCompare({ config: makeConfig({ sourceConnectionId: "conn-x", sourceSchema: undefined as unknown as string }) });
      expect(idB).toBe(idA);
      expect(store.tabs).toHaveLength(4);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "rolls back and toasts when closing a data-compare tab with an active transaction",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openDataCompare({ config: makeConfig() });
      const tab = store.tabs.find((t) => t.id === tabId)!;
      tab.txnSessionId = "compare-txn";

      store.closeTab(tabId);
      await vi.waitFor(() => expect(apiMocks.rollbackManualTransaction).toHaveBeenCalledWith("compare-txn"));

      expect(store.tabs).toHaveLength(0);
      expect(toastMocks.toast).toHaveBeenCalledWith(i18n.global.t("dataCompare.transactionRolledBackOnClose"));
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates tab dataCompareState via updateDataCompareState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openDataCompare({ config: makeConfig() });
      const tab = store.tabs.find((t) => t.id === tabId)!;

      const nextState: DataCompareTabState = { config: makeConfig({ targetTable: "orders" }), results: [] };
      store.updateDataCompareState(tabId, nextState);
      expect(tab.dataCompareState).toStrictEqual(nextState);

      // non data-compare tabs are ignored
      const otherId = store.openDatabaseSearch("conn-1", "mydb");
      store.updateDataCompareState(otherId, nextState);
      const other = store.tabs.find((t) => t.id === otherId)!;
      expect(other.databaseSearchState).toBeUndefined();
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
