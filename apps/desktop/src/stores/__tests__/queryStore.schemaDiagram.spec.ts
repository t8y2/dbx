import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaDiagramTabState } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const QUERY_STORE_TEST_TIMEOUT = 60_000;

function diagramState(overrides: Partial<SchemaDiagramTabState["config"]> = {}): SchemaDiagramTabState {
  return { config: { connectionId: "conn-1", database: "shop", schema: "public", ...overrides } };
}

describe("queryStore schema-diagram tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens diagram tabs scoped by connection+database+schema, each with its own store scope",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openSchemaDiagram({ ...diagramState(), scopeId: undefined });
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs[0]!;
      expect(tab.mode).toBe("schema-diagram");
      expect(tab.title).toContain("shop / public");
      // The open function assigns the tab id as the scope when absent.
      expect(tab.schemaDiagramState?.scopeId).toBe(tab.id);

      const secondId = store.openSchemaDiagram({ ...diagramState({ database: "otherdb" }), scopeId: undefined });
      expect(secondId).not.toBe(firstId);
      expect(store.tabs).toHaveLength(2);
      expect(store.tabs[1]?.schemaDiagramState?.scopeId).toBe(secondId);

      // Same pair focuses the existing tab (config merge, scope preserved).
      const thirdId = store.openSchemaDiagram({ ...diagramState({ tableSearch: "order" }), scopeId: undefined });
      expect(thirdId).toBe(firstId);
      expect(store.tabs).toHaveLength(2);
      expect(store.tabs.find((t) => t.id === firstId)?.schemaDiagramState?.config.tableSearch).toBe("order");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "closing a diagram tab disposes its scoped stores; other diagrams keep theirs",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const { getActivePinia } = await import("pinia");
      const { diagramScopeStoreIds } = await import("@/lib/diagram/diagram-scope");
      const pinia = getActivePinia();
      const store = useQueryStore();

      const firstId = store.openSchemaDiagram(diagramState());
      const secondId = store.openSchemaDiagram(diagramState({ database: "otherdb" }));
      // Seed both scopes so disposal is observable through pinia._s.
      const internals = pinia as unknown as { _s: Map<string, unknown> };
      for (const tabId of [firstId, secondId]) {
        const [graphId] = diagramScopeStoreIds(tabId);
        internals._s.set(graphId, { marker: tabId });
      }

      store.closeTab(firstId);
      const [firstGraph] = diagramScopeStoreIds(firstId);
      const [secondGraph] = diagramScopeStoreIds(secondId);
      expect(internals._s.has(firstGraph)).toBe(false);
      expect(internals._s.has(secondGraph)).toBe(true);
      expect(store.tabs).toHaveLength(1);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates diagram tab state via updateSchemaDiagramState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();
      const tabId = store.openSchemaDiagram(diagramState());
      store.updateSchemaDiagramState(tabId, { ...diagramState({ tableSearch: "user" }), scopeId: tabId });
      expect(store.tabs[0]?.schemaDiagramState?.config.tableSearch).toBe("user");
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
