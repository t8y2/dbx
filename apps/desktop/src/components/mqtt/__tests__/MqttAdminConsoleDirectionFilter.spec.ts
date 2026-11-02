// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import MqttAdminConsole from "@/components/mqtt/MqttAdminConsole.vue";
import type { MqttBrokerInfo, MqttMessage } from "@/types/mqtt";

const { mqttGetMessagesMock } = vi.hoisted(() => ({
  mqttGetMessagesMock: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  mqttGetBrokerInfo: vi.fn(async (): Promise<MqttBrokerInfo> => ({
    brokerUrl: "mqtt://localhost:1883",
    clientId: "dbx-test",
    connected: true,
    protocolVersion: "5.0",
    subscriptionCount: 1,
  })),
  mqttListTopics: vi.fn(async () => [["device/status", "atmostonce"]]),
  mqttListSavedTopicConfigs: vi.fn(async () => [{ topic: "device/status", qos: "atmostonce", enabled: true, noLocal: false }]),
  mqttGetMessages: mqttGetMessagesMock,
  mqttSubscribe: vi.fn(),
  mqttUnsubscribe: vi.fn(),
  mqttSaveTopicConfig: vi.fn(),
  mqttDeleteTopicConfig: vi.fn(),
  mqttClearMessages: vi.fn(),
}));

const mountedApps: App[] = [];

function message(index: number, direction: "received" | "sent"): MqttMessage {
  return {
    topic: "device/status",
    payloadBase64: btoa(`payload-${index}`),
    payloadText: `payload-${index}`,
    qos: 0,
    retain: false,
    receivedAtMs: Date.now() + index,
    direction,
  };
}

async function settleConsole() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountConsole() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(MqttAdminConsole, {
    connectionId: "mqtt-connection-1",
    initialTopic: "device/status",
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await settleConsole();
  return container;
}

async function selectDirection(container: HTMLElement, direction: "all" | "received" | "sent") {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="mqtt-direction-filter-${direction}"]`);
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleConsole();
}

beforeEach(async () => {
  mqttGetMessagesMock.mockReset().mockResolvedValue([message(0, "received"), message(1, "sent")]);
  await loadLocaleMessages("zh-CN");
  i18n.global.locale.value = "zh-CN";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("MQTT 控制台按消息方向筛选 (issue #11848)", () => {
  it("以本地日期和时间显示消息时间戳", async () => {
    const item = message(0, "received");
    item.receivedAtMs = new Date(2024, 0, 2, 3, 4, 5).getTime();
    mqttGetMessagesMock.mockResolvedValueOnce([item]);

    const container = await mountConsole();

    expect(container.querySelector("time")?.textContent).toBe("2024-01-02 03:04:05");
  });

  it("在全部、已接收和已发送之间切换消息列表", async () => {
    const container = await mountConsole();

    expect(container.querySelectorAll('[data-testid="mqtt-message"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent).toBe("2");

    await selectDirection(container, "received");
    expect(container.querySelectorAll('[data-testid="mqtt-message"]')).toHaveLength(1);
    expect(container.textContent).toContain("payload-0");
    expect(container.textContent).not.toContain("payload-1");
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent).toBe("1 / 2");

    await selectDirection(container, "sent");
    expect(container.querySelectorAll('[data-testid="mqtt-message"]')).toHaveLength(1);
    expect(container.textContent).toContain("payload-1");
    expect(container.textContent).not.toContain("payload-0");

    await selectDirection(container, "all");
    expect(container.querySelectorAll('[data-testid="mqtt-message"]')).toHaveLength(2);
  });
});
