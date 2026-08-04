// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import type { MqSystemKind, PeekedMessage } from "@/types/mq";

const backend = vi.hoisted(() => ({
  mqPeekMessages: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  mqPeekMessages: backend.mqPeekMessages,
}));

vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());

import MessageBrowser from "@/components/mq/MessageBrowser.vue";

const TOPIC = {
  tenant: "_kafka",
  namespace: "default",
  topic: "events",
  persistent: true,
  partitioned: false,
};

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

async function setInputValue(input: HTMLInputElement, value: string) {
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

async function mountBrowser(mqSystemKind: "kafka" | "rabbitmq" = "kafka") {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(MessageBrowser, {
    connectionId: "mq-1",
    topic: { ...TOPIC, tenant: mqSystemKind === "rabbitmq" ? "_rabbitmq" : "_kafka" },
    mqSystemKind,
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function mountBrowserWithMutableTopic() {
  const topic = ref({ ...TOPIC });
  const connectionId = ref("mq-1");
  const mqSystemKind = ref<MqSystemKind>("kafka");
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp({
    setup: () => () =>
      h(MessageBrowser, {
        connectionId: connectionId.value,
        topic: topic.value,
        mqSystemKind: mqSystemKind.value,
      }),
  });
  app.mount(root);
  await flushUi();
  return { browser: root, topic, connectionId, mqSystemKind };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadMessages(container: ParentNode) {
  buttonByText(container, "mqMessages.loadMessages").click();
  await flushUi();
}

beforeEach(() => {
  backend.mqPeekMessages.mockReset();
  backend.mqPeekMessages.mockResolvedValue([
    {
      position: 1,
      messageId: "17",
      payloadBase64: "",
      payloadText: "existing message",
      properties: { partition: "0" },
      headers: {},
    },
  ]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("MessageBrowser", () => {
  it("loads Kafka's latest messages by default", async () => {
    const browser = await mountBrowser();

    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "latest" });
  });

  it("normalizes a decimal count before sending the request", async () => {
    const browser = await mountBrowser();
    const countInput = browser.querySelector<HTMLInputElement>('[data-testid="peek-count"]');
    if (!countInput) throw new Error("Peek count input not found");

    await setInputValue(countInput, "2.9");
    await loadMessages(browser);

    expect(countInput.value).toBe("2");
    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 2, { startPosition: "latest" });
  });

  it("shows an explicit warning when the broker returns an incomplete snapshot", async () => {
    backend.mqPeekMessages.mockResolvedValueOnce({
      messages: [
        {
          position: 1,
          messageId: "partial",
          payloadBase64: "",
          payloadText: "partial message",
          properties: {},
          headers: {},
        },
      ],
      incomplete: true,
    });
    const browser = await mountBrowser();

    await loadMessages(browser);

    expect(browser.querySelector('[data-testid="peek-incomplete"]')?.textContent).toContain("mqMessages.peekIncomplete");
    expect(browser.textContent).toContain("partial message");
  });

  it("sends explicit earliest and offset read positions", async () => {
    const browser = await mountBrowser();
    const startPosition = browser.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position select not found");

    await setSelectValue(startPosition, "earliest");
    await loadMessages(browser);
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "earliest" });

    await setSelectValue(startPosition, "offset");
    const partition = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-partition"]');
    const offset = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!partition || !offset) throw new Error("Kafka offset inputs not found");
    await setInputValue(partition, "2");
    await setInputValue(offset, "17");
    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "offset", partition: 2, offset: 17 });
  });

  it("allows an all-partition offset read but requires an offset", async () => {
    const browser = await mountBrowser();
    const startPosition = browser.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position control not found");

    await setSelectValue(startPosition, "offset");
    await loadMessages(browser);
    expect(backend.mqPeekMessages).not.toHaveBeenCalled();
    expect(browser.textContent).toContain("mqMessages.offsetRequiredForOffset");

    const offset = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!offset) throw new Error("Kafka offset input not found");
    await setInputValue(offset, "-1");
    await loadMessages(browser);
    expect(backend.mqPeekMessages).not.toHaveBeenCalled();
    expect(browser.textContent).toContain("mqMessages.offsetMustBeNonNegativeIntRequired");

    await setInputValue(offset, "17");
    await loadMessages(browser);
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "offset", offset: 17 });
  });

  it("clears results and does not leak an offset into a different read mode", async () => {
    const browser = await mountBrowser();
    const startPosition = browser.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    const partition = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-partition"]');
    if (!startPosition || !partition) throw new Error("Kafka start position controls not found");

    await loadMessages(browser);
    expect(browser.textContent).toContain("existing message");

    await setSelectValue(startPosition, "offset");
    expect(browser.textContent).not.toContain("existing message");
    await setInputValue(partition, "2");
    const offset = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    if (!offset) throw new Error("Kafka offset input not found");
    await setInputValue(offset, "17");

    await setSelectValue(startPosition, "latest");
    await loadMessages(browser);
    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "latest", partition: 2 });
  });

  it("ignores an older topic request that resolves after the current request", async () => {
    const first = deferred<PeekedMessage[]>();
    const second = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { browser, topic } = await mountBrowserWithMutableTopic();

    await loadMessages(browser);
    topic.value = { ...TOPIC, topic: "payments" };
    await flushUi();
    await loadMessages(browser);

    second.resolve([
      {
        position: 1,
        messageId: "new",
        payloadBase64: "",
        payloadText: "new topic message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();
    expect(browser.textContent).toContain("new topic message");

    first.resolve([
      {
        position: 1,
        messageId: "old",
        payloadBase64: "",
        payloadText: "old topic message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();

    expect(browser.textContent).toContain("new topic message");
    expect(browser.textContent).not.toContain("old topic message");
  });

  it("invalidates a request when the topic persistence changes", async () => {
    const first = deferred<PeekedMessage[]>();
    const second = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { browser, topic } = await mountBrowserWithMutableTopic();

    await loadMessages(browser);
    topic.value = { ...TOPIC, persistent: false };
    await flushUi();
    await loadMessages(browser);

    second.resolve([
      {
        position: 1,
        messageId: "non-persistent",
        payloadBase64: "",
        payloadText: "new persistence message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();
    first.resolve([
      {
        position: 1,
        messageId: "persistent",
        payloadBase64: "",
        payloadText: "stale persistence message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();

    expect(browser.textContent).toContain("new persistence message");
    expect(browser.textContent).not.toContain("stale persistence message");
  });

  it("ignores an older topic request failure after the current request succeeds", async () => {
    const first = deferred<PeekedMessage[]>();
    const second = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { browser, topic } = await mountBrowserWithMutableTopic();

    await loadMessages(browser);
    topic.value = { ...TOPIC, topic: "payments" };
    await flushUi();
    await loadMessages(browser);

    second.resolve([
      {
        position: 1,
        messageId: "new",
        payloadBase64: "",
        payloadText: "new topic message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();

    first.reject(new Error("old topic request failed"));
    await flushUi();

    expect(browser.textContent).toContain("new topic message");
    expect(browser.textContent).not.toContain("old topic request failed");
  });

  it("ignores an older connection request after the connection changes", async () => {
    const first = deferred<PeekedMessage[]>();
    const second = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { browser, connectionId } = await mountBrowserWithMutableTopic();

    await loadMessages(browser);
    connectionId.value = "mq-2";
    await flushUi();
    await loadMessages(browser);

    second.resolve([
      {
        position: 1,
        messageId: "new-connection",
        payloadBase64: "",
        payloadText: "new connection message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();
    expect(browser.textContent).toContain("new connection message");

    first.resolve([
      {
        position: 1,
        messageId: "old-connection",
        payloadBase64: "",
        payloadText: "old connection message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();

    expect(browser.textContent).toContain("new connection message");
    expect(browser.textContent).not.toContain("old connection message");
  });

  it("ignores an older start-mode request that resolves after the mode switches", async () => {
    const first = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise);
    const browser = await mountBrowser();
    const startPosition = browser.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position select not found");

    await loadMessages(browser);
    await setSelectValue(startPosition, "earliest");
    expect(browser.textContent).not.toContain("latest-mode message");

    first.resolve([
      {
        position: 1,
        messageId: "stale",
        payloadBase64: "",
        payloadText: "latest-mode message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();

    expect(browser.textContent).not.toContain("latest-mode message");
    expect(browser.querySelector(".panel-error")).toBeNull();
    expect(browser.textContent).toContain("mqMessages.noMessages");
  });

  it("ignores an older start-mode failure after the mode switches and a new load succeeds", async () => {
    const first = deferred<PeekedMessage[]>();
    const second = deferred<PeekedMessage[]>();
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const browser = await mountBrowser();
    const startPosition = browser.querySelector<HTMLElement>('[data-testid="kafka-peek-start-position"]');
    if (!startPosition) throw new Error("Kafka start position select not found");

    await loadMessages(browser);
    await setSelectValue(startPosition, "earliest");
    await loadMessages(browser);

    second.resolve([
      {
        position: 1,
        messageId: "fresh",
        payloadBase64: "",
        payloadText: "earliest-mode message",
        properties: {},
        headers: {},
      },
    ]);
    await flushUi();
    expect(browser.textContent).toContain("earliest-mode message");

    first.reject(new Error("latest-mode request failed"));
    await flushUi();

    expect(browser.textContent).toContain("earliest-mode message");
    expect(browser.textContent).not.toContain("latest-mode request failed");
  });

  it("keeps RabbitMQ's advanced filters collapsed and sends its existing request shape", async () => {
    const browser = await mountBrowser("rabbitmq");

    expect(browser.querySelector('input[placeholder="mqMessages.partitionPlaceholderAll"]')).toBeNull();
    buttonByText(browser, "mqMessages.advancedFilter").click();
    await nextTick();
    const partition = browser.querySelector<HTMLInputElement>('input[placeholder="mqMessages.partitionPlaceholderAll"]');
    const offset = browser.querySelector<HTMLInputElement>('input[placeholder="mqMessages.offsetPlaceholderEarliest"]');
    if (!partition || !offset) throw new Error("RabbitMQ advanced filter inputs not found");
    await setInputValue(partition, "2");
    await setInputValue(offset, "17");
    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ tenant: "_rabbitmq", topic: "events" }), "__dbx_kafka_viewer__", 20, { partition: 2, offset: 17 });
  });
});
