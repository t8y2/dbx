import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaDiffTabState } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const QUERY_STORE_TEST_TIMEOUT = 60_000;

function makeState(overrides: Partial<SchemaDiffTabState["config"]> = {}): SchemaDiffTabState {
  return {
    config: {
      sourceConnectionId: "conn-src",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      targetConnectionId: "conn-tgt",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      label: "src -> tgt",
      ...overrides,
    },
  };
}

describe("queryStore schema-diff tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens a new schema-diff tab and reuses it for the same pair",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openSchemaDiff({ ...makeState(), sessionId: "session-1" });
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.mode).toBe("schema-diff");
      expect(tab?.connectionId).toBe("conn-src");
      expect(tab?.title).toContain("src -> tgt");
      expect(store.activeTabId).toBe(firstId);

      const secondId = store.openSchemaDiff({ ...makeState(), sessionId: "session-2" });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      const merged = store.tabs.find((t) => t.id === firstId);
      expect(merged?.schemaDiffState?.sessionId).toBe("session-2");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens distinct tabs for different pairs and normalizes schema",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const id1 = store.openSchemaDiff(makeState());
      const id2 = store.openSchemaDiff(makeState({ targetDatabase: "otherdb" }));
      const id3 = store.openSchemaDiff(makeState({ sourceConnectionId: "conn-x", sourceSchema: "" }));
      const id4 = store.openSchemaDiff({ config: { ...makeState({ sourceConnectionId: "conn-x" }).config, sourceSchema: undefined } });

      expect(store.tabs).toHaveLength(3);
      expect(new Set([id1, id2, id3]).size).toBe(3);
      expect(id4).toBe(id3);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates tab schemaDiffState via updateSchemaDiffState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openSchemaDiff(makeState());
      const nextState = makeState({ targetDatabase: "nextdb" });
      store.updateSchemaDiffState(tabId, nextState);
      const tab = store.tabs.find((t) => t.id === tabId)!;
      expect(tab.schemaDiffState?.config.targetDatabase).toBe("nextdb");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
