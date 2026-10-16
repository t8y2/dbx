import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldLineageTabState } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const QUERY_STORE_TEST_TIMEOUT = 60_000;

function makeState(overrides: Partial<FieldLineageTabState["config"]> = {}): FieldLineageTabState {
  return {
    config: {
      connectionId: "conn-1",
      database: "shop",
      schema: "public",
      table: "orders",
      column: "user_id",
      ...overrides,
    },
    sessionId: null,
  };
}

describe("queryStore field-lineage tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens a field-lineage tab, reuses it for the same field, and merges the session id",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openFieldLineage(makeState());
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.mode).toBe("field-lineage");
      expect(tab?.connectionId).toBe("conn-1");
      expect(tab?.title).toContain("public.orders.user_id");

      const secondId = store.openFieldLineage({ ...makeState(), sessionId: "lineage-session" });
      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      expect(store.tabs.find((t) => t.id === firstId)?.fieldLineageState?.sessionId).toBe("lineage-session");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens distinct tabs per field (five-tuple key) and normalizes schema",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const id1 = store.openFieldLineage(makeState());
      const id2 = store.openFieldLineage(makeState({ column: "amount" }));
      const id3 = store.openFieldLineage(makeState({ table: "users" }));
      expect(store.tabs).toHaveLength(3);
      expect(new Set([id1, id2, id3]).size).toBe(3);

      // undefined schema normalizes to the same key as empty string
      const idA = store.openFieldLineage(makeState({ connectionId: "conn-x", schema: "" }));
      const idB = store.openFieldLineage({ config: { ...makeState({ connectionId: "conn-x" }).config, schema: undefined } });
      expect(idB).toBe(idA);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates tab fieldLineageState via updateFieldLineageState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openFieldLineage(makeState());
      store.updateFieldLineageState(tabId, { ...makeState({ column: "amount" }), sessionId: "s-2" });
      const tab = store.tabs.find((t) => t.id === tabId)!;
      expect(tab.fieldLineageState?.config.column).toBe("amount");
      expect(tab.fieldLineageState?.sessionId).toBe("s-2");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
