// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
  mqListTopicsPage: vi.fn(),
  mqCreateTopic: vi.fn(),
  mqDeleteTopic: vi.fn(),
  mqUpdatePartitions: vi.fn(),
  mqGetClusterInfo: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => backend);

vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          (props.items as unknown[]).flatMap((item) => slots.default?.({ item }) ?? []),
        );
    },
  }),
}));

vi.mock("@/composables/useMqMutationGuard", () => ({
  useMqMutationGuard: () => ({ confirmMqWrite: vi.fn().mockResolvedValue(true) }),
}));

vi.mock("@/components/mq/rocketmq/RocketMqTopicDialogs.vue", () => ({
  default: defineComponent({ setup: () => () => h("div") }),
}));

vi.mock("@/components/mq/SendMessagePanel.vue", () => ({
  default: defineComponent({ setup: () => () => h("div") }),
}));

vi.mock("@/components/mq/ExchangesPanel.vue", () => ({
  default: defineComponent({ setup: () => () => h("div") }),
}));

vi.mock("@/components/mq/shared/MqTypeFilterBar.vue", () => ({
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  }),
}));

vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: defineComponent({ setup: () => () => h("div") }),
}));

import TopicsPanel from "@/components/mq/TopicsPanel.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountRabbitMqPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(TopicsPanel, {
    connectionId: "rabbit-1",
    tenant: "_rabbitmq",
    namespace: "/",
    mqSystemKind: "rabbitmq",
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function mountRabbitMqAllVhostsPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(TopicsPanel, {
    connectionId: "rabbit-1",
    tenant: "_rabbitmq",
    namespace: "*",
    mqSystemKind: "rabbitmq",
    supportsExchanges: true,
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function mountKafkaPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(TopicsPanel, {
    connectionId: "kafka-1",
    tenant: "_flat_mq",
    namespace: "_flat_mq",
    mqSystemKind: "kafka",
    isFlatMqCluster: true,
  });
  app.mount(root);
  await flushUi();
  return root;
}

function rowNames(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLElement>(".topic-name-text")].map((item) => item.textContent ?? "");
}

