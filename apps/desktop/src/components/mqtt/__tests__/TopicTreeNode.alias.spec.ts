// @vitest-environment happy-dom
import { createApp, nextTick, h } from "vue";
import { describe, it, expect, vi } from "vitest";
import TopicTreeNode from "@/components/mqtt/TopicTreeNode.vue";
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
describe("MQTT topic aliases #13720", () => {
  it.each(["设备", "device/status"])("finds a saved subscription by %s without changing its actual topic", async (filter) => {
    const host = document.createElement("div");
    document.body.append(host);
    const select = vi.fn();
    const app = createApp({
      render: () =>
        h(TopicTreeNode, {
          node: { name: "device", fullPath: "device", isLeaf: false, children: [{ name: "status", fullPath: "device/status", isLeaf: true, children: [] }] },
          depth: 0,
          selectedTopic: "",
          subscribedTopics: [],
          savedTopics: [{ topic: "device/status", alias: "设备状态", qos: "atmostonce" }],
          filter,
          onSelect: select,
        }),
    });
    try {
      app.mount(host);
      await nextTick();
      expect(host.textContent).toContain("设备状态");
      host.querySelector<HTMLButtonElement>('button[title="device/status"]')!.click();
      expect(select).toHaveBeenCalledWith("device/status");
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
