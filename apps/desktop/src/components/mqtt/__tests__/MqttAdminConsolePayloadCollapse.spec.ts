// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import MqttAdminConsole from "@/components/mqtt/MqttAdminConsole.vue";
import type { MqttBrokerInfo, MqttMessage } from "@/types/mqtt";

const { mqttClearMessagesMock, mqttGetMessagesMock } = vi.hoisted(() => ({
  mqttClearMessagesMock: vi.fn(),
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
  mqttClearMessages: mqttClearMessagesMock,
}));

const mountedApps: App[] = [];

function messageAt(payload: string, receivedAtMs: number): MqttMessage {
  return {
    topic: `device/${payload}`,
    payloadBase64: btoa(payload),
    payloadText: payload,
    qos: 0,
    retain: false,
    receivedAtMs,
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
  await settleConsole();
  return container;
}

async function settleConsole() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function payloadToggles(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="mqtt-message-payload-toggle"]'));
}

function payloads(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="mqtt-message-payload"]'));
}

async function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
}

async function setPayloadSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="mqtt-payload-search"]');
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

beforeEach(() => {
  mqttGetMessagesMock.mockReset().mockResolvedValue([]);
  mqttClearMessagesMock.mockReset().mockResolvedValue(undefined);
  i18n.global.locale.value = "en";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("MQTT message payload collapse (issue #9307)", () => {
  it("starts every message payload expanded", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha", 1_700_000_000_001), messageAt("payload-beta", 1_700_000_000_002)]);

    const container = await mountConsole();
    const toggles = payloadToggles(container);
    const messagePayloads = payloads(container);

    expect(toggles).toHaveLength(2);
    expect(messagePayloads).toHaveLength(2);
    expect(toggles.every((toggle) => toggle.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(toggles.every((toggle) => toggle.textContent?.includes("Collapse payload"))).toBe(true);
    expect(messagePayloads.every((payload) => !payload.hidden)).toBe(true);
    expect(toggles.every((toggle) => container.querySelector(`#${toggle.getAttribute("aria-controls")}`))).toBe(true);
  });

  it("toggles each message payload independently without selecting its topic", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha", 1_700_000_000_001), messageAt("payload-beta", 1_700_000_000_002)]);

    const container = await mountConsole();
    const callsAfterLoad = mqttGetMessagesMock.mock.calls.length;
    let toggles = payloadToggles(container);

    await click(toggles[0]);
    toggles = payloadToggles(container);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    expect(toggles[0].textContent).toContain("Expand payload");
    expect(payloads(container).map((payload) => payload.hidden)).toEqual([true, false]);
    expect(payloads(container)[0].textContent).toBe("");

    await click(toggles[1]);
    expect(payloads(container).map((payload) => payload.hidden)).toEqual([true, true]);

    toggles = payloadToggles(container);
    await click(toggles[0]);
    expect(payloads(container).map((payload) => payload.hidden)).toEqual([false, true]);
    expect(mqttGetMessagesMock).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("keeps collapse state with the same message while payload search changes indexes", async () => {
    mqttGetMessagesMock.mockResolvedValueOnce([messageAt("payload-alpha", 1_700_000_000_001), messageAt("payload-beta", 1_700_000_000_002)]);

    const container = await mountConsole();
    await click(payloadToggles(container)[1]);

    await setPayloadSearch(container, "beta");
    expect(payloadToggles(container)).toHaveLength(1);
    expect(payloadToggles(container)[0].getAttribute("aria-expanded")).toBe("false");
    expect(payloads(container)[0].hidden).toBe(true);

    await setPayloadSearch(container, "");
    expect(payloadToggles(container).map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(payloads(container).map((payload) => payload.hidden)).toEqual([false, true]);
  });

  it("clears collapse state when messages are cleared", async () => {
    const message = messageAt("payload-alpha", 1_700_000_000_001);
    mqttGetMessagesMock.mockResolvedValueOnce([message]);

    const container = await mountConsole();
    await click(payloadToggles(container)[0]);
    expect(payloads(container)[0].hidden).toBe(true);

    const clearButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Clear messages");
    expect(clearButton).toBeTruthy();
    await click(clearButton!);
    await settleConsole();

    expect(mqttClearMessagesMock).toHaveBeenCalledWith("mqtt-connection-1");
    expect(container.querySelectorAll('[data-testid="mqtt-message"]')).toHaveLength(0);

    mqttGetMessagesMock.mockResolvedValueOnce([message]);
    const refreshButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Refresh");
    expect(refreshButton).toBeTruthy();
    await click(refreshButton!);
    await settleConsole();

    expect(payloadToggles(container)[0].getAttribute("aria-expanded")).toBe("true");
    expect(payloads(container)[0].hidden).toBe(false);
  });
});
