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

function buttonWithExactText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
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
    supportsResetCursor: true,
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

describe("SubscriptionsPanel Kafka absolute offset reset", () => {
  async function openAbsoluteReset(panel: HTMLDivElement) {
    await vi.waitFor(() => {
      expect([...panel.querySelectorAll("button")].some((button) => button.textContent?.includes("mqSubscriptions.resetCursor"))).toBe(true);
    });
    buttonByText(panel, "mqSubscriptions.resetCursor").click();
    await flushUi();
    const absolute = panel.querySelector<HTMLInputElement>('input[value="partitionOffset"]');
    expect(absolute).toBeTruthy();
    absolute!.checked = true;
    absolute!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-testid="reset-partition"]')).toBeTruthy();
    });
  }

  it("shows Kafka-only partition fields and dispatches one exact absolute offset", async () => {
    backend.mqResetCursor.mockResolvedValue(undefined);
    const panel = await mountPanel();
    await openAbsoluteReset(panel);

    const partition = panel.querySelector<HTMLInputElement>('[data-testid="reset-partition"]');
    const offset = panel.querySelector<HTMLInputElement>('[data-testid="reset-offset"]');
    expect(partition).toBeTruthy();
    expect(offset).toBeTruthy();
    partition!.value = "1";
    partition!.dispatchEvent(new Event("input", { bubbles: true }));
    offset!.value = "42";
    offset!.dispatchEvent(new Event("input", { bubbles: true }));

    buttonWithExactText(panel, "mqSubscriptions.reset").click();
    await flushUi();

    expect(backend.mqResetCursor).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "orders-consumer", { kind: "partitionOffset", partition: 1, offset: 42 });
  });

  it.each([
    ["partition", "-1"],
    ["partition", "1.5"],
    ["offset", "-1"],
    ["offset", "42.5"],
    ["offset", "9007199254740992"],
  ])("rejects invalid %s value %s", async (field, value) => {
    const panel = await mountPanel();
    await openAbsoluteReset(panel);
    const input = panel.querySelector<HTMLInputElement>(`[data-testid="reset-${field}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    buttonWithExactText(panel, "mqSubscriptions.reset").click();
    await vi.waitFor(() => {
      expect(panel.textContent).toContain("mqSubscriptions.nonNegativeIntegerRequired");
    });
    expect(backend.mqResetCursor).not.toHaveBeenCalled();
  });

  it("hides the absolute offset option outside Kafka", async () => {
    const pulsarPanel = await mountPanel({ mqSystemKind: "pulsar", tenant: "public" });
    await vi.waitFor(() => {
      expect([...pulsarPanel.querySelectorAll("button")].some((button) => button.textContent?.includes("mqSubscriptions.resetCursor"))).toBe(true);
    });
    buttonByText(pulsarPanel, "mqSubscriptions.resetCursor").click();
    await flushUi();
    expect(pulsarPanel.querySelector('input[value="partitionOffset"]')).toBeNull();
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
