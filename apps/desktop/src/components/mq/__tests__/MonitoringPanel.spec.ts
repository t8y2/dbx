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
  return {
    default: defineComponent({
      name: "VChart",
      props: { option: { type: Object, required: true } },
      setup: (props) => () => h("div", { "data-chart-option": JSON.stringify(props.option) }),
    }),
  };
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
    Copy: Icon,
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
const navigateTab = vi.fn();

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel(options: { mqSystemKind?: "kafka" | "rabbitmq"; tenant?: string; namespace?: string } = {}) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(MonitoringPanel, {
    connectionId: "mq-1",
    tenant: options.tenant ?? "_kafka",
    namespace: options.namespace ?? "default",
    topic: TOPIC,
    mqSystemKind: options.mqSystemKind ?? "kafka",
    onNavigateTab: navigateTab,
  });
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  backend.mqGetTopicStats.mockReset();
  backend.mqGetBacklog.mockReset();
  backend.mqPeekMessages.mockReset();
  navigateTab.mockReset();
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
    expect(browser.querySelector('[data-testid="kafka-peek-start-position"]')).toBeNull();
    expect(browser.querySelector('[data-testid="kafka-peek-partition"]')).not.toBeNull();

    const fullQueryButton = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("mqMessages.queryTitle"));
    if (!fullQueryButton) throw new Error("Full Kafka query button not found");
    fullQueryButton.click();
    expect(navigateTab).toHaveBeenCalledWith({ tab: "messages", topic: TOPIC });

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

describe("MonitoringPanel unavailable RabbitMQ rates", () => {
  it("renders no-data without plotting zeros or reporting an idle flow", async () => {
    backend.mqGetTopicStats.mockResolvedValue({
      ...KAFKA_STATS,
      ratesUnavailable: true,
      raw: {},
    });
    backend.mqGetBacklog.mockResolvedValue({ msgBacklog: 5, backlogSize: 128 });

    const panel = await mountPanel({ mqSystemKind: "rabbitmq", tenant: "_rabbitmq", namespace: "/" });

    expect(panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-in"]')?.textContent?.trim()).toBe("-");
    expect(panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-out"]')?.textContent?.trim()).toBe("-");
    const flowStatus = panel.querySelector<HTMLElement>('[data-testid="monitoring-flow-status"]');
    expect(flowStatus?.textContent?.trim()).toBe("-");
    expect(flowStatus?.classList.contains("idle")).toBe(false);
    expect(flowStatus?.classList.contains("unavailable")).toBe(true);

    const rateChart = panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-chart"]');
    const option = JSON.parse(rateChart?.dataset.chartOption ?? "{}");
    expect(option.series[0].data).toEqual([null]);
    expect(option.series[1].data).toEqual([null]);
    expect(backend.mqGetTopicStats).toHaveBeenCalledTimes(1);
    expect(backend.mqGetBacklog).toHaveBeenCalledTimes(1);
  });

  it("keeps a sampled zero as a real idle rate", async () => {
    backend.mqGetTopicStats.mockResolvedValue({
      ...KAFKA_STATS,
      ratesUnavailable: false,
      raw: {},
    });
    backend.mqGetBacklog.mockResolvedValue({ msgBacklog: 0, backlogSize: 0 });

    const panel = await mountPanel({ mqSystemKind: "rabbitmq", tenant: "_rabbitmq", namespace: "/" });

    expect(panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-in"]')?.textContent?.trim()).toBe("0.00 msg/s");
    expect(panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-out"]')?.textContent?.trim()).toBe("0.00 msg/s");
    const flowStatus = panel.querySelector<HTMLElement>('[data-testid="monitoring-flow-status"]');
    expect(flowStatus?.textContent?.trim()).toBe("mqMonitoring.flowIdle");
    expect(flowStatus?.classList.contains("idle")).toBe(true);

    const rateChart = panel.querySelector<HTMLElement>('[data-testid="monitoring-rate-chart"]');
    const option = JSON.parse(rateChart?.dataset.chartOption ?? "{}");
    expect(option.series[0].data).toEqual([0]);
    expect(option.series[1].data).toEqual([0]);
  });
});
