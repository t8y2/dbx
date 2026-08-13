// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
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

function rowNames(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLElement>(".topic-name-text")].map((item) => item.textContent ?? "");
}

beforeEach(() => {
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.mqListTopics.mockResolvedValue([
    { name: "alpha", shortName: "alpha", partitioned: false, persistent: true, messageCount: 4, messagesReady: 3, messagesUnacked: 1 },
    { name: "beta", shortName: "beta", partitioned: false, persistent: true, messageCount: 12, messagesReady: 12, messagesUnacked: 0 },
  ]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("TopicsPanel RabbitMQ queue messages", () => {
  it("shows ready message counts and toggles descending and ascending sorting", async () => {
    const panel = await mountRabbitMqPanel();

    expect([...panel.querySelectorAll<HTMLElement>('[data-testid="rabbitmq-message-count"]')].map((item) => item.textContent?.trim())).toEqual(["3", "12"]);
    expect(rowNames(panel)).toEqual(["alpha", "beta"]);

    const sortButton = panel.querySelector<HTMLButtonElement>('[data-testid="rabbitmq-message-sort"]');
    if (!sortButton) throw new Error("RabbitMQ message sort button not found");

    sortButton.click();
    await nextTick();
    expect(rowNames(panel)).toEqual(["beta", "alpha"]);

    sortButton.click();
    await nextTick();
    expect(rowNames(panel)).toEqual(["alpha", "beta"]);
  });
});
