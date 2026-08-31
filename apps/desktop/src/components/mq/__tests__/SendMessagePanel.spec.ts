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

vi.mock("@/composables/useMqMutationGuard", () => ({
  useMqMutationGuard: () => ({ confirmMqWrite: vi.fn().mockResolvedValue(true) }),
}));

vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());

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

async function setSelectValue(trigger: HTMLElement, value: string) {
  trigger.click();
  await flushUi();
  const item = document.querySelector<HTMLElement>(`[data-slot="select-item"][data-value="${value}"]`);
  if (!item) throw new Error(`Select item not found: ${value}`);
  item.click();
  await flushUi();
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

      expect(panel.querySelector('[data-testid="message-browser"]')?.classList.contains("message-browser")).toBe(true);
      expect(panel.querySelector('[data-testid="message-browser"]')?.classList.contains("is-monitoring")).toBe(false);
      await loadMessages(panel);
      expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic(system), "__dbx_kafka_viewer__", 20, system === "kafka" ? { startPosition: "latest" } : {});
      expect(panel.textContent).toContain("existing message");

      await sendMessage(panel, "new message");

      expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);
      expect(panel.textContent).toContain("existing message");
    });
  }

  it("sends Kafka's selected start position and specific offset", async () => {
    const panel = await mountPanel("kafka");

    const startPosition = panel.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position select not found");
    await setSelectValue(startPosition, "earliest");
    await loadMessages(panel);
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { startPosition: "earliest" });

    await setSelectValue(startPosition, "offset");
    const partitionInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-partition"]');
    const offsetInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!partitionInput || !offsetInput) throw new Error("Kafka offset inputs not found");
    await setInputValue(partitionInput, "2");
    await setInputValue(offsetInput, "17");

    await sendMessage(panel, "new message");

    expect(partitionInput.value).toBe("2");
    expect(offsetInput.value).toBe("17");
    expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);

    await loadMessages(panel);
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { startPosition: "offset", partition: 2, offset: 17 });
  });

  it("keeps Kafka's result limit within the supported range", async () => {
    const panel = await mountPanel("kafka");
    const countInput = panel.querySelector<HTMLInputElement>('[data-testid="peek-count"]');
    if (!countInput) throw new Error("Peek count input not found");

    await setInputValue(countInput, "999");
    await loadMessages(panel);

    expect(countInput.value).toBe("100");
    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 100, { startPosition: "latest" });

    await setInputValue(countInput, "");
    await loadMessages(panel);

    expect(countInput.value).toBe("20");
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { startPosition: "latest" });
  });

  it("does not request Kafka offset mode without an offset", async () => {
    const panel = await mountPanel("kafka");
    const startPosition = panel.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position control not found");

    await setSelectValue(startPosition, "offset");
    await loadMessages(panel);
    expect(backend.mqPeekMessages).not.toHaveBeenCalled();
    expect(panel.textContent).toContain("mqMessages.offsetRequiredForOffset");

    const offsetInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!offsetInput) throw new Error("Kafka offset input not found");
    await setInputValue(offsetInput, "17");
    await loadMessages(panel);
    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { startPosition: "offset", offset: 17 });
  });

  it("clears Kafka results and validation errors when the start position changes", async () => {
    const panel = await mountPanel("kafka");
    const startPosition = panel.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position select not found");

    await loadMessages(panel);
    expect(panel.textContent).toContain("existing message");

    await setSelectValue(startPosition, "offset");
    expect(panel.textContent).not.toContain("existing message");

    await loadMessages(panel);
    expect(panel.textContent).toContain("mqMessages.offsetRequiredForOffset");

    await setSelectValue(startPosition, "earliest");
    expect(panel.textContent).not.toContain("existing message");
    expect(panel.textContent).not.toContain("mqMessages.offsetRequiredForOffset");
  });

  it("does not leak a saved Kafka offset after switching start positions", async () => {
    const panel = await mountPanel("kafka");
    const startPosition = panel.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    const partitionInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-partition"]');
    if (!startPosition || !partitionInput) throw new Error("Kafka start position controls not found");

    await setSelectValue(startPosition, "offset");
    const offsetInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!offsetInput) throw new Error("Kafka offset input not found");
    await setInputValue(partitionInput, "2");
    await setInputValue(offsetInput, "17");

    await setSelectValue(startPosition, "latest");
    await loadMessages(panel);

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic("kafka"), "__dbx_kafka_viewer__", 20, { startPosition: "latest", partition: 2 });
    await setSelectValue(startPosition, "offset");
    const restoredOffsetInput = panel.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    expect(restoredOffsetInput?.value).toBe("17");
  });

  it("keeps RabbitMQ advanced-filter requests unchanged", async () => {
    const panel = await mountPanel("rabbitmq");

    buttonByText(panel, "mqMessages.advancedFilter").click();
    await flushUi();
    const partitionInput = panel.querySelector<HTMLInputElement>('input[placeholder="mqMessages.partitionPlaceholderAll"]');
    const offsetInput = panel.querySelector<HTMLInputElement>('input[placeholder="mqMessages.offsetPlaceholderEarliest"]');
    if (!partitionInput || !offsetInput) throw new Error("RabbitMQ advanced filter inputs not found");
    await setInputValue(partitionInput, "2");
    await setInputValue(offsetInput, "17");

    await loadMessages(panel);
    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expectedTopic("rabbitmq"), "__dbx_kafka_viewer__", 20, { partition: 2, offset: 17 });
  });
});
