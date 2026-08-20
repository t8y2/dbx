import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import {
  createNacosNamespaceDesc,
  createNacosNamespaceId,
  createNacosNamespaceLoading,
  createNacosNamespaceName,
  editNacosNamespaceDesc,
  editNacosNamespaceLoading,
  editNacosNamespaceName,
  deleteNacosNamespaceLoading,
  showCreateNacosNamespaceDialog,
  showDeleteNacosNamespaceConfirm,
  showEditNacosNamespaceDialog,
  sidebarDangerTarget,
  sidebarFormTarget,
} from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  nacosCreateNamespace: vi.fn(),
  nacosDeleteNamespace: vi.fn(),
  nacosUpdateNamespace: vi.fn(),
  notifyNacosNamespacesChanged: vi.fn(),
  loadNacosNamespaces: vi.fn(),
  updateConnection: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/backend/api", () => ({
  nacosCreateNamespace: (...args: unknown[]) => mocks.nacosCreateNamespace(...args),
  nacosDeleteNamespace: (...args: unknown[]) => mocks.nacosDeleteNamespace(...args),
  nacosUpdateNamespace: (...args: unknown[]) => mocks.nacosUpdateNamespace(...args),
}));

vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionContextGuard: vi.fn(async ({ execute }: { execute: () => Promise<unknown> }) => execute()),
}));

vi.mock("@/lib/nacos/nacosNamespaceCache", () => ({
  notifyNacosNamespacesChanged: (...args: unknown[]) => mocks.notifyNacosNamespacesChanged(...args),
}));

import { useSidebarDatabaseSpecificMutationRuntime } from "@/composables/useSidebarDatabaseSpecificMutationRuntime";

function connectionNode(): TreeNode {
  return {
    id: "conn-1",
    label: "Nacos",
    type: "connection",
    connectionId: "conn-1",
    isExpanded: false,
  };
}

function namespaceNode(): TreeNode {
  return {
    id: "conn-1:nacos:existing-space",
    label: "Existing Space",
    type: "nacos-namespace",
    connectionId: "conn-1",
    nacosNamespace: "existing-space",
    nacosNamespaceName: "Existing Space",
  };
}

describe("Nacos namespace creation cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nacosCreateNamespace.mockResolvedValue(undefined);
    mocks.loadNacosNamespaces.mockResolvedValue(undefined);
    sidebarFormTarget.value = connectionNode();
    createNacosNamespaceId.value = "new-space";
    createNacosNamespaceName.value = "New Space";
    createNacosNamespaceDesc.value = "Created during sync";
    createNacosNamespaceLoading.value = false;
    showCreateNacosNamespaceDialog.value = true;
  });

  it("notifies open views for the same connection immediately after creation succeeds", async () => {
    const { confirmCreateNacosNamespace } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(connectionNode()),
      connectionStore: {
        treeNodes: [],
        loadNacosNamespaces: mocks.loadNacosNamespaces,
        getConfig: () => undefined,
      } as any,
    });

    await confirmCreateNacosNamespace();

    expect(mocks.nacosCreateNamespace).toHaveBeenCalledWith("conn-1", {
      namespaceId: "new-space",
      namespaceName: "New Space",
      namespaceDesc: "Created during sync",
    });
    expect(mocks.notifyNacosNamespacesChanged).toHaveBeenCalledWith("conn-1");
    expect(mocks.notifyNacosNamespacesChanged.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadNacosNamespaces.mock.invocationCallOrder[0]);
    expect(showCreateNacosNamespaceDialog.value).toBe(false);
  });

  it("does not invalidate namespace caches when creation fails", async () => {
    mocks.nacosCreateNamespace.mockRejectedValueOnce(new Error("create failed"));
    const { confirmCreateNacosNamespace } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(connectionNode()),
      connectionStore: {
        treeNodes: [],
        loadNacosNamespaces: mocks.loadNacosNamespaces,
        getConfig: () => undefined,
      } as any,
    });

    await confirmCreateNacosNamespace();

    expect(mocks.notifyNacosNamespacesChanged).not.toHaveBeenCalled();
    expect(mocks.loadNacosNamespaces).not.toHaveBeenCalled();
    expect(showCreateNacosNamespaceDialog.value).toBe(true);
    expect(createNacosNamespaceLoading.value).toBe(false);
  });
});

