// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
  mqGetTopicStats: vi.fn(),
  mqPeekMessages: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("i") });
  return { Copy: Icon, Search: Icon };
});

import KafkaMessagesPanel from "@/components/mq/KafkaMessagesPanel.vue";

const TOPIC = { name: "events", shortName: "events", persistent: true, partitioned: true, partitions: 2 };
const STATS = {
  msgRateIn: 0,
  msgRateOut: 0,
  msgThroughputIn: 0,
  msgThroughputOut: 0,
  storageSize: 0,
  backlogSize: 0,
  msgInCounter: 12,
  msgOutCounter: 0,
  subscriptionCount: 0,
  producerCount: 0,
  raw: {
    partitionStats: [
      { partition: 1, beginOffset: 4, endOffset: 10, messageCount: 6 },
      { partition: 0, beginOffset: 2, endOffset: 8, messageCount: 6 },
    ],
  },
};

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(KafkaMessagesPanel, {
    connectionId: "mq-1",
    tenant: "_flat_mq",
    namespace: "_flat_mq",
    topic: TOPIC,
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function selectTopic(panel: HTMLElement, name: string) {
  const trigger = panel.querySelector<HTMLButtonElement>(".topic-combobox-trigger");
  if (!trigger) throw new Error("Topic selector trigger not found");
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await flushUi();
  const option = [...panel.querySelectorAll<HTMLButtonElement>(".topic-combobox-option")].find((button) => button.textContent?.trim() === name);
  if (!option) throw new Error(`Topic option ${name} not found`);
  option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await flushUi();
}

beforeEach(() => {
  backend.mqListTopics.mockReset().mockResolvedValue([TOPIC, { ...TOPIC, name: "payments", shortName: "payments" }]);
  backend.mqGetTopicStats.mockReset().mockResolvedValue(STATS);
  backend.mqPeekMessages.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("KafkaMessagesPanel", () => {
  it("keeps topic selection, partition offsets, and newest-message browsing together", async () => {
    const panel = await mountPanel();
    await expect.poll(() => backend.mqListTopics.mock.calls.length).toBe(1);
    await expect.poll(() => backend.mqGetTopicStats.mock.calls.length).toBeGreaterThan(0);
    await flushUi();

    const overview = panel.querySelector('[data-testid="kafka-partition-overview"]');
    expect(overview?.textContent).toContain("mqMonitoring.tableBeginOffset");
    expect(overview?.textContent).toContain("mqMonitoring.tableLogEndOffset");
    expect(overview?.textContent).toContain("10");
    expect(panel.querySelector('[data-testid="message-browser"]')).not.toBeNull();

    const loadButton = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("mqMessages.loadMessages"));
    if (!loadButton) throw new Error("Load messages button not found");
    loadButton.click();
    await flushUi();

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 20, { startPosition: "latest" });
  });

  it("keeps message browsing available when partition stats fail", async () => {
    backend.mqGetTopicStats.mockRejectedValueOnce(new Error("stats unavailable"));
    const panel = await mountPanel();
    await expect.poll(() => panel.textContent).toContain("stats unavailable");

    expect(panel.querySelector('[data-testid="message-browser"]')).not.toBeNull();
  });

  it("keeps the user's selected topic across list refreshes and refresh failures", async () => {
    const panel = await mountPanel();
    await expect.poll(() => backend.mqListTopics.mock.calls.length).toBe(1);
    await selectTopic(panel, "payments");
    await expect.poll(() => backend.mqGetTopicStats.mock.calls.some((call) => call[1]?.topic === "payments")).toBe(true);

    const refreshButton = panel.querySelector<HTMLButtonElement>(".panel-toolbar .btn-secondary");
    if (!refreshButton) throw new Error("Topic refresh button not found");
    refreshButton.click();
    await expect.poll(() => backend.mqListTopics.mock.calls.length).toBe(2);
    expect(panel.querySelector(".committed-value")?.textContent).toBe("payments");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    backend.mqListTopics.mockRejectedValueOnce(new Error("list unavailable"));
    refreshButton.click();
    await expect.poll(() => backend.mqListTopics.mock.calls.length).toBe(3);
    expect(panel.querySelector(".committed-value")?.textContent).toBe("payments");
    expect(panel.querySelector('[data-testid="message-browser"]')).not.toBeNull();
    warning.mockRestore();
  });
});
