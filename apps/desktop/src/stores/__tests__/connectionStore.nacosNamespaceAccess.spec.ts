import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("connectionStore Nacos namespace access", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  async function loadNacosTree(listUsersSupported: boolean, listRoleBindingsSupported = false) {
    const connection = {
      id: "nacos-bb",
      name: "Nacos bb",
      db_type: "nacos",
      host: "127.0.0.1",
      port: 8848,
      username: "bb",
      password: "secret",
      database: "",
      visible_databases: ["aa", "bb", "cc", ""],
    } as ConnectionConfig;
    // The backend has already removed `bb` and `public`, which the restricted
    // account cannot read even when the server's raw list endpoint exposes them.
    const readableNamespaces = ["aa", "cc"].map((namespace) => ({
      namespace,
      namespaceShowName: namespace || "public",
    }));
    const nacosListConfigs = vi.fn();
    const nacosSidebarSnapshot = vi.fn().mockResolvedValue({
      namespaces: readableNamespaces,
      accessControl: {
        listUsers: { supported: listUsersSupported },
        listRoleBindings: { supported: listRoleBindingsSupported },
      },
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      nacosListConfigs,
      nacosSidebarSnapshot,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const root: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    };
    store.connections = [connection];
    store.treeNodes = [root];
    store.connectedIds.add(connection.id);

    await store.loadNacosNamespaces(connection.id, { force: true });

    return { root, store, nacosListConfigs, nacosSidebarSnapshot };
  }

  it("hides unreadable namespaces without adding per-namespace sidebar requests", async () => {
    const { root, store, nacosListConfigs, nacosSidebarSnapshot } = await loadNacosTree(false);

    expect(nacosListConfigs).not.toHaveBeenCalled();
    expect(nacosSidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(root.children?.filter((node) => node.type === "nacos-namespace").map((node) => node.label)).toEqual(["aa", "cc"]);
    expect(store.getSidebarVisibleFilterSummary("nacos-bb")).toEqual({ mode: "namespace", isActive: false, selected: 2, total: 2 });
    expect(root.children?.some((node) => node.type === "nacos-access-control")).toBe(false);
  });

  it("shows access control when the current account can list users", async () => {
    const { root } = await loadNacosTree(true);

    expect(root.children?.find((node) => node.type === "nacos-access-control")?.label).toBe("nacos.accessControlSidebarLabel");
  });

  it("shows access control for a roles-only account", async () => {
    const { root } = await loadNacosTree(false, true);

    expect(root.children?.find((node) => node.type === "nacos-access-control")?.label).toBe("nacos.accessControlSidebarLabel");
  });
});
