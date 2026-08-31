// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import type { KafkaConsumerGroupSnapshot } from "@/types/mq";

const backend = vi.hoisted(() => ({
  mqGetKafkaConsumerGroupSnapshot: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => backend);

import KafkaConsumerGroupsPanel from "@/components/mq/KafkaConsumerGroupsPanel.vue";

const SNAPSHOT: KafkaConsumerGroupSnapshot = {
  groups: [
    {
      groupId: "payments-worker",
      state: "STABLE",
      simpleGroup: false,
      memberCount: 1,
      topics: ["payments"],
      totalLag: 2,
      lagAvailable: true,
      partitions: [{ topic: "payments", partition: 0, currentOffset: 8, endOffset: 10, lag: 2 }],
    },
    {
      groupId: "orders-worker",
      state: "STABLE",
      simpleGroup: false,
      memberCount: 2,
      topics: ["orders", "orders-archive"],
      totalLag: 10,
      lagAvailable: true,
      partitions: [
        { topic: "orders", partition: 0, currentOffset: 5, endOffset: 12, lag: 7 },
        { topic: "orders", partition: 1, currentOffset: 6, endOffset: 9, lag: 3 },
        { topic: "orders-archive", partition: 0, currentOffset: 4, endOffset: 4, lag: 0 },
      ],
    },
    {
      groupId: "unknown-worker",
      state: "UNKNOWN",
      simpleGroup: false,
      topics: ["audit"],
      lagAvailable: false,
      partitions: [{ topic: "audit", partition: 0, currentOffset: 4 }],
      error: "End offsets unavailable for 1 partition(s)",
    },
  ],
};

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel(onNavigateSubscriptions?: (topic: string) => void) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(KafkaConsumerGroupsPanel, { connectionId: "kafka-1", onNavigateSubscriptions });
  app.mount(root);
  await flushUi();
  return root;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  backend.mqGetKafkaConsumerGroupSnapshot.mockReset().mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("KafkaConsumerGroupsPanel", () => {
  it("loads cluster-wide groups without a selected topic and sorts available lag descending", async () => {
    const panel = await mountPanel();
    await vi.waitFor(() => expect(backend.mqGetKafkaConsumerGroupSnapshot).toHaveBeenCalledWith("kafka-1"));

    const rows = [...panel.querySelectorAll<HTMLTableRowElement>("[data-group-id]")];
    expect(rows.map((row) => row.dataset.groupId)).toEqual(["orders-worker", "payments-worker", "unknown-worker"]);
    expect(panel.querySelector('[data-testid="kafka-consumer-group-count"]')?.textContent?.trim()).toBe("3 / 3");
    expect(panel.querySelector('[data-testid="kafka-consumer-group-detail"]')?.textContent).toContain("orders");
    expect(panel.querySelector('[data-testid="kafka-consumer-group-detail"]')?.textContent).toContain("7");
  });

  it("emits the exact topic selected from partition details using keyboard-accessible buttons", async () => {
    const navigateSubscriptions = vi.fn();
    const panel = await mountPanel(navigateSubscriptions);
    await vi.waitFor(() => expect(panel.querySelectorAll("[data-topic]")).toHaveLength(3));

    const ordersLink = panel.querySelector<HTMLButtonElement>('[data-topic="orders"]');
    const archiveLink = panel.querySelector<HTMLButtonElement>('[data-topic="orders-archive"]');
    expect(ordersLink?.tagName).toBe("BUTTON");
    expect(ordersLink?.getAttribute("aria-label")).toBe("mqKafkaConsumerGroups.openTopicSubscriptions");

    ordersLink?.click();
    archiveLink?.click();
    expect(navigateSubscriptions).toHaveBeenNthCalledWith(1, "orders");
    expect(navigateSubscriptions).toHaveBeenNthCalledWith(2, "orders-archive");
  });

  it("searches by topic and keeps unavailable lag visibly distinct from zero", async () => {
    const panel = await mountPanel();
    await vi.waitFor(() => expect(panel.querySelectorAll("[data-group-id]")).toHaveLength(3));

    const search = panel.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).toBeTruthy();
    search!.value = "audit";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const rows = [...panel.querySelectorAll<HTMLTableRowElement>("[data-group-id]")];
    expect(rows.map((row) => row.dataset.groupId)).toEqual(["unknown-worker"]);
    expect(rows[0].classList.contains("selected")).toBe(true);
    expect(rows[0].querySelector("td:last-child")?.textContent?.trim()).toBe("-");
    expect(rows[0].querySelector(".partial-warning")?.getAttribute("title")).toContain("End offsets unavailable");
    expect(panel.querySelector('[data-testid="kafka-consumer-group-detail"]')?.textContent).toContain("audit");
  });

  it("shows empty and request-error states", async () => {
    backend.mqGetKafkaConsumerGroupSnapshot.mockResolvedValueOnce({ groups: [] });
    const emptyPanel = await mountPanel();
    await vi.waitFor(() => expect(emptyPanel.textContent).toContain("mqKafkaConsumerGroups.empty"));

    app?.unmount();
    root?.remove();
    app = null;
    root = null;
    backend.mqGetKafkaConsumerGroupSnapshot.mockRejectedValueOnce(new Error("snapshot unavailable"));
    const errorPanel = await mountPanel();
    await vi.waitFor(() => expect(errorPanel.textContent).toContain("snapshot unavailable"));
  });

  it("ignores stale refresh responses", async () => {
    const first = deferred<KafkaConsumerGroupSnapshot>();
    backend.mqGetKafkaConsumerGroupSnapshot.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      groups: [{ ...SNAPSHOT.groups[0], groupId: "fresh-worker" }],
    });
    const connectionId = ref("kafka-1");
    root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp({
      setup: () => () => h(KafkaConsumerGroupsPanel, { connectionId: connectionId.value }),
    });
    app.mount(root);
    await flushUi();

    connectionId.value = "kafka-2";
    await flushUi();
    const panel = root;
    await vi.waitFor(() => expect(panel.textContent).toContain("fresh-worker"));

    first.resolve(SNAPSHOT);
    await flushUi();
    expect(panel.textContent).toContain("fresh-worker");
    expect(panel.textContent).not.toContain("orders-worker");
  });
});
