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
  mqttGetBrokerInfo: vi.fn(
    async (): Promise<MqttBrokerInfo> => ({
      brokerUrl: "mqtt://localhost:1883",
      clientId: "dbx-test",
      connected: true,
      protocolVersion: "5.0",
      subscriptionCount: 1,
    }),
  ),
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

function messageAt(index: number, topic = "device/status"): MqttMessage {
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
  await nextTick();
  return container;
}

beforeEach(async () => {
  mqttGetMessagesMock.mockReset().mockResolvedValue([messageAt(0)]);
  await loadLocaleMessages("zh-CN");
  i18n.global.locale.value = "zh-CN";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("MQTT 控制台消息暂停自动滚动 (issue #5615)", () => {
  it("暂停期间不会应用已经在途的轮询结果", async () => {
    let resolvePollingRequest!: (messages: MqttMessage[]) => void;
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt(0)]).mockReturnValueOnce(
      new Promise<MqttMessage[]>((resolve) => {
        resolvePollingRequest = resolve;
      }),
    );

    const container = await mountConsole();
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    expect(container.textContent).toContain("payload-0");

    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(2);

    const pauseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("暂停"));
    pauseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    resolvePollingRequest([messageAt(1)]);
    await Promise.resolve();
    await nextTick();

    expect(container.textContent).toContain("payload-0");
    expect(container.textContent).not.toContain("payload-1");
  });

  it("点击暂停后，轮询不再覆盖消息列表", async () => {
    const container = await mountConsole();
    await vi.runOnlyPendingTimersAsync();
    const callsBeforePause = mqttGetMessagesMock.mock.calls.length;
    expect(callsBeforePause).toBeGreaterThan(0);

    const pauseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("暂停"));
    expect(pauseButton).toBeTruthy();
    pauseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    mqttGetMessagesMock.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mqttGetMessagesMock).not.toHaveBeenCalled();

    const resumeButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("继续"));
    expect(resumeButton).toBeTruthy();
    resumeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mqttGetMessagesMock).toHaveBeenCalled();
  });
});

describe("MQTT 控制台暂停后选择消息 (issue #8353)", () => {
  it("点击暂停后的消息内容时不会重新获取并替换消息", async () => {
    mqttGetMessagesMock.mockResolvedValue([messageAt(0, "device/other")]);
    const container = await mountConsole();
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    expect(container.textContent).toContain("payload-0");
    expect(container.textContent).toContain("消息：device/status");

    const pauseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("暂停"));
    expect(pauseButton).toBeTruthy();
    pauseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    mqttGetMessagesMock.mockClear();
    mqttGetMessagesMock.mockResolvedValue([messageAt(1, "device/other")]);
    const messageRow = Array.from(container.querySelectorAll(".cursor-pointer")).find((element) => element.textContent?.includes("payload-0"));
    expect(messageRow).toBeTruthy();
    messageRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();

    expect(mqttGetMessagesMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("payload-0");
    expect(container.textContent).not.toContain("payload-1");
    expect(container.textContent).toContain("消息：device/status");
    expect(container.textContent).not.toContain("消息：device/other");
  });
});
