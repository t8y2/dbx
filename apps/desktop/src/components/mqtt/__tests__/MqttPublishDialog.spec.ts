// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import MqttPublishDialog from "@/components/mqtt/MqttPublishDialog.vue";

const { mqttPublishMock } = vi.hoisted(() => ({
  mqttPublishMock: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  mqttPublish: mqttPublishMock,
}));

const mountedApps: App[] = [];

async function mountPublishDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(MqttPublishDialog, {
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
  mqttPublishMock.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  await loadLocaleMessages("zh-CN");
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("MQTT 消息发布输入框", () => {
  it("支持从顶部拖动调节高度并记住设置", async () => {
    const container = await mountPublishDialog();
    const handle = container.querySelector<HTMLElement>(".payload-resize-handle");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(handle?.getAttribute("aria-label")).toBe("拖动调节消息输入框高度");
    expect(handle?.getAttribute("role")).toBe("separator");
    expect(handle?.getAttribute("aria-orientation")).toBe("horizontal");

    handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 180 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 180 }));
    await nextTick();

    expect(textarea?.style.height).toBe("200px");
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe("200");
  });

  it("支持键盘调节高度并记住设置", async () => {
    const container = await mountPublishDialog();
    const handle = container.querySelector<HTMLElement>(".payload-resize-handle");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");

    expect(handle?.tabIndex).toBe(0);
    handle?.focus();
    expect(document.activeElement).toBe(handle);

    handle?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }));
    await nextTick();

    expect(textarea?.style.height).toBe("90px");
    expect(handle?.getAttribute("aria-valuenow")).toBe("90");
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe("90");

    handle?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
    await nextTick();

    expect(textarea?.style.height).toBe("80px");
    expect(handle?.getAttribute("aria-valuenow")).toBe("80");
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe("80");
  });

  it("将键盘调节限制在分隔条声明的高度范围内", async () => {
    const container = await mountPublishDialog();
    const handle = container.querySelector<HTMLElement>(".payload-resize-handle");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const minHeight = Number(handle?.getAttribute("aria-valuemin"));
    const maxHeight = Number(handle?.getAttribute("aria-valuemax"));

    for (let i = 0; i < 100; i++) handle?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await nextTick();

    expect(textarea?.style.height).toBe(`${minHeight}px`);
    expect(handle?.getAttribute("aria-valuenow")).toBe(minHeight.toString());
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe(minHeight.toString());

    for (let i = 0; i < 100; i++) handle?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    await nextTick();

    expect(textarea?.style.height).toBe(`${maxHeight}px`);
    expect(handle?.getAttribute("aria-valuenow")).toBe(maxHeight.toString());
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe(maxHeight.toString());
  });
});
