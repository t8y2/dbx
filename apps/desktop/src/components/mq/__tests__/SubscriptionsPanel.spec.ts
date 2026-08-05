// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import type { PeekedMessage } from "@/types/mq";

const backend = vi.hoisted(() => ({
  mqListSubscriptions: vi.fn(),
  mqCreateSubscription: vi.fn(),
  mqDeleteSubscription: vi.fn(),
  mqResetCursor: vi.fn(),
  mqSkipMessages: vi.fn(),
  mqClearBacklog: vi.fn(),
  mqPeekMessages: vi.fn(),
  mqExpireMessages: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => backend);

vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/components/mq/rocketmq/RocketMqConsumerGroupDialogs.vue", () => ({
  default: { template: "<div />" },
}));

import SubscriptionsPanel from "@/components/mq/SubscriptionsPanel.vue";

const TOPIC = {
  name: "persistent://public/default/events",
  shortName: "events",
  partitioned: false,
  persistent: true,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function mountPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(SubscriptionsPanel, {
    connectionId: "mq-1",
    topic: TOPIC,
    tenant: "_kafka",
    namespace: "default",
    mqSystemKind: "kafka",
    supportsPeekMessages: true,
  });
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.mqListSubscriptions.mockResolvedValue([
    {
      name: "orders-consumer",
      subType: "shared",
      msgBacklog: 0,
      msgRateOut: 0,
      msgThroughputOut: 0,
      consumers: [],
    },
  ]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("SubscriptionsPanel message peek", () => {
  it("warns when a Kafka peek is incomplete and clears the warning after a complete refresh", async () => {
    backend.mqPeekMessages
      .mockResolvedValueOnce({
        messages: [
          {
            position: 1,
            messageId: "17",
            payloadBase64: "",
            payloadText: "partial message",
            properties: { partition: "0" },
            headers: {},
          },
        ],
        incomplete: true,
      })
      .mockResolvedValueOnce({ messages: [], incomplete: false });
    const panel = await mountPanel();

    buttonByText(panel, "mqSubscriptions.peek").click();
    await flushUi();

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "orders-consumer", 5);
    expect(panel.querySelector('[data-testid="peek-incomplete"]')?.textContent).toContain("mqMessages.peekIncomplete");
    expect(panel.textContent).toContain("partial message");

    buttonByText(panel, "mqSubscriptions.refresh").click();
    await flushUi();

    expect(panel.querySelector('[data-testid="peek-incomplete"]')).toBeNull();
  });

  it("ignores a stale peek when another subscription is opened", async () => {
    const first = deferred<{ messages: PeekedMessage[]; incomplete: boolean }>();
    const second = deferred<{ messages: PeekedMessage[]; incomplete: boolean }>();
    backend.mqListSubscriptions.mockResolvedValue([
      {
        name: "orders-consumer",
        subType: "shared",
        msgBacklog: 0,
        msgRateOut: 0,
        msgThroughputOut: 0,
        consumers: [],
      },
      {
        name: "payments-consumer",
        subType: "shared",
        msgBacklog: 0,
        msgRateOut: 0,
        msgThroughputOut: 0,
        consumers: [],
      },
    ]);
    backend.mqPeekMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const panel = await mountPanel();

    const peekButtons = [...panel.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.includes("mqSubscriptions.peek"));
    expect(peekButtons).toHaveLength(2);
    peekButtons[0].click();
    await flushUi();
    peekButtons[1].click();
    await flushUi();

    second.resolve({
      messages: [{ position: 1, messageId: "new", payloadBase64: "", payloadText: "payments message", properties: {}, headers: {} }],
      incomplete: false,
    });
    await flushUi();
    first.resolve({
      messages: [{ position: 1, messageId: "old", payloadBase64: "", payloadText: "orders message", properties: {}, headers: {} }],
      incomplete: false,
    });
    await flushUi();

    expect(panel.textContent).toContain("payments message");
    expect(panel.textContent).not.toContain("orders message");
  });
});
