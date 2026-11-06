// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DorisLayoutPanel from "@/components/structure/DorisLayoutPanel.vue";
import type { DorisTableLayout } from "@/types/database";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const layout: DorisTableLayout = {
  kind: "olap",
  model: "aggregate",
  keyColumns: ["order_id", "dt"],
  partition: { enabled: true, mode: "range", auto: false, columns: ["dt"], expression: null, clause: "PARTITION BY RANGE(`dt`)" },
  distribution: { method: "hash", columns: ["order_id"], buckets: 10, autoBuckets: false },
  properties: { replication_num: "3", storage_medium: "SSD" },
  colocateWith: null,
  dynamicPartition: false,
  partitions: [
    { partitionId: 1, name: "p202401", range: "[types: [DATE]; keys: [2024-01-01]; ..types: [DATE]; keys: [2024-02-01]; )", buckets: 10, replicationNum: 3, state: "NORMAL", dataSize: "1.2 GB", visibleVersion: 12 },
    { partitionId: 2, name: "p202402", range: "[types: [DATE]; keys: [2024-02-01]; ..types: [DATE]; keys: [2024-03-01]; )", buckets: 10, replicationNum: 3, state: "NORMAL", dataSize: "980 MB", visibleVersion: 8 },
  ],
  warnings: [],
};

let app: App | undefined;
let root: HTMLElement | undefined;

function mountPanel(props: Record<string, unknown>) {
  root = document.createElement("div");
  app = createApp({ render: () => h(DorisLayoutPanel, props) });
  app.mount(root);
  return root;
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe("DorisLayoutPanel", () => {
  it("renders the table summary and partition rows", async () => {
    const node = mountPanel({ layout, loading: false, error: "" });
    await nextTick();
    expect(node.textContent).toContain("dorisLayout.modelAggregate");
    expect(node.textContent).toContain("dorisLayout.partitionRange");
    expect(node.textContent).toContain("dorisLayout.distributionHash");
    expect(node.textContent).toContain("10");
    expect(node.querySelectorAll("[data-doris-partition-row]")).toHaveLength(2);
    expect(node.textContent).toContain("p202401");
    expect(node.textContent).toContain("1.2 GB");
    expect(node.textContent).toContain("NORMAL");
  });

  it("filters rows by the search query", async () => {
    const props = reactive({ layout, loading: false, error: "", searchQuery: "" });
    const node = mountPanel(props);
    await nextTick();
    expect(node.querySelectorAll("[data-doris-partition-row]")).toHaveLength(2);
    props.searchQuery = "p202402";
    await nextTick();
    expect(node.querySelectorAll("[data-doris-partition-row]")).toHaveLength(1);
    expect(node.textContent).toContain("p202402");
    expect(node.textContent).not.toContain("p202401");
  });

  it("shows a specific message for an unpartitioned table", async () => {
    const node = mountPanel({ layout: { ...layout, partition: { enabled: false, mode: null, auto: false, columns: [], expression: null, clause: null }, partitions: [] }, loading: false, error: "" });
    await nextTick();
    expect(node.textContent).toContain("dorisLayout.notPartitioned");
  });

  it("keeps table info visible for a permission failure", async () => {
    const node = mountPanel({ layout: { ...layout, partitions: [], unavailableReason: "permissionDenied", warnings: ["Access denied"] }, loading: false, error: "" });
    await nextTick();
    expect(node.textContent).toContain("dorisLayout.permissionDenied");
    expect(node.textContent).toContain("Access denied");
    expect(node.textContent).toContain("dorisLayout.modelAggregate");
  });

  it("shows the fatal error instead of a stale layout", async () => {
    const node = mountPanel({ layout: null, loading: false, error: "DDL failed" });
    await nextTick();
    expect(node.textContent).toContain("DDL failed");
  });

  it("copies the visible rows as TSV", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const node = mountPanel({ layout, loading: false, error: "" });
    await nextTick();
    node.querySelector<HTMLButtonElement>("[data-doris-copy]")?.click();
    await nextTick();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("p202401");
    expect(text).toContain("p202402");
  });
});
