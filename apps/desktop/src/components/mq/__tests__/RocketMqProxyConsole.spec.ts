// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, type App } from "vue";
const state = vi.hoisted(() => ({ config: { db_type: "mq", driver_profile: "rocketmq", external_config: { systemKind: "rocketmq", extra: { connectionMode: "proxy" } } }, revision: { value: 0 }, test: vi.fn(), topics: vi.fn(), admin: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => state.config, metadataGenerationFor: () => state.revision.value, ensureConnected: async () => undefined }) }));
vi.mock("@/lib/tabs/tabUiState", () => ({ useTabUiState: () => ({ initialState: { activeTab: "broker", selectedTopic: { name: "OldTopic", shortName: "OldTopic", partitioned: false, persistent: true } }, track: () => undefined }) }));
vi.mock("@/composables/useMqMutationGuard", () => ({ useMqMutationGuard: () => ({ confirmMqWrite: async () => true }) }));
vi.mock("@/lib/backend/api", () => ({ mqTestConnection: state.test, mqListTopics: state.topics, mqSendMessage: vi.fn(), mqCreateNamespace: vi.fn(), mqListNamespaces: vi.fn() }));
vi.mock("@/components/mq/TopicsPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("topics");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/BrokerPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("broker");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/SubscriptionsPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("subscriptions");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/ProducerConsumerPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("producers");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/RocketMqMessagesPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("query");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/MessageQueryPanel.vue", () => ({
  default: {
    setup: () => {
      state.admin("query");
      return () => null;
    },
  },
}));
vi.mock("@/components/mq/MessageBrowser.vue", () => ({ default: { render: () => null } }));
import MqAdminConsole from "../MqAdminConsole.vue";
import { defaultMqCapabilitiesForSystemKind } from "@/lib/mq/mqConsoleDefaults";
let app: App;
let root: HTMLDivElement;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.clearAllMocks();
  delete (state.config.external_config.extra as Record<string, unknown>).managementEnabled;
  state.config.external_config.extra.connectionMode = "proxy";
});

