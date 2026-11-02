// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
const backend = vi.hoisted(() => ({ mqListTopics: vi.fn().mockResolvedValue([]), mqSendMessage: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
vi.mock("@/composables/useMqMutationGuard", () => ({ useMqMutationGuard: () => ({ confirmMqWrite: async () => true }) }));
vi.mock("@/components/mq/MessageBrowser.vue", () => ({ default: { render: () => null } }));
import SendMessagePanel from "../SendMessagePanel.vue";
import RocketMqMessageDetailDialog from "../shared/RocketMqMessageDetailDialog.vue";
import type { SendMessageResponse } from "@/types/mq";
let app: App;
let root: HTMLDivElement;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.clearAllMocks();
});

describe("MQ send response queue identity", () => {
  it.each([undefined, null, 0, 3])("preserves known Kafka partitions and renders unknown %s without fabricated offsets", async (partition) => {
    backend.mqSendMessage.mockResolvedValue({ topic: "events", partition, offset: 42 });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SendMessagePanel, { connectionId: "kafka", tenant: "flat", namespace: "flat", mqSystemKind: "kafka", fixedTopic: true, supportsPeekMessages: false, topic: { name: "events", shortName: "events", persistent: true, partitioned: false } });
    app.mount(root);
    await flush();
    const payload = root.querySelector<HTMLTextAreaElement>("textarea")!;
    payload.value = "body";
    payload.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "mqMessages.sendMessage")!.click();
    await flush();
    await flush();
    const message = root.querySelector(".panel-success")?.textContent;
    expect(message).toContain(JSON.stringify({ partition: partition ?? "-", offset: partition == null ? "-" : 42 }));
  });
  it.each([undefined, null])("does not promise queue or offset on RocketMQ detail resend with partition %s", (partition) => {
    const response: SendMessageResponse = { topic: "events", partition, offset: 42 };
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(RocketMqMessageDetailDialog, { message: { topic: "events", payload: "body" }, resendSuccess: response });
    app.mount(root);
    expect(root.querySelector(".panel-success")?.textContent?.trim()).toBe("mqMessages.sendSuccessRocketmq");
    expect(root.querySelector(".panel-success")?.textContent).not.toContain("42");
  });
});
