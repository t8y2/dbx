// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import MqttAdminConsole from "@/components/mqtt/MqttAdminConsole.vue";
import type { MqttBrokerInfo } from "@/types/mqtt";

const { mqttListSavedTopicConfigsMock, mqttGetMessagesMock } = vi.hoisted(() => ({
  mqttListSavedTopicConfigsMock: vi.fn(),
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
  mqttListSavedTopicConfigs: mqttListSavedTopicConfigsMock,
  mqttGetMessages: mqttGetMessagesMock,
  mqttSubscribe: vi.fn(),
  mqttUnsubscribe: vi.fn(),
  mqttSaveTopicConfig: vi.fn(),
  mqttDeleteTopicConfig: vi.fn(),
  mqttClearMessages: vi.fn(),
}));

const mountedApps: App[] = [];

async function settleConsole() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountConsole(initialTopic = "device/status") {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(MqttAdminConsole, {
    connectionId: "mqtt-connection-1",
    initialTopic,
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await settleConsole();
  return container;
}

function publishTopicInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".publish-panel input");
  expect(input).not.toBeNull();
  return input!;
}

async function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settleConsole();
}

async function openNewSubscription(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("新建订阅"));
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleConsole();
}

async function openExistingSubscription(container: HTMLElement) {
  const editTitle = i18n.global.t("connection.mqttSubscriptionEdit");
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button[title]")).find((candidate) => candidate.title === editTitle);
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleConsole();
}

function subscriptionTopicInput(): HTMLInputElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const input = dialog!.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
  expect(input).not.toBeNull();
  return input!;
}

async function saveSubscription() {
  const saveText = i18n.global.t("common.save");
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((candidate) => candidate.textContent?.trim() === saveText);
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleConsole();
  await settleConsole();
}

beforeEach(async () => {
  mqttListSavedTopicConfigsMock.mockReset().mockResolvedValue([{ topic: "device/status", qos: "atmostonce", enabled: true, noLocal: false }]);
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

describe("MQTT 订阅编辑不覆盖发布 Topic (issue #11830)", () => {
  it("编辑订阅时保留发布框里已有的 Topic", async () => {
    const container = await mountConsole();
    const publishInput = publishTopicInput(container);
    await setInputValue(publishInput, "manual/publish/topic");

    await openExistingSubscription(container);
    await setInputValue(subscriptionTopicInput(), "device/updated");
    await saveSubscription();

    expect(publishTopicInput(container).value).toBe("manual/publish/topic");
  });

  it("新增订阅时保留发布框里已有的 Topic", async () => {
    const container = await mountConsole();
    const publishInput = publishTopicInput(container);
    await setInputValue(publishInput, "manual/publish/topic");

    await openNewSubscription(container);
    await setInputValue(subscriptionTopicInput(), "device/new");
    await saveSubscription();

    expect(publishTopicInput(container).value).toBe("manual/publish/topic");
  });

  it("发布框为空时新增订阅会预填其 Topic", async () => {
    const container = await mountConsole("");
    expect(publishTopicInput(container).value).toBe("");

    await openNewSubscription(container);
    await setInputValue(subscriptionTopicInput(), "device/new");
    await saveSubscription();

    expect(publishTopicInput(container).value).toBe("device/new");
  });
});

it("restores and saves a display alias without changing the broker topic (#13720)", async () => {
  mqttListSavedTopicConfigsMock.mockResolvedValue([{ topic: "device/status", alias: "设备状态", qos: "atmostonce", enabled: true }]);
  const container = await mountConsole();
  await openExistingSubscription(container);
  const alias = document.querySelector<HTMLInputElement>("input[data-mqtt-topic-alias]");
  expect(alias?.value).toBe("设备状态");
  await setInputValue(alias!, "  温度传感器  ");
  await saveSubscription();
  const api = await import("@/lib/backend/api");
  expect(api.mqttSaveTopicConfig).toHaveBeenCalledWith("mqtt-connection-1", "device/status", "atmostonce", false, true, "温度传感器");
});

it("allows clearing an existing alias (#13720)", async () => {
  mqttListSavedTopicConfigsMock.mockResolvedValue([{ topic: "device/status", alias: "旧别名", qos: "atmostonce", enabled: true }]);
  const container = await mountConsole();
  await openExistingSubscription(container);
  await setInputValue(document.querySelector<HTMLInputElement>("input[data-mqtt-topic-alias]")!, "");
  await saveSubscription();
  const api = await import("@/lib/backend/api");
  expect(api.mqttSaveTopicConfig).toHaveBeenCalledWith("mqtt-connection-1", "device/status", "atmostonce", false, true, "");
});

it("starts a new subscription with an empty alias (#13720)", async () => {
  const container = await mountConsole();
  await openNewSubscription(container);
  expect(document.querySelector<HTMLInputElement>("input[data-mqtt-topic-alias]")?.value).toBe("");
});
