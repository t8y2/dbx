import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseDocsTabState, DatabaseExportTabState, DataDictionaryTabState, DataGenerateTabState, MongoDumpTabState, MongoImportTabState } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const QUERY_STORE_TEST_TIMEOUT = 60_000;

function dictionaryState(overrides: Partial<DataDictionaryTabState["config"]> = {}): DataDictionaryTabState {
  return { config: { connectionId: "conn-1", database: "shop", schema: "public", ...overrides } };
}

function docsState(overrides: Partial<DatabaseDocsTabState["config"]> = {}): DatabaseDocsTabState {
  return { config: { connectionId: "conn-1", database: "shop", schema: "public", ...overrides } };
}

describe("queryStore dictionary and docs tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "dedupes data-dictionary tabs by connection+database+schema and merges wizard progress",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openDataDictionary(dictionaryState());
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.mode).toBe("data-dictionary");
      expect(tab?.title).toContain("shop / public");

      const secondId = store.openDataDictionary({ ...dictionaryState(), step: 2 });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs.find((t) => t.id === firstId)?.dataDictionaryState?.step).toBe(2);

      const otherId = store.openDataDictionary(dictionaryState({ database: "otherdb" }));
      expect(otherId).not.toBe(firstId);
      expect(store.tabs).toHaveLength(2);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "dedupes database-docs tabs by connection+database+schema",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openDatabaseDocs(docsState());
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0]?.mode).toBe("database-docs");
      expect(store.tabs[0]?.title).toContain("shop / public");

      const secondId = store.openDatabaseDocs(docsState());
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);

      const otherId = store.openDatabaseDocs(docsState({ schema: "other" }));
      expect(otherId).not.toBe(firstId);
      expect(store.tabs).toHaveLength(2);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "dedupes database-export tabs by connection+database and merges the export reattach key",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const exportState: DatabaseExportTabState = { config: { connectionId: "conn-1", database: "shop", schema: "public" }, exportId: null };
      const firstId = store.openDatabaseExport(exportState);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0]?.mode).toBe("database-export");
      expect(store.tabs[0]?.title).toContain("shop");

      const secondId = store.openDatabaseExport({ ...exportState, exportId: "exp-9" });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0]?.databaseExportState?.exportId).toBe("exp-9");

      // Schema is not part of the export content key (connection+database only).
      const thirdId = store.openDatabaseExport({ config: { connectionId: "conn-1", database: "otherdb", schema: "" } });
      expect(thirdId).not.toBe(firstId);
      expect(store.tabs).toHaveLength(2);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "dedupes data-generate tabs by connection+database+schema+table",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const base: DataGenerateTabState = { config: { connectionId: "conn-1", database: "shop", schema: "public", table: "orders" } };
      const firstId = store.openDataGenerate(base);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0]?.mode).toBe("data-generate");
      expect(store.tabs[0]?.title).toContain("orders");

      const secondId = store.openDataGenerate({ ...base, step: "preview" });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0]?.dataGenerateState?.step).toBe("preview");

      const otherId = store.openDataGenerate({ config: { ...base.config, table: "users" } });
      expect(otherId).not.toBe(firstId);
      expect(store.tabs).toHaveLength(2);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "dedupes mongo-import tabs by connection+database+collection and mongo-dump tabs by connection+database+mode",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const importState: MongoImportTabState = { config: { connectionId: "conn-1", database: "shop", collection: "orders" } };
      const importId = store.openMongoImport(importState);
      expect(store.openMongoImport({ ...importState, taskId: "mt-1" })).toBe(importId);
      expect(store.tabs.find((t) => t.id === importId)?.mongoImportState?.taskId).toBe("mt-1");
      const otherImport = store.openMongoImport({ config: { connectionId: "conn-1", database: "shop", collection: "users" } });
      expect(otherImport).not.toBe(importId);

      const dumpState: MongoDumpTabState = { config: { connectionId: "conn-1", database: "shop", mode: "dump" } };
      const dumpId = store.openMongoDump(dumpState);
      const restoreId = store.openMongoDump({ config: { connectionId: "conn-1", database: "shop", mode: "restore" } });
      expect(restoreId).not.toBe(dumpId);
      expect(store.tabs).toHaveLength(4);
      expect(store.tabs.find((t) => t.id === dumpId)?.mode).toBe("mongo-dump");
      expect(store.tabs.find((t) => t.id === importId)?.mode).toBe("mongo-import");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates dictionary and docs tab state via their updaters",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const dictionaryTabId = store.openDataDictionary(dictionaryState());
      store.updateDataDictionaryState(dictionaryTabId, { ...dictionaryState(), step: 3 });
      expect(store.tabs.find((t) => t.id === dictionaryTabId)?.dataDictionaryState?.step).toBe(3);

      const docsTabId = store.openDatabaseDocs(docsState());
      store.updateDatabaseDocsState(docsTabId, docsState({ database: "nextdb" }));
      expect(store.tabs.find((t) => t.id === docsTabId)?.databaseDocsState?.config.database).toBe("nextdb");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
