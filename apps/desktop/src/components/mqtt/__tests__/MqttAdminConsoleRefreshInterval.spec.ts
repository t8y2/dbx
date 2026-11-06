// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import MqttAdminConsole from "@/components/mqtt/MqttAdminConsole.vue";
import type { MqttBrokerInfo, MqttMessage } from "@/types/mqtt";

const { mqttGetMessagesMock, tabUiStateMock } = vi.hoisted(() => ({
  mqttGetMessagesMock: vi.fn(),
  tabUiStateMock: {
    initialState: {} as Record<string, unknown>,
    track: vi.fn(),
  },
}));

vi.mock("@/lib/tabs/tabUiState", () => ({
  useTabUiState: () => tabUiStateMock,
}));

vi.mock("@/lib/backend/api", () => ({
  mqttGetBrokerInfo: vi.fn(async (): Promise<MqttBrokerInfo> => ({
    brokerUrl: "mqtt://localhost:1883",
    clientId: "dbx-test",
    connected: true,
    protocolVersion: "5.0",
    subscriptionCount: 1,
  })),
  mqttListTopics: vi.fn(async () => [["sensors/temperature", "atmostonce"]]),
  mqttListSavedTopicConfigs: vi.fn(async () => [{ topic: "sensors/temperature", qos: "atmostonce", enabled: true, noLocal: false }]),
  mqttGetMessages: mqttGetMessagesMock,
  mqttSubscribe: vi.fn(),
  mqttUnsubscribe: vi.fn(),
  mqttSaveTopicConfig: vi.fn(),
  mqttDeleteTopicConfig: vi.fn(),
  mqttClearMessages: vi.fn(),
}));

const mountedApps: App[] = [];

function messageAt(index: number, topic = "sensors/temperature"): MqttMessage {
  return {
    topic,
    payloadBase64: btoa(`payload-${index}`),
    payloadText: `payload-${index}`,
    qos: 0,
    retain: false,
    receivedAtMs: Date.now(),
    direction: "received",
  };
}

async function mountConsole(initialState: Record<string, unknown> = {}) {
  tabUiStateMock.initialState = initialState;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(MqttAdminConsole, {
    connectionId: "mqtt-connection-refresh",
    initialTopic: "sensors/temperature",
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  return container;
}

beforeEach(async () => {
  mqttGetMessagesMock.mockReset().mockResolvedValue([messageAt(0)]);
  tabUiStateMock.track.mockClear();
  tabUiStateMock.initialState = {};
  await loadLocaleMessages("zh-CN");
  i18n.global.locale.value = "zh-CN";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("MQTT 控制台前台刷新时间 (issue #12829)", () => {
  it("默认以 1 秒（1000ms）间隔轮询最新消息并提供刷新间隔下拉选项", async () => {
    const container = await mountConsole();
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(1);

    const intervalSelect = container.querySelector('[data-testid="mqtt-refresh-interval"]') as HTMLSelectElement | null;
    expect(intervalSelect).toBeTruthy();
    expect(intervalSelect!.value).toBe("1000");

    const optionValues = Array.from(intervalSelect!.options).map((opt) => opt.value);
    expect(optionValues).toEqual(["1000", "2000", "3000", "5000"]);

    const optionLabels = Array.from(intervalSelect!.options).map((opt) => opt.textContent?.trim());
    expect(optionLabels).toEqual(["1s", "2s", "3s", "5s"]);

    // Advancing 1000ms triggers the next poll
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(3);
  });

  it("切换刷新间隔至 2 秒后按新间隔进行消息轮询", async () => {
    const container = await mountConsole();
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(1);

    const intervalSelect = container.querySelector('[data-testid="mqtt-refresh-interval"]') as HTMLSelectElement | null;
    expect(intervalSelect).toBeTruthy();

    intervalSelect!.value = "2000";
    intervalSelect!.dispatchEvent(new Event("change"));
    await nextTick();

    mqttGetMessagesMock.mockClear();

    // 1000ms should NOT trigger poll with 2000ms interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).not.toHaveBeenCalled();

    // Reaching 2000ms triggers the poll
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(1);

    // Another 2000ms triggers again
    await vi.advanceTimersByTimeAsync(2000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(2);
  });

  it("恢复保存的 Tab UI State 中的刷新间隔配置", async () => {
    const container = await mountConsole({ pollingIntervalMs: 3000 });
    const intervalSelect = container.querySelector('[data-testid="mqtt-refresh-interval"]') as HTMLSelectElement | null;
    expect(intervalSelect).toBeTruthy();
    expect(intervalSelect!.value).toBe("3000");

    mqttGetMessagesMock.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mqttGetMessagesMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("若 Tab UI State 中的刷新间隔无效则回退至默认 1 秒", async () => {
    const container = await mountConsole({ pollingIntervalMs: 9999 });
    const intervalSelect = container.querySelector('[data-testid="mqtt-refresh-interval"]') as HTMLSelectElement | null;
    expect(intervalSelect).toBeTruthy();
    expect(intervalSelect!.value).toBe("1000");

    mqttGetMessagesMock.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(1);
  });
});
