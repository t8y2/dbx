import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferTabState } from "@/types/database";

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

function makeState(overrides: Partial<TransferTabState["config"]> = {}): TransferTabState {
  return {
    config: {
      sourceConnectionId: "conn-src",
      sourceCatalog: "cat-a",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      targetConnectionId: "conn-tgt",
      targetCatalog: "cat-b",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      objects: { TABLE: ["users"] },
      content: "structureAndData",
      strategy: "append",
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: true,
      batchSize: 1000,
      dropTargetConfirmed: false,
      ...overrides,
    } as TransferTabState["config"],
    taskId: null,
  };
}

describe("queryStore data-transfer tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens a new data-transfer tab and reuses it for the same pair, merging the task id",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openDataTransfer(makeState());
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.mode).toBe("data-transfer");
      expect(tab?.connectionId).toBe("conn-src");
      expect(tab?.title).toContain("srcdb");
      expect(store.activeTabId).toBe(firstId);

      const secondId = store.openDataTransfer({ ...makeState(), taskId: "txn-1" });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs.find((t) => t.id === firstId)?.dataTransferState?.taskId).toBe("txn-1");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens distinct tabs for different pairs and normalizes schema/catalog",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const id1 = store.openDataTransfer(makeState());
      const id2 = store.openDataTransfer(makeState({ targetDatabase: "otherdb" }));
      const id3 = store.openDataTransfer(makeState({ sourceCatalog: "cat-other" }));
      expect(store.tabs).toHaveLength(3);
      expect(new Set([id1, id2, id3]).size).toBe(3);

      // undefined schema/catalog normalize to the same key as empty string
      const idA = store.openDataTransfer(makeState({ sourceConnectionId: "conn-x", sourceSchema: "" }));
      const idB = store.openDataTransfer({
        config: { ...makeState({ sourceConnectionId: "conn-x" }).config, sourceSchema: undefined },
      });
      expect(idB).toBe(idA);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates tab dataTransferState via updateDataTransferState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openDataTransfer(makeState());
      store.updateDataTransferState(tabId, { ...makeState({ targetDatabase: "nextdb" }), taskId: "txn-9" });
      const tab = store.tabs.find((t) => t.id === tabId)!;
      expect(tab.dataTransferState?.config.targetDatabase).toBe("nextdb");
      expect(tab.dataTransferState?.taskId).toBe("txn-9");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
