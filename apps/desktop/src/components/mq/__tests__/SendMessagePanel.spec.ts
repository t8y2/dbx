// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
  mqPeekMessages: vi.fn(),
  mqSendMessage: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  mqListTopics: backend.mqListTopics,
  mqPeekMessages: backend.mqPeekMessages,
  mqSendMessage: backend.mqSendMessage,
}));

import SendMessagePanel from "@/components/mq/SendMessagePanel.vue";

const TOPIC = {
  name: "persistent://public/default/events",
  shortName: "events",
  partitioned: false,
  persistent: true,
};

type BrowseableSystem = "kafka" | "rabbitmq";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

function expectedTopic(system: BrowseableSystem) {
  return {
    tenant: system === "rabbitmq" ? "_rabbitmq" : "_kafka",
    namespace: "default",
    topic: TOPIC.shortName,
    persistent: true,
    partitioned: false,
  };
}

async function mountPanel(system: BrowseableSystem) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(SendMessagePanel, {
    connectionId: "mq-1",
    tenant: system === "rabbitmq" ? "_rabbitmq" : "_kafka",
    namespace: "default",
    topic: TOPIC,
    mqSystemKind: system,
    isFlatMqCluster: true,
    supportsPeekMessages: true,
  });
  app.config.globalProperties.$t = (key: string) => key;
  app.mount(root);
  await flushUi();
  return root;
}

async function sendMessage(container: ParentNode, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".code-textarea");
  if (!textarea) throw new Error("Message textarea not found");
  await setInputValue(textarea, value);
  buttonByText(container, "mqMessages.sendMessage").click();
  await flushUi();
}

async function loadMessages(container: ParentNode) {
  const button = buttonByText(container, "mqMessages.loadMessages");
  if (button.disabled) throw new Error("Load messages button is disabled");
  button.click();
  await flushUi();
}

beforeEach(() => {
  backend.mqListTopics.mockReset();
  backend.mqPeekMessages.mockReset();
  backend.mqSendMessage.mockReset();
  backend.mqListTopics.mockResolvedValue([TOPIC]);
  backend.mqPeekMessages.mockResolvedValue([
    {
      position: 1,
      messageId: "0",
      payloadBase64: "",
      payloadText: "existing message",
      properties: { partition: "0" },
      headers: {},
    },
  ]);
  backend.mqSendMessage.mockResolvedValue({ topic: TOPIC.shortName, partition: 2, offset: 17 });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("SendMessagePanel post-send browsing", () => {
  for (const system of ["kafka", "rabbitmq"] as const) {
    it(`keeps ${system} results unchanged after sending`, async () => {
      const panel = await mountPanel(system);

      await loadMessages(panel);
      expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic(system), "__dbx_kafka_viewer__", 20, {});
      expect(panel.textContent).toContain("existing message");

      await sendMessage(panel, "new message");

      expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);
      expect(panel.textContent).toContain("existing message");
    });
  }

  it("preserves Kafka advanced filters until the user explicitly loads messages", async () => {
    const panel = await mountPanel("kafka");

    buttonByText(panel, "mqMessages.advancedFilter").click();
    await flushUi();
    const partitionInput = panel.querySelector<HTMLInputElement>('input[placeholder="mqMessages.partitionPlaceholderAll"]');
    const offsetInput = panel.querySelector<HTMLInputElement>('input[placeholder="mqMessages.offsetPlaceholderEarliest"]');
    if (!partitionInput || !offsetInput) throw new Error("Advanced filter inputs not found");
    await setInputValue(partitionInput, "2");
    await setInputValue(offsetInput, "17");

    await sendMessage(panel, "new message");

    expect(partitionInput.value).toBe("2");
    expect(offsetInput.value).toBe("17");
    expect(backend.mqPeekMessages).not.toHaveBeenCalled();

    await loadMessages(panel);
    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { partition: 2, offset: 17 });
  });
});
