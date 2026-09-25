// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import type { DatabaseType, TreeNode } from "@/types/database";
import { clearElasticsearchIndexLoading, showClearElasticsearchIndexConfirm, sidebarDangerTarget } from "@/components/sidebar/sidebarTreeDialogState";
import { ELASTICSEARCH_INDEX_CLEARED_EVENT } from "@/lib/sidebar/elasticsearchIndexActions";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  elasticsearchDeleteAllDocuments: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({}),
}));

vi.mock("@/lib/backend/api", () => ({
  elasticsearchDeleteAllDocuments: (...args: unknown[]) => mocks.elasticsearchDeleteAllDocuments(...args),
  mongoListIndexSpecs: vi.fn(),
  mongoCreateIndex: vi.fn(),
  mongoCloneCollection: vi.fn(),
  mongoDropCollection: vi.fn(),
  mongoDropDatabase: vi.fn(),
  mongoDropIndexes: vi.fn(),
  mongoRenameCollection: vi.fn(),
  nacosCreateNamespace: vi.fn(),
  nacosUpdateNamespace: vi.fn(),
  redisFlushDb: vi.fn(),
}));

vi.mock("@/lib/sidebar/sidebarActionTarget", () => ({
  findSidebarActionTarget: () => null,
}));

import { useSidebarDatabaseSpecificMutationRuntime } from "@/composables/useSidebarDatabaseSpecificMutationRuntime";

function config(dbType: DatabaseType, production = false) {
  return { id: "conn-1", name: "Search", db_type: dbType, host: "localhost", port: 9200, username: "", password: "", is_production: production };
}

function indexNode(label = "orders"): TreeNode {
  return { id: `conn-1:__collection:${label}`, label, type: "elasticsearch-index", connectionId: "conn-1", database: "default", isExpanded: false };
}

function clearResult(overrides: Record<string, unknown> = {}) {
  return { total: 3, deleted: 3, versionConflicts: 0, timedOut: false, failures: [], ...overrides };
}

function runtime(node: TreeNode) {
  return useSidebarDatabaseSpecificMutationRuntime({
    activeNode: shallowRef(node),
    connectionStore: { getConfig: mocks.getConfig, ensureConnected: mocks.ensureConnected } as any,
  });
}

describe("Elasticsearch index sidebar mutations", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.elasticsearchDeleteAllDocuments.mockResolvedValue(clearResult());
    sidebarDangerTarget.value = null;
    showClearElasticsearchIndexConfirm.value = false;
    clearElasticsearchIndexLoading.value = false;
  });

  it("offers the index actions only on Elasticsearch-protocol connections", () => {
    for (const dbType of ["elasticsearch", "easysearch"] as const) {
      mocks.getConfig.mockReturnValue(config(dbType));
      expect(runtime(indexNode()).canManageElasticsearchIndex.value, dbType).toBe(true);
    }
    // Meilisearch reuses the elasticsearch-index node type but has its own API.
    mocks.getConfig.mockReturnValue(config("meilisearch"));
    expect(runtime(indexNode()).canManageElasticsearchIndex.value).toBe(false);
  });

  it("clears documents for the index and reports the deleted count", async () => {
    mocks.getConfig.mockReturnValue(config("elasticsearch"));
    const cleared = vi.fn();
    window.addEventListener(ELASTICSEARCH_INDEX_CLEARED_EVENT, cleared);
    const feature = runtime(indexNode());

    feature.clearElasticsearchIndex();
    expect(showClearElasticsearchIndexConfirm.value).toBe(true);

    await feature.confirmClearElasticsearchIndex();
    window.removeEventListener(ELASTICSEARCH_INDEX_CLEARED_EVENT, cleared);

    expect(mocks.ensureConnected).toHaveBeenCalledWith("conn-1");
    expect(mocks.elasticsearchDeleteAllDocuments).toHaveBeenCalledWith("conn-1", "orders");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("elasticsearchClearIndexDone"), expect.anything());
    // An open document browser has to learn the rows are gone.
    expect(cleared).toHaveBeenCalledTimes(1);
    const clearedEvent = cleared.mock.calls[0]![0] as CustomEvent;
    expect(clearedEvent.detail).toEqual({ connectionId: "conn-1", index: "orders" });
    expect(clearElasticsearchIndexLoading.value).toBe(false);
  });

  it("reports a partial clear rather than success when documents survive", async () => {
    mocks.getConfig.mockReturnValue(config("elasticsearch"));
    mocks.elasticsearchDeleteAllDocuments.mockResolvedValue(clearResult({ total: 10, deleted: 8, versionConflicts: 2 }));
    const feature = runtime(indexNode());

    await feature.confirmClearElasticsearchIndex();

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("elasticsearchClearIndexPartial"), expect.anything());
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("elasticsearchClearIndexDone"), expect.anything());
  });

  it("never clears a Meilisearch index through the Elasticsearch path", async () => {
    mocks.getConfig.mockReturnValue(config("meilisearch"));

    await runtime(indexNode()).confirmClearElasticsearchIndex();

    expect(mocks.elasticsearchDeleteAllDocuments).not.toHaveBeenCalled();
  });

  it("does not clear when production confirmation is cancelled", async () => {
    mocks.getConfig.mockReturnValue(config("elasticsearch", true));
    const feature = runtime(indexNode());

    const pending = feature.confirmClearElasticsearchIndex();
    await Promise.resolve();
    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    useProductionSafetyStore().cancel();
    await pending;

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.elasticsearchDeleteAllDocuments).not.toHaveBeenCalled();
  });

  it("surfaces a backend failure and releases the loading state", async () => {
    mocks.getConfig.mockReturnValue(config("elasticsearch"));
    mocks.elasticsearchDeleteAllDocuments.mockRejectedValue(new Error("index_not_found_exception"));
    const feature = runtime(indexNode());

    await feature.confirmClearElasticsearchIndex();

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("contextMenu.tableOperationFailed"), expect.anything());
    expect(clearElasticsearchIndexLoading.value).toBe(false);
  });
});
