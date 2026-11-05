// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
const backend = vi.hoisted(() => ({ mqListTopics: vi.fn().mockResolvedValue([]), mqSendMessage: vi.fn().mockResolvedValue({ messageId: "sent" }) }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useMqMutationGuard", () => ({ useMqMutationGuard: () => ({ confirmMqWrite: async () => true }) }));
vi.mock("@/components/mq/MessageBrowser.vue", () => ({ default: { render: () => null } }));
import SendMessagePanel from "../SendMessagePanel.vue";
let app: App;
let root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.clearAllMocks();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
};

describe("RocketMQ proxy ordinary sending", () => {
  it("accepts a manual topic without requesting management data and sends ordinary key/tag/properties", async () => {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SendMessagePanel, { connectionId: "proxy", tenant: "_flat_mq", namespace: "_flat_mq", mqSystemKind: "rocketmq", supportsListTopics: false, supportsPeekMessages: false });
    app.mount(root);
    await flush();
    expect(backend.mqListTopics).not.toHaveBeenCalled();
    const topic = root.querySelector<HTMLInputElement>("input.topic-input")!;
    expect(topic).not.toBeNull();
    const set = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
    };
    await set(topic, "ManualTopic");
    const inputs = root.querySelectorAll<HTMLInputElement>(".form-group input");
    await set(inputs[1], "key-1");
    await set(inputs[2], "tag-1");
    await set(root.querySelector<HTMLTextAreaElement>("textarea")!, "hello");
    root.querySelector<HTMLButtonElement>(".collapse-toggle")!.click();
    await nextTick();
    const textareas = root.querySelectorAll<HTMLTextAreaElement>("textarea");
    await set(textareas[1], "trace: value");
    const send = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((el) => el.textContent?.includes("mqMessages.sendMessage"))!;
    send.click();
    await flush();
    await flush();
    expect(backend.mqSendMessage).toHaveBeenCalledWith("proxy", expect.objectContaining({ topic: "ManualTopic", key: "key-1", headers: { TAGS: "tag-1", trace: "value" }, payloadText: "hello" }));
    expect(backend.mqSendMessage.mock.calls[0][1]).not.toHaveProperty("partition");
    expect(backend.mqListTopics).not.toHaveBeenCalled();
    expect(root.textContent).toContain("mqMessages.sendSuccessRocketmq");
  });
});