beforeEach(() => {
  vi.useRealTimers();
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.mqListTopicsPage.mockResolvedValue({
    items: [
      {
        name: "alpha",
        shortName: "alpha",
        partitioned: false,
        persistent: true,
        messageCount: 4,
        messagesReady: 3,
        messagesUnacked: 1,
        queueType: "quorum",
        state: "running",
        autoDelete: true,
        consumerCount: 2,
        arguments: { "x-queue-type": "quorum", "x-message-ttl": 60000, "x-dead-letter-exchange": "dlx" },
        publishRate: 12.5,
        deliverRate: 11.8,
        ackRate: 11.2,
      },
      {
        name: "beta",
        shortName: "beta",
        partitioned: false,
        persistent: true,
        messageCount: 12,
        messagesReady: 12,
        messagesUnacked: 0,
        // No queue type, no arguments, and no message_stats sample:
        // type stays unknown, rates render as "-" (never fabricated zeros).
      },
    ],
    page: 1,
    pageSize: 100,
    totalCount: 2,
    hasMore: false,
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  vi.useRealTimers();
});

describe("TopicsPanel RabbitMQ queue messages", () => {
  it("shows ready message counts and toggles descending and ascending sorting", async () => {
    const panel = await mountRabbitMqPanel();

    expect([...panel.querySelectorAll<HTMLElement>('[data-testid="rabbitmq-message-count"]')].map((item) => item.textContent?.trim())).toEqual(["3", "12"]);
    expect(rowNames(panel)).toEqual(["alpha", "beta"]);

    const sortButton = panel.querySelector<HTMLButtonElement>('[data-testid="rabbitmq-message-sort"]');
    if (!sortButton) throw new Error("RabbitMQ message sort button not found");

    sortButton.click();
    await flushUi();
    expect(rowNames(panel)).toEqual(["beta", "alpha"]);
    expect(backend.mqListTopicsPage).toHaveBeenLastCalledWith("rabbit-1", { tenant: "_rabbitmq", namespace: "/" }, { includeNonPersistent: false }, expect.objectContaining({ page: 1, pageSize: 100, sort: "messagesReady", sortDescending: true }));

    sortButton.click();
    await flushUi();
    expect(rowNames(panel)).toEqual(["alpha", "beta"]);
  });

  it("shows queue type, state, features, consumers and message rates", async () => {
    const panel = await mountRabbitMqPanel();

    const rows = [...panel.querySelectorAll<HTMLElement>(".topic-name-text")].map((name) => name.closest(".topics-row"));
    const alpha = rows[0];
    if (!alpha) throw new Error("alpha row not found");

    // Queue type badge + state label.
    const typeCell = alpha.querySelector<HTMLElement>(".badge");
    expect(typeCell?.textContent?.trim()).toBe("quorum");
    expect(alpha.querySelector<HTMLElement>(".queue-state")?.textContent?.trim()).toBe("running");

    // Compact feature badges: D (durable) + AD (auto-delete) + TTL + DLX.
    const featureBadges = [...alpha.querySelectorAll<HTMLElement>('[data-testid="rabbitmq-features"] .feature-badge')].map((item) => item.textContent?.trim());
    expect(featureBadges).toEqual(["D", "AD", "TTL", "DLX"]);

    // Consumers column.
    expect(alpha.querySelector<HTMLElement>('[data-testid="rabbitmq-consumers"]')?.textContent?.trim()).toBe("2");

    // Rates: publish / deliver / ack.
    expect(alpha.querySelector<HTMLElement>('[data-testid="rabbitmq-rates"]')?.textContent?.trim()).toBe("12.50/11.80/11.20");
  });

  it("renders missing queue data as unknown type and dashed rates, never as zeros", async () => {
    const panel = await mountRabbitMqPanel();

    const rows = [...panel.querySelectorAll<HTMLElement>(".topic-name-text")].map((name) => name.closest(".topics-row"));
    const beta = rows[1];
    if (!beta) throw new Error("beta row not found");

    // No type and no x-queue-type: the label must not guess "classic".
    expect(beta.querySelector<HTMLElement>(".badge")?.textContent?.trim()).toBe("mqTopics.rabbitmqQueueTypeUnknown");

    // Durable remains visible; consumers and rates have no sample.
    expect(beta.querySelector<HTMLElement>('[data-testid="rabbitmq-features"]')?.textContent?.trim()).toBe("D");
    expect(beta.querySelector<HTMLElement>('[data-testid="rabbitmq-consumers"]')?.textContent?.trim()).toBe("-");
    expect(beta.querySelector<HTMLElement>('[data-testid="rabbitmq-rates"]')?.textContent?.trim()).toBe("-/-/-");
  });

  it("keeps per-queue vhosts separate in all-vhosts mode (#5984 regression guard)", async () => {
    backend.mqListTopicsPage.mockResolvedValue({
      items: [
        { name: "orders", shortName: "orders", partitioned: false, persistent: true, namespace: "/", messageCount: 3, messagesReady: 3 },
        { name: "orders", shortName: "orders", partitioned: false, persistent: true, namespace: "/staging", messageCount: 7, messagesReady: 7 },
      ],
      page: 1,
      pageSize: 100,
      totalCount: 2,
      hasMore: false,
    });
    const panel = await mountRabbitMqAllVhostsPanel();

    // Both rows are named "orders" but must stay distinct per virtual host;
    // the namespace column shows each queue's own vhost.
    const namespaceCells = [...panel.querySelectorAll<HTMLElement>(".topics-row .topics-col:nth-child(2)")].map((item) => item.textContent?.trim());
    expect(namespaceCells).toEqual(["/", "/staging"]);
    const counts = [...panel.querySelectorAll<HTMLElement>('[data-testid="rabbitmq-message-count"]')].map((item) => item.textContent?.trim());
    expect(counts).toEqual(["3", "7"]);
  });

  it("loads only the requested RabbitMQ page and keeps the total visible", async () => {
    backend.mqListTopicsPage
      .mockResolvedValueOnce({
        items: [{ name: "page-one", shortName: "page-one", partitioned: false, persistent: true }],
        page: 1,
        pageSize: 100,
        totalCount: 101,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ name: "page-two", shortName: "page-two", partitioned: false, persistent: true }],
        page: 2,
        pageSize: 100,
        totalCount: 101,
        hasMore: false,
      });
    const panel = await mountRabbitMqPanel();

    expect(rowNames(panel)).toEqual(["page-one"]);
    expect(panel.querySelector(".topic-count")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 / 101");
    const next = panel.querySelector<HTMLButtonElement>('[data-testid="mq-list-next"]');
    if (!next) throw new Error("next page button not found");
    next.click();
    await flushUi();

    expect(rowNames(panel)).toEqual(["page-two"]);
    expect(backend.mqListTopicsPage).toHaveBeenLastCalledWith("rabbit-1", { tenant: "_rabbitmq", namespace: "/" }, { includeNonPersistent: false }, expect.objectContaining({ page: 2, pageSize: 100 }));
  });

  it("debounces queue search into the bounded backend request", async () => {
    vi.useFakeTimers();
    const panel = await mountRabbitMqPanel();
    backend.mqListTopicsPage.mockClear();
    backend.mqListTopicsPage.mockResolvedValue({ items: [], page: 1, pageSize: 100, totalCount: 0, hasMore: false });

    const search = panel.querySelector<HTMLInputElement>(".topic-search");
    if (!search) throw new Error("topic search not found");
    search.value = "orders";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(backend.mqListTopicsPage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await flushUi();
    expect(backend.mqListTopicsPage).toHaveBeenCalledWith("rabbit-1", { tenant: "_rabbitmq", namespace: "/" }, { includeNonPersistent: false }, expect.objectContaining({ page: 1, search: "orders" }));
  });

  it("keeps non-RabbitMQ providers on the legacy unbounded contract", async () => {
    backend.mqListTopics.mockResolvedValue([{ name: "orders", shortName: "orders", partitioned: false, persistent: true }]);
    const panel = await mountKafkaPanel();

    expect(rowNames(panel)).toEqual(["orders"]);
    expect(backend.mqListTopics).toHaveBeenCalledWith("kafka-1", { tenant: "_flat_mq", namespace: "_flat_mq" }, { includeNonPersistent: false });
    expect(backend.mqListTopicsPage).not.toHaveBeenCalled();
  });
});
