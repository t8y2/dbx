import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EtcdAuthPermission, KvValue } from "@/lib/backend/api";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const utf8 = (data: string): KvValue => ({ encoding: "utf8", data });
const readPermission: EtcdAuthPermission = { access: "read", key: utf8(""), rangeEnd: utf8("\0"), resource: "all" };

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("connectionStore etcd access", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  async function loadEtcdTree(roles: string[], permissions: EtcdAuthPermission[] = [readPermission], options: { connection?: Partial<ConnectionConfig>; authEnabled?: boolean; authUser?: string; loadRoot?: boolean } = {}) {
    const connection = {
      id: "etcd-reader",
      name: "restricted etcd",
      db_type: "etcd",
      host: "127.0.0.1",
      port: 2379,
      username: "reader",
      password: "secret",
      database: "",
      ...options.connection,
    } as ConnectionConfig;
    const etcdAuthCall = vi.fn((_connectionId: string, operation: string, args: { user?: string; role?: string }) => {
      if (operation === "user_get") return Promise.resolve({ user: args.user || options.authUser || "reader", roles, authEnabled: options.authEnabled ?? true });
      if (operation === "role_get") return Promise.resolve({ role: args.role, permissions });
      throw new Error(`Unexpected etcd auth operation: ${operation}`);
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      etcdAuthCall,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
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

    if (options.loadRoot !== false) await store.loadEtcdRoot(connection.id);
    return { root, etcdAuthCall, store };
  }

  it("hides management views for a regular etcd user", async () => {
    const { root, etcdAuthCall, store } = await loadEtcdTree(["reader-role"]);

    expect(etcdAuthCall).toHaveBeenCalledWith("etcd-reader", "user_get", {});
    expect(etcdAuthCall).toHaveBeenCalledWith("etcd-reader", "role_get", { role: "reader-role" });
    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root"]);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: false, writePermissions: [] });
  });

  it("shows management views only for the root role", async () => {
    const { root } = await loadEtcdTree(["reader-role", "root"]);

    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root", "etcd-access-control", "etcd-dashboard"]);
  });

  it("keeps Key mutations available to a non-admin role with write access", async () => {
    const writePermission: EtcdAuthPermission = { access: "readwrite", key: utf8("/editable/"), rangeEnd: utf8("/editable0"), resource: "prefix" };
    const { root, store } = await loadEtcdTree(["key-writer"], [writePermission]);

    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root"]);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: true, writePermissions: [writePermission] });
    expect(store.canWriteEtcdKey("etcd-reader", "/editable/key")).toBe(true);
    expect(store.canWriteEtcdKey("etcd-reader", "/readonly/key")).toBe(false);
  });

  it("loads capabilities without requiring the sidebar connection to be expanded", async () => {
    const writePermission: EtcdAuthPermission = { access: "readwrite", key: utf8("/editable/"), rangeEnd: utf8("/editable0"), resource: "prefix" };
    const { root, store } = await loadEtcdTree(["key-writer"], [writePermission], { loadRoot: false });

    expect(root.isExpanded).toBe(false);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: false, writePermissions: [] });

    await store.ensureEtcdAccessCapabilities("etcd-reader", { force: true, verifyHealth: false });

    expect(root.isExpanded).toBe(false);
    expect(store.canWriteEtcdKey("etcd-reader", "/editable/key")).toBe(true);
  });

  it("preserves confirmed write permissions when a forced refresh fails transiently", async () => {
    const writePermission: EtcdAuthPermission = { access: "readwrite", key: utf8("/editable/"), rangeEnd: utf8("/editable0"), resource: "prefix" };
    const { etcdAuthCall, store } = await loadEtcdTree(["key-writer"], [writePermission]);

    etcdAuthCall.mockRejectedValueOnce(new Error("temporary auth timeout"));
    await store.ensureEtcdAccessCapabilities("etcd-reader", { force: true, verifyHealth: false });

    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: true, writePermissions: [writePermission] });
    expect(store.canWriteEtcdKey("etcd-reader", "/editable/key")).toBe(true);
  });

  it("preserves a confirmed root role when a forced refresh fails transiently", async () => {
    const { etcdAuthCall, store } = await loadEtcdTree(["root"]);

    etcdAuthCall.mockRejectedValueOnce(new Error("temporary auth timeout"));
    await store.ensureEtcdAccessCapabilities("etcd-reader", { force: true, verifyHealth: false });

    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: true, writable: true, writePermissions: null });
  });

  it("fails closed when initial capability discovery fails", async () => {
    const { etcdAuthCall, store } = await loadEtcdTree(["key-writer"], [readPermission], { loadRoot: false });

    etcdAuthCall.mockRejectedValueOnce(new Error("temporary auth timeout"));
    await store.ensureEtcdAccessCapabilities("etcd-reader", { force: true, verifyHealth: false });

    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: false, writePermissions: [] });
  });

  it("does not let a read grant inherit write access from another range", async () => {
    const permissions: EtcdAuthPermission[] = [
      { access: "read", key: utf8("/readonly/"), rangeEnd: utf8("/readonly0"), resource: "prefix" },
      { access: "readwrite", key: utf8("/editable/"), rangeEnd: utf8("/editable0"), resource: "prefix" },
    ];
    const { store } = await loadEtcdTree(["mixed-role"], permissions);

    expect(store.canWriteEtcdKey("etcd-reader", "/readonly/key")).toBe(false);
    expect(store.canWriteEtcdKey("etcd-reader", "/editable/key")).toBe(true);
  });

  it("uses the agent's certificate identity for a restricted TLS user", async () => {
    const { root, etcdAuthCall, store } = await loadEtcdTree(["cert-reader-role"], [readPermission], {
      connection: { username: "", password: "", client_cert_path: "/tmp/cert.pem", client_key_path: "/tmp/key.pem" },
      authUser: "cert-reader",
    });

    expect(etcdAuthCall).toHaveBeenCalledWith("etcd-reader", "user_get", {});
    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root"]);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: false, writePermissions: [] });
  });

  it("keeps certificate connections unrestricted when server auth is disabled", async () => {
    const { root } = await loadEtcdTree([], [readPermission], {
      connection: { username: "", password: "", client_cert_path: "/tmp/cert.pem", client_key_path: "/tmp/key.pem" },
      authEnabled: false,
      authUser: "transport-only-cert",
    });

    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root", "etcd-access-control", "etcd-dashboard"]);
  });

  it("keeps anonymous connections unrestricted when server auth is disabled", async () => {
    const { root, etcdAuthCall, store } = await loadEtcdTree([], [readPermission], {
      connection: { username: "", password: "", client_cert_path: "", client_key_path: "" },
      authEnabled: false,
      authUser: "",
    });

    expect(etcdAuthCall).toHaveBeenCalledWith("etcd-reader", "user_get", {});
    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root", "etcd-access-control", "etcd-dashboard"]);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: true, writable: true, writePermissions: null });
  });

  it("queries the configured user when resolving etcd v2 capabilities", async () => {
    const writePermission: EtcdAuthPermission = { access: "write", key: utf8("/editable/"), rangeEnd: utf8("/editable0"), resource: "prefix" };
    const { root, etcdAuthCall, store } = await loadEtcdTree(["v2-writer"], [writePermission], {
      connection: { driver_profile: "etcd-v2" },
    });

    expect(etcdAuthCall).toHaveBeenCalledWith("etcd-reader", "user_get", { user: "reader" });
    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root"]);
    expect(store.canWriteEtcdKey("etcd-reader", "/editable/key")).toBe(true);
    expect(store.canWriteEtcdKey("etcd-reader", "/readonly/key")).toBe(false);
  });

  it("keeps anonymous etcd v2 Key operations available without probing an empty user", async () => {
    const { root, etcdAuthCall, store } = await loadEtcdTree([], [readPermission], {
      connection: { driver_profile: "etcd-v2", username: "", password: "" },
    });

    expect(etcdAuthCall).not.toHaveBeenCalled();
    expect(root.children?.map((child) => child.type)).toEqual(["etcd-root"]);
    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: true, writePermissions: null });
  });

  it("preserves etcd v2 Key operations when auth capability discovery is unavailable", async () => {
    const { etcdAuthCall, store } = await loadEtcdTree(["v2-writer"], [readPermission], {
      connection: { driver_profile: "etcd-v2" },
      loadRoot: false,
    });
    etcdAuthCall.mockRejectedValueOnce(new Error("v2 auth endpoint unavailable"));

    await store.ensureEtcdAccessCapabilities("etcd-reader", { force: true, verifyHealth: false });

    expect(store.getEtcdAccessCapabilities("etcd-reader")).toEqual({ admin: false, writable: true, writePermissions: null });
  });
});
