// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import type { PeekedMessage } from "@/types/mq";

const backend = vi.hoisted(() => ({
  mqListSubscriptions: vi.fn(),
  mqEnrichSubscriptions: vi.fn(),
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

vi.mock("@/composables/useMqMutationGuard", () => ({
  useMqMutationGuard: () => ({ confirmMqWrite: vi.fn().mockResolvedValue(true) }),
}));

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

async function mountPanel(overrides: Record<string, unknown> = {}) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(SubscriptionsPanel, {
    connectionId: "mq-1",
    topic: TOPIC,
    tenant: "_kafka",
    namespace: "default",
    mqSystemKind: "kafka",
    supportsPeekMessages: true,
    ...overrides,
  });
  app.mount(root);
  await flushUi();
  return root;
}

function subscription(name: string, consumerGroupType: string) {
  return {
    name,
    subType: consumerGroupType,
    consumerGroupType,
    messageModel: "CLUSTERING",
    msgBacklog: 0,
    msgRateOut: 0,
    msgThroughputOut: 0,
    consumers: [],
  };
}

beforeEach(() => {
  Object.values(backend).forEach((mock) => mock.mockReset());
  const rows = [
    {
      name: "orders-consumer",
      subType: "shared",
      msgBacklog: 0,
      msgRateOut: 0,
      msgThroughputOut: 0,
      consumers: [],
    },
  ];
  backend.mqListSubscriptions.mockResolvedValue(rows);
  backend.mqEnrichSubscriptions.mockResolvedValue(rows);
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

describe("SubscriptionsPanel RocketMQ online members", () => {
  it("shows '-' when onlineMembers is unknown before enrich completes", async () => {
    const enrich = deferred<ReturnType<typeof subscription>[]>();
    const rows = [subscription("orders-group", "NORMAL")];
    backend.mqListSubscriptions.mockResolvedValue(rows);
    backend.mqEnrichSubscriptions.mockReturnValueOnce(enrich.promise);

    const panel = await mountPanel({
      topic: undefined,
      tenant: "_rocketmq",
      namespace: "default",
      mqSystemKind: "rocketmq",
      supportsPeekMessages: false,
    });

    // Fast list paints before enrich; unknown member count must not look like healthy zero.
    const membersCell = () => panel.querySelector('[data-testid="online-members"]')?.textContent?.trim();
    expect(membersCell()).toBe("-");

    enrich.resolve([{ ...rows[0], onlineMembers: 2, topics: ["orders"] }]);
    await flushUi();
    expect(membersCell()).toBe("2");
  });
});

describe("SubscriptionsPanel RocketMQ filter count", () => {
  it("updates the visible/total count when type filters or search change", async () => {
    const rows = [subscription("orders-group", "NORMAL"), subscription("payments-fifo", "FIFO"), subscription("CID_SYS_GROUP", "SYSTEM"), subscription("orders-retry", "NORMAL")];
    backend.mqListSubscriptions.mockResolvedValue(rows);
    backend.mqEnrichSubscriptions.mockResolvedValue(rows);

    const panel = await mountPanel({
      topic: undefined,
      tenant: "_rocketmq",
      namespace: "default",
      mqSystemKind: "rocketmq",
      supportsPeekMessages: false,
    });

    const count = () => panel.querySelector('[data-testid="subscription-count"]')?.textContent?.replace(/\s+/g, " ").trim();
    // Default: SYSTEM off → 3 type-filtered groups.
    expect(count()).toBe("3 / 3");

    const systemCheckbox = [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.toLowerCase().includes("system"));
    expect(systemCheckbox).toBeTruthy();
    expect(systemCheckbox!.checked).toBe(false);
    systemCheckbox!.click();
    await flushUi();
    expect(count()).toBe("4 / 4");

    const search = panel.querySelector<HTMLInputElement>("input.topic-search");
    expect(search).toBeTruthy();
    search!.focus();
    search!.value = "orders";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    expect(count()).toBe("2 / 4");
  });
});
