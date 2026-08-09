import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { createNacosNamespaceDesc, createNacosNamespaceId, createNacosNamespaceLoading, createNacosNamespaceName, showCreateNacosNamespaceDialog, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  nacosCreateNamespace: vi.fn(),
  notifyNacosNamespacesChanged: vi.fn(),
  loadNacosNamespaces: vi.fn(),
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