describe("RocketMQ proxy console negotiation", () => {
  it("renegotiates reactive same-id mode and endpoint changes without accepting stale responses", async () => {
    state.config = reactive(state.config);
    state.revision = reactive(state.revision);
    const extra = state.config.external_config.extra as Record<string, unknown>;
    extra.connectionMode = "remoting";
    const legacy = { systemKind: "rocketmq", capabilities: defaultMqCapabilitiesForSystemKind("rocketmq"), extra: { channels: { messaging: { status: "ready" }, management: { status: "ready" } } } };
    state.test.mockResolvedValueOnce(legacy);
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    expect(root.textContent).toContain("mqAdmin.tabCluster");
    let resolveOld!: (value: unknown) => void;
    state.test.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    Object.assign(extra, { connectionMode: "proxy", managementEnabled: true, proxyEndpoint: "first:8081" });
    await flush();
    expect([...root.querySelectorAll(".mq-tabs-list button")].map((el) => el.textContent?.trim())).toEqual(["mqAdmin.tabMessages"]);
    expect(root.textContent).not.toContain("connection.rocketmqChannelManagement");
    expect(state.test).toHaveBeenCalledTimes(2);
    const conservative = defaultMqCapabilitiesForSystemKind("rocketmq", state.config as never);
    state.test.mockResolvedValueOnce({ systemKind: "rocketmq", capabilities: conservative, extra: { channels: { messaging: { status: "ready" }, management: { status: "degraded", error: "offline" } } } });
    extra.proxyEndpoint = "second:8081";
    await flush();
    await flush();
    expect(state.test).toHaveBeenCalledTimes(3);
    expect(root.querySelector('[title="offline"]')).not.toBeNull();
    resolveOld(legacy);
    await flush();
    expect(root.querySelector('[title="offline"]')).not.toBeNull();
    expect(root.textContent).not.toContain("mqAdmin.tabCluster");
    state.test.mockResolvedValueOnce({ ...legacy, capabilities: { ...conservative, supportsListTopics: true, supportsBrokerAdmin: true } });
    extra.proxyEndpoint = "recovered:8081";
    await flush();
    await flush();
    expect(state.test).toHaveBeenCalledTimes(4);
    expect(root.querySelector('[title="offline"]')).toBeNull();
    expect(root.textContent).toContain("mqAdmin.tabTopics");
    expect(root.textContent).toContain("connection.rocketmqChannelManagement: connection.rocketmqChannelready");
    state.test.mockReturnValueOnce(new Promise(() => undefined));
    state.revision.value++;
    await flush();
    expect(state.test).toHaveBeenCalledTimes(5);
    expect(root.textContent).not.toContain("connection.rocketmqChannelManagement");
    expect([...root.querySelectorAll(".mq-tabs-list button")].map((el) => el.textContent?.trim())).toEqual(["mqAdmin.tabMessages"]);
    extra.connectionMode = "proxy";
  });
  it("reconciles a restored Broker tab before mounting and never fetches administration before capabilities", async () => {
    state.test.mockReturnValue(new Promise(() => undefined));
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    expect([...root.querySelectorAll(".mq-tabs-list button")].map((el) => el.textContent?.trim())).toEqual(["mqAdmin.tabMessages"]);
    expect(root.querySelector(".send-message-panel input.topic-input")).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".breadcrumb-button")!.click();
    await flush();
    expect(root.querySelector(".send-message-panel input.topic-input")).not.toBeNull();
    expect(state.admin).not.toHaveBeenCalled();
    expect(state.topics).not.toHaveBeenCalled();
  });
  it("keeps proxy-only administration disabled even when stale legacy capabilities arrive", async () => {
    state.test.mockResolvedValue({ systemKind: "rocketmq", capabilities: defaultMqCapabilitiesForSystemKind("rocketmq") });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    expect([...root.querySelectorAll(".mq-tabs-list button")].map((el) => el.textContent?.trim())).toEqual(["mqAdmin.tabMessages"]);
    expect(state.admin).not.toHaveBeenCalled();
    expect(state.topics).not.toHaveBeenCalled();
  });
  it("never falls back to topic administration when sending is unavailable", async () => {
    state.test.mockResolvedValue({ systemKind: "rocketmq", capabilities: { ...defaultMqCapabilitiesForSystemKind("rocketmq", state.config as never), supportsSendMessage: false } });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    expect(state.admin).not.toHaveBeenCalled();
    expect(state.topics).not.toHaveBeenCalled();
    expect(root.querySelector(".send-message-panel")).toBeNull();
  });
  it("sends an unlisted manual topic with ready administration and list capability", async () => {
    const extra = state.config.external_config.extra as Record<string, unknown>;
    extra.managementEnabled = true;
    const send = (await import("@/lib/backend/api")).mqSendMessage;
    vi.mocked(send).mockResolvedValue({ topic: "UnlistedTopic", partition: 0, offset: 0 });
    state.topics.mockResolvedValue([{ name: "ListedTopic", shortName: "ListedTopic", persistent: true, partitioned: false }]);
    state.test.mockResolvedValue({ systemKind: "rocketmq", capabilities: { ...defaultMqCapabilitiesForSystemKind("rocketmq"), supportsListTopics: true }, extra: { channels: { messaging: { status: "ready" }, management: { status: "ready" } } } });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".mq-tabs-list button")];
    expect(tabs.some((button) => button.textContent?.trim() === "mqAdmin.tabTopics")).toBe(true);
    tabs.find((button) => button.textContent?.trim() === "mqAdmin.tabMessages")!.click();
    await flush();
    const topic = root.querySelector<HTMLInputElement>(".send-message-panel input")!;
    topic.value = "UnlistedTopic";
    topic.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    const payload = root.querySelector<HTMLTextAreaElement>(".send-message-panel textarea")!;
    payload.value = "ordinary payload";
    payload.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>(".send-message-panel button")].find((button) => button.textContent?.trim() === "mqMessages.sendMessage")!.click();
    await flush();
    await flush();
    expect(send).toHaveBeenCalledWith("proxy", expect.objectContaining({ topic: "UnlistedTopic", payloadText: "ordinary payload" }));
    expect(state.topics).not.toHaveBeenCalled();
  });
  it("keeps sending available and displays degraded management separately", async () => {
    state.test.mockResolvedValue({ systemKind: "rocketmq", capabilities: defaultMqCapabilitiesForSystemKind("rocketmq", state.config as never), extra: { channels: { messaging: { status: "ready" }, management: { status: "degraded", error: "No route to NameServer" } } } });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MqAdminConsole, { connectionId: "proxy" });
    app.mount(root);
    await flush();
    expect(root.textContent).toContain("connection.rocketmqChannelMessaging: connection.rocketmqChannelready");
    expect(root.querySelector('[title="No route to NameServer"]')?.textContent).toContain("connection.rocketmqChanneldegraded");
    expect(root.querySelector(".send-message-panel input.topic-input")).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".breadcrumb-button")!.click();
    await flush();
    expect(root.querySelector(".send-message-panel input.topic-input")).not.toBeNull();
    expect(state.admin).not.toHaveBeenCalled();
    expect(state.topics).not.toHaveBeenCalled();
  });
});
