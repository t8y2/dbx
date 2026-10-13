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

function messageAt(payload: string, topic = "device/status", payloadText: string | null | undefined = payload): MqttMessage {
  return {
    topic,
    payloadBase64: btoa(payload),
    payloadText,
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

async function settleConsole() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function setPayloadSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="mqtt-payload-search"]');
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

beforeEach(async () => {
  mqttGetMessagesMock.mockReset().mockResolvedValue([]);
  await loadLocaleMessages("zh-CN");
  i18n.global.locale.value = "zh-CN";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("MQTT 控制台 payload 搜索 (issue #8183)", () => {
  it("搜索为空时显示所有已加载消息", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha"), messageAt("payload-beta")]);

    const container = await mountConsole();
    await settleConsole();

    expect(container.textContent).toContain("payload-alpha");
    expect(container.textContent).toContain("payload-beta");
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent?.trim()).toBe("2");
  });

  it("输入 payload 关键字后只显示匹配消息，不搜索 Topic", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("sensor-temperature-25", "sensor/temperature"), messageAt("sensor-humidity-60")]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "humidity");

    expect(container.textContent).toContain("sensor-humidity-60");
    expect(container.textContent).not.toContain("sensor-temperature-25");
    expect(container.textContent).not.toContain("sensor/temperature");
  });

  it("payload 搜索大小写不敏感并忽略首尾空格", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("Device ERROR Timeout"), messageAt("Device healthy")]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "  error ");

    expect(container.textContent).toContain("Device ERROR Timeout");
    expect(container.textContent).not.toContain("Device healthy");
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent?.trim()).toBe("1 / 2");
  });

  it("清空搜索后恢复完整消息列表", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha"), messageAt("payload-beta")]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "alpha");
    expect(container.textContent).not.toContain("payload-beta");

    await setPayloadSearch(container, "");

    expect(container.textContent).toContain("payload-alpha");
    expect(container.textContent).toContain("payload-beta");
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent?.trim()).toBe("2");
  });

  it("没有匹配的 payload 时显示专用空状态", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha")]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "missing");

    expect(container.querySelector('[data-testid="mqtt-no-matching-messages"]')).not.toBeNull();
    expect(container.textContent).not.toContain("payload-alpha");
    expect(container.querySelector('[data-testid="mqtt-message-count"]')?.textContent?.trim()).toBe("0 / 1");
  });

  it("搜索只进行本地过滤，不触发额外的消息请求", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha"), messageAt("payload-beta")]);

    const container = await mountConsole();
    await settleConsole();
    const callsAfterLoad = mqttGetMessagesMock.mock.calls.length;

    await setPayloadSearch(container, "beta");

    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("payloadText 缺失时仍使用 plaintext fallback 搜索", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("fallback-error", "device/status", null)]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "error");

    expect(container.textContent).toContain("fallback-error");
    expect(container.querySelector('[data-testid="mqtt-no-matching-messages"]')).toBeNull();
  });

  it("轮询更新消息后继续应用 payload 搜索", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("initial-error"), messageAt("initial-ok")]).mockResolvedValueOnce([messageAt("next-error"), messageAt("next-ok")]);

    const container = await mountConsole();
    await settleConsole();
    await setPayloadSearch(container, "error");

    await vi.advanceTimersByTimeAsync(3000);
    await nextTick();

    expect(container.textContent).toContain("next-error");
    expect(container.textContent).not.toContain("next-ok");
  });
});
