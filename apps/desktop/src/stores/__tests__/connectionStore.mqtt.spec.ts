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

function mqttConnection(): ConnectionConfig {
  return {
    id: "mqtt-1",
    name: "test-mqtt",
    db_type: "mqtt",
    host: "127.0.0.1",
    port: 1883,
    user: "",
    password: "",
    database: "",
    readonly: false,
    read_only: false,
    ssl_mode: "disabled",
    color: "#888",
  } as ConnectionConfig;
}

function mockApi() {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listDatabases: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  }));
}

describe("connectionStore MQTT sidebar tree", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("stores a stable i18n key for the MQTT console node", async () => {
    mockApi();

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mqttConnection();
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

    expect(node.children).toHaveLength(1);
    expect(node.children?.[0]).toMatchObject({
      id: `${connection.id}:mqtt-topic:__console__`,
      type: "mqtt-topic",
      label: "connection.mqttConsoleTitle",
    });
  });

  it("updates an existing MQTT tab title across locale changes and reopen", async () => {
    mockApi();

    const { default: i18n, setLocale } = await import("@/i18n");
    const { tabDisplayTitle } = await import("@/lib/tabs/tabPresentation");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.connections = [mqttConnection()];
    const translate = (key: string) => i18n.global.t(key);

    await setLocale("en");
    const originalTabId = queryStore.openMqttAdmin("mqtt-1");
    const originalTab = queryStore.tabs.find((candidate) => candidate.id === originalTabId);

    expect(originalTab?.title).toBe("connection.mqttConsoleTitle");
    expect(originalTab && tabDisplayTitle(originalTab, translate)).toBe("test-mqtt - MQTT Console");

    await setLocale("zh-CN");
    const reusedTabId = queryStore.openMqttAdmin("mqtt-1");

    expect(reusedTabId).toBe(originalTabId);
    expect(queryStore.tabs).toHaveLength(1);
    expect(originalTab && tabDisplayTitle(originalTab, translate)).toBe("test-mqtt - MQTT 控制台");

    queryStore.closeTab(originalTabId, { force: true });
    const reopenedTabId = queryStore.openMqttAdmin("mqtt-1");
    const reopenedTab = queryStore.tabs.find((candidate) => candidate.id === reopenedTabId);

    expect(reopenedTabId).not.toBe(originalTabId);
    expect(reopenedTab?.title).toBe("connection.mqttConsoleTitle");
    expect(reopenedTab && tabDisplayTitle(reopenedTab, translate)).toBe("test-mqtt - MQTT 控制台");
  });
});
