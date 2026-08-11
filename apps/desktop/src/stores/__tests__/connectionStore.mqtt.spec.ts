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

  it("labels the MQTT console node via i18n instead of a hardcoded string", async () => {
    mockApi();

    const { default: i18n } = await import("@/i18n");
    i18n.global.locale.value = "en";
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
      label: i18n.global.t("connection.mqttConsoleTitle"),
    });
    // Regression guard for issue #5858: the sidebar entry must follow the active
    // locale. Under "en" it must read "MQTT Console", never the hardcoded Chinese.
    expect(node.children?.[0]?.label).toBe("MQTT Console");
    expect(node.children?.[0]?.label).not.toContain("控制台");
  });

  it("still resolves the console node label when the active locale is Chinese", async () => {
    mockApi();

    const { default: i18n, loadLocaleMessages } = await import("@/i18n");
    // zh-CN messages are lazy-loaded in the app (only "en" ships eagerly); mirror
    // that by loading the locale before switching so we do not assert against the
    // en fallback.
    await loadLocaleMessages("zh-CN");
    i18n.global.locale.value = "zh-CN";
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

    expect(node.children?.[0]?.label).toBe(i18n.global.t("connection.mqttConsoleTitle"));
    expect(node.children?.[0]?.label).toBe("MQTT 控制台");
  });

  it("localizes the MQTT admin tab title via i18n", async () => {
    mockApi();

    const { default: i18n } = await import("@/i18n");
    i18n.global.locale.value = "en";
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.connections = [mqttConnection()];

    const tabId = queryStore.openMqttAdmin("mqtt-1");
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId);

    expect(tab?.title).toBe("test-mqtt - MQTT Console");
    expect(tab?.title).not.toContain("控制台");
  });
});
