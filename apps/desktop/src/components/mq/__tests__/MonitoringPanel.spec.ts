// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  mqGetTopicStats: vi.fn(),
  mqGetBacklog: vi.fn(),
  mqPeekMessages: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => backend);
vi.mock("@/components/ui/select", async () => (await import("./selectStub")).createSelectStub());
vi.mock("echarts/core", () => ({ use: vi.fn() }));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock("vue-echarts", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "VChart", setup: () => () => h("div") }) };
});
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("i") });
  return {
    Activity: Icon,
    AlertTriangle: Icon,
    BarChart3: Icon,
    Boxes: Icon,
    CheckCircle2: Icon,
    Database: Icon,
    Download: Icon,
    Gauge: Icon,
    Hash: Icon,
    HardDrive: Icon,
    Layers3: Icon,
    Loader2: Icon,
    Package: Icon,
    RadioTower: Icon,
    RefreshCw: Icon,
    Send: Icon,
    ShieldCheck: Icon,
    Table2: Icon,
    Upload: Icon,
    Users: Icon,
  };
});

import MonitoringPanel from "@/components/mq/MonitoringPanel.vue";

const TOPIC = {
  name: "persistent://public/default/test",
  shortName: "test",
  persistent: true,
  partitioned: false,
};

const KAFKA_STATS = {
  msgRateIn: 0,
  msgRateOut: 0,
  msgThroughputIn: 0,
  msgThroughputOut: 0,
  storageSize: 0,
  backlogSize: 0,
  msgInCounter: 19,
  msgOutCounter: 0,
  subscriptionCount: 0,
  producerCount: 0,
  raw: {
    partitions: 1,
    replicationFactor: 1,
    totalMessages: 19,
    partitionStats: [{ partition: 0, beginOffset: 0, endOffset: 19, messageCount: 19, leader: 1, replicas: [1], isr: [1] }],
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
  app = createApp(MonitoringPanel, {
    connectionId: "mq-1",
    tenant: "_kafka",
    namespace: "default",
    topic: TOPIC,
    mqSystemKind: "kafka",
  });
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  backend.mqGetTopicStats.mockReset();
  backend.mqGetBacklog.mockReset();
  backend.mqPeekMessages.mockReset();
  backend.mqGetTopicStats.mockResolvedValue(KAFKA_STATS);
  backend.mqPeekMessages.mockResolvedValue([]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("MonitoringPanel Kafka message browser", () => {
  it("reuses the explicit Kafka browser instead of rendering a SQL query field", async () => {
    const panel = await mountPanel();
    const browser = panel.querySelector<HTMLElement>('[data-testid="message-browser"]');
    const loadButton = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("mqMessages.loadMessages"));
    if (!browser || !loadButton) throw new Error("Kafka message browser not found");

    expect(panel.querySelector("textarea")).toBeNull();
    expect(browser.classList.contains("message-browser")).toBe(true);
    expect(browser.classList.contains("is-monitoring")).toBe(true);
    expect(browser.querySelector('[data-testid="kafka-peek-start-position"]')).not.toBeNull();

    loadButton.click();
    await flushUi();

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "test" }), "__dbx_kafka_viewer__", 20, { startPosition: "latest" });
  });

  it("keeps automatic monitoring refresh separate from message browsing", async () => {
    vi.useFakeTimers();
    try {
      const panel = await mountPanel();
      const browser = panel.querySelector<HTMLElement>('[data-testid="message-browser"]');
      const loadButton = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("mqMessages.loadMessages"));
      if (!browser || !loadButton) throw new Error("Kafka message browser not found");

      backend.mqPeekMessages.mockResolvedValueOnce([
        {
          position: 1,
          messageId: "18",
          payloadBase64: "",
          payloadText: "loaded message",
          properties: { partition: "0" },
          headers: {},
        },
      ]);
      loadButton.click();
      await flushUi();

      expect(browser.textContent).toContain("loaded message");
      expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await flushUi();

      expect(backend.mqGetTopicStats).toHaveBeenCalledTimes(2);
      expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);
      expect(browser.textContent).toContain("loaded message");

      backend.mqGetTopicStats.mockRejectedValueOnce(new Error("monitoring refresh failed"));
      await vi.advanceTimersByTimeAsync(5_000);
      await flushUi();

      expect(backend.mqGetTopicStats).toHaveBeenCalledTimes(3);
      expect(backend.mqPeekMessages).toHaveBeenCalledTimes(1);
      expect(browser.isConnected).toBe(true);
      expect(browser.textContent).toContain("loaded message");
    } finally {
      vi.useRealTimers();
    }
  });
});