describe("Nacos namespace edit cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nacosUpdateNamespace.mockResolvedValue(undefined);
    mocks.loadNacosNamespaces.mockResolvedValue(undefined);
    sidebarFormTarget.value = namespaceNode();
    editNacosNamespaceName.value = "Renamed Space";
    editNacosNamespaceDesc.value = "Updated during sync";
    editNacosNamespaceLoading.value = false;
    showEditNacosNamespaceDialog.value = true;
  });

  it("notifies open views before refreshing the sidebar after an edit", async () => {
    const { confirmEditNacosNamespace } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(namespaceNode()),
      connectionStore: {
        treeNodes: [],
        loadNacosNamespaces: mocks.loadNacosNamespaces,
        getConfig: () => undefined,
      } as any,
    });

    await confirmEditNacosNamespace();

    expect(mocks.nacosUpdateNamespace).toHaveBeenCalledWith("conn-1", {
      namespaceId: "existing-space",
      namespaceName: "Renamed Space",
      namespaceDesc: "Updated during sync",
    });
    expect(mocks.notifyNacosNamespacesChanged).toHaveBeenCalledWith("conn-1");
    expect(mocks.notifyNacosNamespacesChanged.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadNacosNamespaces.mock.invocationCallOrder[0]);
    expect(showEditNacosNamespaceDialog.value).toBe(false);
  });

  it("keeps namespace caches intact when an edit fails", async () => {
    mocks.nacosUpdateNamespace.mockRejectedValueOnce(new Error("edit failed"));
    const { confirmEditNacosNamespace } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(namespaceNode()),
      connectionStore: {
        treeNodes: [],
        loadNacosNamespaces: mocks.loadNacosNamespaces,
        getConfig: () => undefined,
      } as any,
    });

    await confirmEditNacosNamespace();

    expect(mocks.notifyNacosNamespacesChanged).not.toHaveBeenCalled();
    expect(mocks.loadNacosNamespaces).not.toHaveBeenCalled();
    expect(showEditNacosNamespaceDialog.value).toBe(true);
    expect(editNacosNamespaceLoading.value).toBe(false);
  });
});

describe("Nacos namespace deletion scope rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nacosDeleteNamespace.mockRejectedValue(new Error("remote delete failed"));
    mocks.loadNacosNamespaces.mockResolvedValue(undefined);
    sidebarDangerTarget.value = namespaceNode();
    deleteNacosNamespaceLoading.value = false;
    showDeleteNacosNamespaceConfirm.value = true;
  });

  it("restores the last managed namespace when the remote deletion fails", async () => {
    let currentConfig: any = {
      id: "conn-1",
      db_type: "nacos",
      visible_databases: ["existing-space"],
      external_config: {
        serverAddr: "http://127.0.0.1:8848",
        managedNamespaces: ["existing-space"],
      },
    };
    mocks.updateConnection.mockImplementation(async (config: any) => {
      currentConfig = config;
    });
    const { confirmDeleteNacosNamespace } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(namespaceNode()),
      connectionStore: {
        treeNodes: [],
        loadNacosNamespaces: mocks.loadNacosNamespaces,
        getConfig: () => currentConfig,
        updateConnection: mocks.updateConnection,
      } as any,
    });

    await confirmDeleteNacosNamespace();

    expect(mocks.nacosDeleteNamespace).toHaveBeenCalledWith("conn-1", "existing-space");
    expect(mocks.updateConnection).toHaveBeenCalledTimes(2);
    expect(mocks.updateConnection.mock.calls[0][0].visible_databases).toEqual([]);
    expect(mocks.updateConnection.mock.calls[0][0].external_config.managedNamespaces).toEqual([]);
    expect(currentConfig.visible_databases).toEqual(["existing-space"]);
    expect(currentConfig.external_config.managedNamespaces).toEqual(["existing-space"]);
    expect(mocks.notifyNacosNamespacesChanged).not.toHaveBeenCalled();
    expect(showDeleteNacosNamespaceConfirm.value).toBe(true);
    expect(deleteNacosNamespaceLoading.value).toBe(false);
  });
});
