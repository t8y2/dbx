// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisGetStreamEntries: vi.fn(),
  redisGetStreamGroups: vi.fn(),
  redisGetStreamConsumers: vi.fn(),
  redisGetStreamPending: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetStreamEntries: mocks.redisGetStreamEntries,
  redisGetStreamGroups: mocks.redisGetStreamGroups,
  redisGetStreamConsumers: mocks.redisGetStreamConsumers,
  redisGetStreamPending: mocks.redisGetStreamPending,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
}));

vi.mock("@/composables/useEditorFontFamilyStyle", () => ({
  useEditorFontFamilyStyle: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/common/shikiJsonHighlighter", () => ({
  createShikiJsonHighlighter: vi.fn().mockResolvedValue(() => ""),
}));

vi.mock("@/lib/redis/redisCompression", () => ({
  decompressRedisValue: vi.fn().mockResolvedValue({ ok: false, reason: "corrupt" }),
  isGzipMagic: vi.fn().mockReturnValue(false),
}));

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  const DynamicScroller = defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () => h("div", [...(props.items as unknown[]).map((item, index) => slots.default?.({ item, active: true, index })), ...(slots.after?.() ?? [])]);
    },
  });
  const DynamicScrollerItem = defineComponent({
    setup(_, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const RecycleScroller = defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          (props.items as unknown[]).flatMap((item, index) => slots.default?.({ item, index }) ?? []),
        );
    },
  });

  return { DynamicScroller, DynamicScrollerItem, RecycleScroller };
});

import RedisValueViewer from "./RedisValueViewer.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function streamEntry(id: string) {
  return { id, fields: [{ field: "event", value: "login" }] };
}

function streamValue(entries = [] as ReturnType<typeof streamEntry>[], nextCursor?: string, total = entries.length) {
  return {
    key_display: "orders",
    key_raw: "b3JkZXJz",
    ttl: -1,
    redis_type: "stream",
    data: { kind: "stream" as const, entries, total, ...(nextCursor ? { next_cursor: nextCursor } : {}) },
  };
}

function blob(raw_base64: string, encoding: "utf8" | "binary" = "utf8") {
  return { raw_base64, encoding };
}

function zsetValue() {
  return {
    key_display: "scores",
    key_raw: "c2NvcmVz",
    ttl: -1,
    redis_type: "zset",
    data: {
      kind: "zset" as const,
      items: [{ score: "1", member: blob("AP8=", "binary") }],
      total: 1,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function group(pending: number | string = 1) {
  return {
    name: blob("cGF5bWVudHM="),
    consumers: 1,
    pending,
    last_delivered_id: "1714470000000-0",
    entries_read: 12,
    lag: 3,
  };
}

function mountViewer() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(RedisValueViewer, {
            connectionId: "redis-1",
            db: 2,
            keyDisplay: "orders",
            keyRaw: "b3JkZXJz",
            onDeleted: vi.fn(),
          });
      },
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          common: { loading: "Loading", retry: "Retry" },
          redis: { noConsumerGroups: "No consumer groups" },
        },
      },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  return host;
}

