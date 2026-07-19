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

function mqConnection(): ConnectionConfig {
  return {
    id: "mq-1",
    name: "Apache Pulsar",
    db_type: "mq",
    host: "127.0.0.1",
    port: 8080,
    user: "",
    password: "",
    database: "",
    readonly: false,
    read_only: false,
    ssl_mode: "disabled",
    color: "#888",
    external_config: {
      systemKind: "pulsar",
      adminUrl: "http://127.0.0.1:8080",
      auth: { kind: "none" },
    },
  } as ConnectionConfig;
}

function kafkaConnection(): ConnectionConfig {
  return {
    ...mqConnection(),
    name: "Apache Kafka",
    driver_profile: "kafka",
    driver_label: "Apache Kafka",
    external_config: {
      systemKind: "kafka",
      adminUrl: "",
      auth: { kind: "none" },
      extra: { bootstrapServers: "127.0.0.1:9092" },
    },
  } as ConnectionConfig;
}

function kafkaExternalConfigOnlyConnection(): ConnectionConfig {
  const connection = kafkaConnection();
  delete connection.driver_profile;
  delete connection.driver_label;
  return connection;
}

describe("connectionStore MQ sidebar tree", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("loads Pulsar tenants under a message queue connection", async () => {
    const mqListTenants = vi.fn().mockResolvedValue([
      { name: "public", adminRoles: [], allowedClusters: [] },
      { name: "tenant-a", adminRoles: [], allowedClusters: [] },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      mqListTenants,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mqConnection();
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    };

    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    await store.refreshTreeNode(node);

    expect(mqListTenants).toHaveBeenCalledWith(connection.id);
    expect(node.children?.map((child) => ({ id: child.id, label: child.label, type: child.type, tenant: (child as TreeNode & { mqTenant?: string }).mqTenant }))).toEqual([
      { id: "mq-1:mq-tenant:public", label: "public", type: "mq-tenant", tenant: "public" },
      { id: "mq-1:mq-tenant:tenant-a", label: "tenant-a", type: "mq-tenant", tenant: "tenant-a" },
    ]);
    expect(node.isExpanded).toBe(true);
  }, 10_000);

  it("adds a Kafka topics child with a topics initial tab", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      mqListTenants: vi.fn(),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = kafkaConnection();
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    };

    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    await store.refreshTreeNode(node);

    expect(node.children?.map((child) => ({ label: child.label, tenant: child.mqTenant, initialTab: child.mqInitialTab }))).toEqual([{ label: "Topics", tenant: "_flat_mq", initialTab: "topics" }]);
  });

  it("adds a RocketMQ topics child with a topics initial tab", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      mqListTenants: vi.fn(),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = {
      ...kafkaConnection(),
      name: "Apache RocketMQ",
      driver_profile: "rocketmq",
      driver_label: "Apache RocketMQ",
      external_config: {
        systemKind: "rocketmq",
        adminUrl: "",
        auth: { kind: "none" },
        extra: { namesrvAddr: "127.0.0.1:9876" },
      },
    } as ConnectionConfig;
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    };

    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    await store.refreshTreeNode(node);

    expect(node.children?.map((child) => ({ label: child.label, tenant: child.mqTenant, initialTab: child.mqInitialTab }))).toEqual([{ label: "Topics", tenant: "_flat_mq", initialTab: "topics" }]);
  });

  it("detects Kafka from external config when driver profile is missing", async () => {
    const mqListTenants = vi.fn();
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      mqListTenants,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = kafkaExternalConfigOnlyConnection();
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    };

    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    await store.refreshTreeNode(node);

    expect(mqListTenants).not.toHaveBeenCalled();
    expect(node.children?.map((child) => ({ label: child.label, tenant: child.mqTenant, initialTab: child.mqInitialTab }))).toEqual([{ label: "Topics", tenant: "_flat_mq", initialTab: "topics" }]);
  });

  it("reuses an in-flight connection attempt instead of recording stale superseded errors", async () => {
    let resolveConnect: ((value: string) => void) | undefined;
    const connectDb = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      connectDb,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mqConnection();
    store.connections = [connection];

    const first = store.ensureConnected(connection.id);
    const second = store.ensureConnected(connection.id);
    await Promise.resolve();

    expect(connectDb).toHaveBeenCalledTimes(1);
    resolveConnect?.(connection.id);
    await Promise.all([first, second]);

    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
  });

  it("stores the selected tenant when opening an MQ admin tab", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.connections = [mqConnection()];

    const firstTabId = queryStore.openMqAdmin("mq-1", { tenant: "public" });
    expect(queryStore.tabs.find((tab) => tab.id === firstTabId)?.mqTenant).toBe("public");
    expect(queryStore.tabs.find((tab) => tab.id === firstTabId)?.mqInitialTab).toBeUndefined();

    const secondTabId = queryStore.openMqAdmin("mq-1", { tenant: "tenant-a", initialTab: "topics" });
    expect(secondTabId).toBe(firstTabId);
    expect(queryStore.tabs.find((tab) => tab.id === firstTabId)?.mqTenant).toBe("tenant-a");
    expect(queryStore.tabs.find((tab) => tab.id === firstTabId)?.mqInitialTab).toBe("topics");
  });

  it("preserves the selected tenant when duplicating an MQ admin tab", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.connections = [mqConnection()];

    const tabId = queryStore.openMqAdmin("mq-1", { tenant: "public" });
    queryStore.duplicateTab(tabId);

    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs[1]?.mqTenant).toBe("public");
  });
});
