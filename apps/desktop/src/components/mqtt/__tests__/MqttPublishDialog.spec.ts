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

    handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 180 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 180 }));
    await nextTick();

    expect(textarea?.style.height).toBe("200px");
    expect(localStorage.getItem("dbx-mqtt-payload-height")).toBe("200");
  });
});