function openGroups(host: HTMLElement) {
  host.querySelector<HTMLButtonElement>("[data-redis-stream-groups-tab]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
}

async function refreshValue(host: HTMLElement) {
  host.querySelector<HTMLButtonElement>("[data-redis-value-refresh]")!.click();
  await settle();
}

describe("RedisValueViewer stream monitoring", () => {
  it("loads more Stream entries from the returned cursor", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue([streamEntry("1714470000000-0")], "1714470000000-0"));
    mocks.redisGetStreamEntries.mockResolvedValue({ entries: [streamEntry("1714470000001-0")] });
    const host = mountViewer();
    await settle();

    expect(host.querySelectorAll("[data-redis-stream-entry]")).toHaveLength(1);
    host.querySelector<HTMLButtonElement>("[data-redis-stream-entries-more]")!.click();
    await settle();

    expect(mocks.redisGetStreamEntries).toHaveBeenCalledWith("redis-1", 2, "b3JkZXJz", "1714470000000-0");
    expect(host.querySelectorAll("[data-redis-stream-entry]")).toHaveLength(2);
    expect(host.querySelector("[data-redis-stream-entries-more]")).toBeNull();
  });

  it("renders large counter values transported as decimal strings", async () => {
    const unsafeMetric = "9007199254740992";
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group(unsafeMetric)]);
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();

    expect(host.querySelector<HTMLElement>("[data-redis-stream-group-row]")?.textContent).toContain(BigInt(unsafeMetric).toLocaleString());
  });

  it("loads groups lazily, then loads a selected consumer's pending entries", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockResolvedValue([{ name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 }]);
    mocks.redisGetStreamPending.mockResolvedValueOnce({
      entries: [{ id: "1714470000000-0", consumer: blob("d29ya2VyLWE="), idle_ms: 2_400, deliveries: 2 }],
      next_cursor: "1714470000000-0",
    });
    mocks.redisGetStreamPending.mockResolvedValueOnce({
      entries: [{ id: "1714470000001-0", consumer: blob("d29ya2VyLWE="), idle_ms: 1_000, deliveries: 1 }],
    });
    const host = mountViewer();
    await settle();

    expect(mocks.redisGetValue).toHaveBeenCalledWith("redis-1", 2, "b3JkZXJz");
    expect(mocks.redisGetStreamGroups).not.toHaveBeenCalled();

    openGroups(host);
    await settle();

    expect(mocks.redisGetStreamGroups).toHaveBeenCalledWith("redis-1", 2, "b3JkZXJz");
    const groupRow = host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!;
    expect(groupRow.textContent).toContain("payments");

    groupRow.click();
    await settle();

    expect(mocks.redisGetStreamConsumers).toHaveBeenCalledWith("redis-1", 2, "b3JkZXJz", "cGF5bWVudHM=");
    expect(host.querySelector("[data-redis-stream-group-detail]")?.textContent).toContain("worker-a");
    expect(mocks.redisGetStreamPending).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>("[data-redis-stream-consumer-row]")!.click();
    await settle();

    expect(mocks.redisGetStreamPending).toHaveBeenNthCalledWith(1, "redis-1", 2, "b3JkZXJz", "cGF5bWVudHM=", undefined, "d29ya2VyLWE=");
    expect(host.querySelector("[data-redis-stream-consumer-crumb]")?.textContent).toContain("worker-a");

    host.querySelector<HTMLButtonElement>("[data-redis-stream-pending-more]")!.click();
    await settle();

    expect(mocks.redisGetStreamPending).toHaveBeenNthCalledWith(2, "redis-1", 2, "b3JkZXJz", "cGF5bWVudHM=", "1714470000000-0", "d29ya2VyLWE=");
    expect(host.querySelector("[data-redis-stream-group-detail]")?.textContent).toContain("1714470000001-0");
  });

  it("renders group metrics and consumer navigation without an aggregate pending list", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockResolvedValue([{ name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 }]);
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();

    const summary = host.querySelector<HTMLElement>("[data-redis-stream-group-summary]")!;
    const consumerPanel = host.querySelector<HTMLElement>("[data-redis-stream-consumers]")!;
    const consumerTable = host.querySelector<HTMLTableElement>("[data-redis-stream-consumers-table]")!;
    const groupsTab = host.querySelector<HTMLElement>("[data-redis-stream-groups-tab]")!;
    const groupCrumb = host.querySelector<HTMLElement>("[data-redis-stream-group-crumb]")!;

    expect(summary.classList.contains("rounded-lg")).toBe(true);
    expect(summary.classList.contains("border")).toBe(true);
    expect(consumerPanel.classList.contains("rounded-lg")).toBe(true);
    expect(consumerPanel.classList.contains("bg-card")).toBe(true);
    expect(consumerTable.classList.contains("table-fixed")).toBe(true);
    expect([...consumerTable.querySelectorAll("col")].map((column) => column.className)).toEqual(["w-1/4", "w-1/4", "w-1/4", "w-1/4"]);

    const consumerHeaders = consumerTable.querySelectorAll<HTMLTableCellElement>("[data-redis-stream-consumer-header] th");
    const consumerCells = consumerTable.querySelectorAll<HTMLTableCellElement>("tbody td");

    expect(host.querySelector("[data-redis-stream-pending]")).toBeNull();
    expect(groupsTab.className).toContain("group-data-[variant=line]/tabs-list:data-active:after:opacity-0");
    expect(groupCrumb.classList.contains("border-foreground")).toBe(true);
    expect(groupCrumb.classList.contains("border-transparent")).toBe(false);
    expect(consumerHeaders[1].classList.contains("text-right")).toBe(true);
    expect(consumerHeaders[2].classList.contains("text-right")).toBe(true);
    expect(consumerHeaders[3].classList.contains("text-right")).toBe(true);
    expect(consumerCells[0].classList.contains("text-left")).toBe(true);
    expect(consumerCells[1].classList.contains("text-right")).toBe(true);
    expect(consumerCells[2].classList.contains("text-right")).toBe(true);
    expect(consumerCells[3].classList.contains("text-right")).toBe(true);
    expect(consumerTable.querySelector("[data-redis-stream-consumer-row] svg")).toBeNull();
  });

  it("drills into a consumer and reloads its pending entries server-side", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockResolvedValue([
      { name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 },
      { name: blob("d29ya2VyLWI="), pending: 2, idle_ms: 900, inactive_ms: 600 },
    ]);
    mocks.redisGetStreamPending.mockResolvedValueOnce({ entries: [{ id: "1714470000001-0", consumer: blob("d29ya2VyLWI="), idle_ms: 1_000, deliveries: 1 }] });
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();

    host.querySelectorAll<HTMLButtonElement>("[data-redis-stream-consumer-row]")[1].click();
    await settle();

    expect(mocks.redisGetStreamPending).toHaveBeenNthCalledWith(1, "redis-1", 2, "b3JkZXJz", "cGF5bWVudHM=", undefined, "d29ya2VyLWI=");
    const groupCrumb = host.querySelector<HTMLElement>("[data-redis-stream-group-crumb]")!;
    const consumerCrumb = host.querySelector<HTMLElement>("[data-redis-stream-consumer-crumb]")!;
    expect(consumerCrumb.textContent).toContain("worker-b");
    expect(groupCrumb.classList.contains("border-transparent")).toBe(true);
    expect(consumerCrumb.classList.contains("border-foreground")).toBe(true);
    expect(host.querySelector("[data-redis-stream-consumers]")).toBeNull();
    expect(host.querySelectorAll("[data-redis-stream-pending-header] th")).toHaveLength(3);
    expect([...host.querySelectorAll("[data-redis-stream-pending-table] col")].map((column) => column.className)).toEqual(["w-[44%]", "w-[36%]", "w-[20%]"]);
    expect(host.querySelector("[data-redis-stream-pending]")?.textContent).toContain("1714470000001-0");
    expect(host.querySelector<HTMLTableCellElement>("[data-redis-stream-pending-table] tbody td")?.textContent?.trim()).toBe("1714470000001-0");

    host.querySelector<HTMLButtonElement>("[data-redis-stream-group-crumb]")!.click();
    await settle();

    expect(mocks.redisGetStreamPending).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-redis-stream-consumers]")).not.toBeNull();
    expect(host.querySelector("[data-redis-stream-consumer-crumb]")).toBeNull();
  });

  it("shows an empty state and lets a failed group query be retried", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockRejectedValueOnce(new Error("NOPERM XINFO is not allowed")).mockResolvedValueOnce([]);
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();

    expect(host.querySelector("[data-redis-stream-groups-retry]")).not.toBeNull();
    expect(host.textContent).toContain("NOPERM XINFO is not allowed");

    host.querySelector<HTMLButtonElement>("[data-redis-stream-groups-retry]")!.click();
    await settle();

    expect(mocks.redisGetStreamGroups).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("No consumer groups");
  });

  it("manually refreshes the active group and its dependent views", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockResolvedValue([{ name: blob("d29ya2VyLWE="), pending: 0, idle_ms: 0 }]);
    mocks.redisGetStreamPending.mockResolvedValue({ entries: [] });
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();
    host.querySelector<HTMLButtonElement>("[data-redis-stream-consumer-row]")!.click();
    await settle();

    await refreshValue(host);

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(mocks.redisGetStreamGroups).toHaveBeenCalledTimes(2);
    expect(mocks.redisGetStreamConsumers).toHaveBeenCalledTimes(2);
    expect(mocks.redisGetStreamPending).toHaveBeenCalledTimes(2);
  });

  it("returns to the consumer list when refresh removes the selected consumer", async () => {
    const refreshedPending = deferred<{ entries: Array<{ id: string; consumer: ReturnType<typeof blob>; idle_ms: number; deliveries: number }> }>();
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockResolvedValueOnce([{ name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 }]).mockResolvedValueOnce([]);
    mocks.redisGetStreamPending.mockResolvedValueOnce({ entries: [{ id: "1714470000000-0", consumer: blob("d29ya2VyLWE="), idle_ms: 2_400, deliveries: 2 }] }).mockReturnValueOnce(refreshedPending.promise);
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();
    host.querySelector<HTMLButtonElement>("[data-redis-stream-consumer-row]")!.click();
    await settle();

    await refreshValue(host);

    expect(mocks.redisGetStreamConsumers).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-redis-stream-consumer-crumb]")).toBeNull();
    expect(host.querySelector("[data-redis-stream-consumers]")).not.toBeNull();
    expect(host.querySelector("[data-redis-stream-pending]")).toBeNull();

    refreshedPending.resolve({ entries: [{ id: "1714470000001-0", consumer: blob("d29ya2VyLWE="), idle_ms: 1_000, deliveries: 1 }] });
    await settle();

    expect(host.querySelector("[data-redis-stream-consumer-crumb]")).toBeNull();
    expect(host.querySelector("[data-redis-stream-pending]")).toBeNull();
  });

  it("returns to the group list when refresh removes the selected group", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValueOnce([group()]).mockResolvedValueOnce([]);
    mocks.redisGetStreamConsumers.mockResolvedValue([{ name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 }]);
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();

    await refreshValue(host);

    expect(mocks.redisGetStreamGroups).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-redis-stream-group-detail]")).toBeNull();
    expect(host.querySelector("[data-redis-stream-groups]")).toBeNull();
    expect(host.textContent).toContain("No consumer groups");
  });

  it("retries failed consumer and pending reads without retaining stale data", async () => {
    mocks.redisGetValue.mockResolvedValue(streamValue());
    mocks.redisGetStreamGroups.mockResolvedValue([group()]);
    mocks.redisGetStreamConsumers.mockRejectedValueOnce(new Error("NOPERM XINFO is not allowed")).mockResolvedValueOnce([{ name: blob("d29ya2VyLWE="), pending: 1, idle_ms: 1_200, inactive_ms: 800 }]);
    mocks.redisGetStreamPending.mockRejectedValueOnce(new Error("NOPERM XPENDING is not allowed")).mockResolvedValueOnce({
      entries: [{ id: "1714470000000-0", consumer: blob("d29ya2VyLWE="), idle_ms: 2_400, deliveries: 2 }],
    });
    const host = mountViewer();
    await settle();

    openGroups(host);
    await settle();
    host.querySelector<HTMLElement>("[data-redis-stream-group-row]")!.click();
    await settle();

    expect(host.querySelector("[data-redis-stream-consumers-retry]")).not.toBeNull();
    expect(host.textContent).toContain("NOPERM XINFO is not allowed");
    host.querySelector<HTMLButtonElement>("[data-redis-stream-consumers-retry]")!.click();
    await settle();

    expect(mocks.redisGetStreamConsumers).toHaveBeenCalledTimes(2);
    host.querySelector<HTMLButtonElement>("[data-redis-stream-consumer-row]")!.click();
    await settle();

    expect(host.querySelector("[data-redis-stream-pending-retry]")).not.toBeNull();
    expect(host.textContent).toContain("NOPERM XPENDING is not allowed");
    host.querySelector<HTMLButtonElement>("[data-redis-stream-pending-retry]")!.click();
    await settle();

    expect(mocks.redisGetStreamPending).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-redis-stream-pending]")?.textContent).toContain("1714470000000-0");
  });
});

describe("RedisValueViewer ZSet member details", () => {
  it("opens the full detail dialog for a binary ZSet member", async () => {
    mocks.redisGetValue.mockResolvedValue(zsetValue());
    const host = mountViewer();
    await settle();

    const viewMember = host.querySelector<HTMLButtonElement>("[data-redis-zset-view-member]");
    expect(viewMember).not.toBeNull();

    viewMember!.click();
    await settle();

    const detail = document.querySelector<HTMLElement>("[data-redis-member-detail]");
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain("Base64");
  });
});
