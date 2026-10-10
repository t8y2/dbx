// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TaskRunDetail, TaskRunItem, TaskRunItemsPage } from "@/lib/backend/tauri";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean, variant: String, size: String },
      emits: ["click"],
      setup(props, { slots, emit, attrs }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: (event: MouseEvent) => emit("click", event) }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...original, loadTaskRun: vi.fn(), loadTaskRunItems: vi.fn() };
});

vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import TaskRunDetailDialog from "@/components/export/TaskRunDetailDialog.vue";
import * as api from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";

const loadTaskRun = vi.mocked(api.loadTaskRun);
const loadTaskRunItems = vi.mocked(api.loadTaskRunItems);
const clipboard = vi.mocked(copyToClipboard);
const mountedApps: App[] = [];

function detail(overrides: Partial<TaskRunDetail> = {}): TaskRunDetail {
  return {
    run: {
      runId: "run-1",
      taskType: "transfer",
      lifecycleOwner: "tauri",
      status: "partial_failed",
      createdAt: "2025-03-05T10:00:00.000Z",
      startedAt: "2025-03-05T10:00:00.000Z",
      finishedAt: "2025-03-05T10:00:04.000Z",
      ownerInstanceId: "instance-1",
      errorCode: "TRANSFER_ITEM_FAILED",
      safeErrorSummary: "Transfer completed with failed items.",
      historyComplete: false,
      source: { connectionId: "src", databaseType: "mysql", database: "shop", schema: "" },
      target: { connectionId: "dst", databaseType: "postgres", database: "warehouse", schema: "public" },
    },
    transfer: {
      runId: "run-1",
      content: "structure_and_data",
      mode: "append",
      batchSize: 500,
      createTable: true,
      dropTargetBeforeCreate: false,
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: false,
      ownershipPolicy: "preserve",
      filteredTableCount: 1,
      tableTotal: 2,
      objectSelectionMode: "explicit",
      selectedObjectCount: 2,
    },
    ...overrides,
  };
}

function item(index: number, overrides: Partial<TaskRunItem> = {}): TaskRunItem {
  return {
    runId: "run-1",
    itemIndex: index,
    itemKind: "table",
    sourceObject: `users_${index}`,
    targetObject: `public.users_${index}`,
    status: "succeeded",
    sourceRowCount: 100,
    movedRowCount: 42,
    targetRowCount: 42,
    rowCountState: "known",
    hasTableFilter: true,
    safeErrorSummary: null,
    ...overrides,
  };
}

function itemsPage(items: TaskRunItem[], nextAfterItemIndex: number | null = null): TaskRunItemsPage {
  return { items, nextAfterItemIndex };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountDialog(runId: string | null = "run-1", open = true): Promise<void> {
  i18n.global.locale.value = "en";
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(TaskRunDetailDialog, { open, runId });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

async function click(text: string): Promise<void> {
  buttonByText(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
}

beforeEach(() => {
  loadTaskRun.mockReset();
  loadTaskRunItems.mockReset();
  clipboard.mockReset();
  clipboard.mockResolvedValue(undefined);
  loadTaskRun.mockResolvedValue(detail());
  loadTaskRunItems.mockResolvedValue(itemsPage([item(0)]));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TaskRunDetailDialog", () => {
  it("loads the saved run snapshot and its object page", async () => {
    await mountDialog();

    expect(loadTaskRun).toHaveBeenCalledWith("run-1");
    expect(loadTaskRunItems).toHaveBeenCalledWith("run-1", { limit: 100 });
    expect(document.body.textContent).toContain("run-1");
    expect(document.body.textContent).toContain("mysql · shop");
    expect(document.body.textContent).toContain("postgres · warehouse · public");
    expect(document.body.textContent).toContain("Structure and data");
    expect(document.body.textContent).toContain("Transfer completed with failed items.");
  });

  it("flags a stored run whose history write did not complete", async () => {
    await mountDialog();

    expect(document.body.textContent).toContain("History may be incomplete");
    expect(document.body.textContent).toContain("The record may be incomplete due to an interrupted process or a failed history write.");
  });

  it("keeps the snapshot visible when a run has no transfer details", async () => {
    loadTaskRun.mockResolvedValue(detail({ transfer: null }));
    await mountDialog();

    expect(document.body.textContent).toContain("run-1");
    expect(document.body.textContent).not.toContain("Batch size");
  });

  it("explains a run that no longer exists and retries the same identifier", async () => {
    loadTaskRun.mockResolvedValueOnce(null).mockResolvedValueOnce(detail());
    await mountDialog();

    expect(loadTaskRun).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Could not load this task run.");

    await click("Retry");

    expect(loadTaskRun).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Structure and data");
  });

  it("scans every object page for failed objects and restores the full list afterwards", async () => {
    loadTaskRunItems.mockImplementation(async (_runId, query) => {
      if (query.limit === 100) return itemsPage([item(0), item(1)], 2);
      if (query.afterItemIndex === undefined) return itemsPage([item(0), item(1, { status: "failed", safeErrorSummary: "Transfer item failed." })], 2);
      if (query.afterItemIndex === 2) return itemsPage([item(2)], null);
      return itemsPage([], null);
    });
    await mountDialog();

    await click("Failed");

    expect(loadTaskRunItems).toHaveBeenLastCalledWith("run-1", { limit: 200, afterItemIndex: 2 });
    expect(document.body.textContent).toContain("users_1");
    expect(document.body.textContent).not.toContain("users_0");
    expect(document.body.textContent).toContain("Matched 1 object(s)");

    await click("All objects");

    expect(document.body.textContent).toContain("users_0");
  });

  it("treats skipped and cancelled objects as not succeeded", async () => {
    loadTaskRunItems.mockImplementation(async (_runId, query) => {
      if (query.limit === 100) return itemsPage([item(0)]);
      if (query.afterItemIndex === undefined) return itemsPage([item(0), item(1, { status: "skipped" }), item(2, { status: "cancelled" })], null);
      return itemsPage([], null);
    });
    await mountDialog();

    await click("Not succeeded");

    expect(document.body.textContent).toContain("Matched 2 object(s)");
    expect(document.body.textContent).toContain("users_1");
    expect(document.body.textContent).toContain("users_2");
  });

  it("copies only the safe summary, paging through every object page", async () => {
    loadTaskRunItems.mockImplementation(async (_runId, query) => {
      if (query.limit === 100) return itemsPage([item(0, { status: "failed", safeErrorSummary: "Transfer item failed." })], 1);
      if (query.afterItemIndex === undefined) return itemsPage([item(0, { status: "failed", safeErrorSummary: "Transfer item failed." })], 1);
      if (query.afterItemIndex === 1) return itemsPage([item(1, { itemKind: "view", sourceRowCount: null, rowCountState: "unknown" })], null);
      return itemsPage([], null);
    });
    await mountDialog();

    await click("Copy safe summary");

    expect(clipboard).toHaveBeenCalledTimes(1);
    const text = clipboard.mock.calls[0]![0];
    const lines = text.split("\n").filter((line) => line.trim() !== "");

    expect(lines).toContain("Run ID: run-1");
    expect(lines).toContain("Task type: Data transfer");
    expect(lines).toContain("Status: Partially failed");
    expect(lines).toContain("Source: mysql · shop");
    expect(lines).toContain("Target: postgres · warehouse · public");
    expect(lines).toContain("History complete: No");
    expect(lines).toContain("Content: Structure and data");
    expect(lines).toContain("Transfer mode: Append");
    expect(lines).toContain("Batch size: 500");
    expect(lines).toContain("Object count: 2");
    expect(lines).toContain("Safe error summary: Transfer completed with failed items.");
    expect(lines).toContain("Object results");
    expect(lines).toContain("- users_0 → public.users_0 (Table)");
    expect(lines).toContain("  Status: Failed; Source rows: 100; Moved rows: 42; Target rows: 42; Filter applied: Yes");
    expect(lines).toContain("  Safe error summary: Transfer item failed.");
    expect(lines).toContain("- users_1 → public.users_1 (View)");
    expect(lines).toContain("  Status: Succeeded; Source rows: Unknown; Moved rows: 42; Target rows: 42; Filter applied: Yes");

    // Nothing outside the reviewed safe field list may ever leave the app.
    const allowedPrefixes = ["Run ID:", "Task type:", "Status:", "Started:", "Finished:", "Duration:", "Source:", "Target:", "History complete:", "Content:", "Transfer mode:", "Batch size:", "Object count:", "Safe error summary:", "Object results", "- ", "  Status:", "  Safe error summary:"];
    for (const line of lines) {
      expect(allowedPrefixes.some((prefix) => line.startsWith(prefix))).toBe(true);
    }
  });

  it("bounds a copied summary so one oversized run cannot build an unbounded payload", async () => {
    loadTaskRunItems.mockImplementation(async (_runId, query) => {
      if (query.limit === 100) return itemsPage([item(0)], null);
      const after = query.afterItemIndex ?? 0;
      const pageItems = Array.from({ length: 200 }, (_value, offset) => item(after + offset));
      return itemsPage(pageItems, after + 200);
    });
    await mountDialog();

    await click("Copy safe summary");

    const text = clipboard.mock.calls[0]![0];
    expect(text).toContain("Only the first 20,000 object results are included; further objects were not copied.");
    expect(loadTaskRunItems.mock.calls.length).toBeLessThanOrEqual(102);
  });

  it("keeps a loaded object page when a later page fails and retries the reload", async () => {
    loadTaskRunItems
      .mockResolvedValueOnce(itemsPage([item(0)], 1))
      .mockRejectedValueOnce(new Error("storage offline"))
      .mockResolvedValueOnce(itemsPage([item(1)], null));
    await mountDialog();

    await click("Load more");

    expect(document.body.textContent).toContain("users_0");
    expect(document.body.textContent).toContain("Could not load object results.");

    await click("Retry");

    expect(document.body.textContent).toContain("users_1");
  });

  it("never requests a run while closed", async () => {
    await mountDialog("run-1", false);

    expect(loadTaskRun).not.toHaveBeenCalled();
    expect(loadTaskRunItems).not.toHaveBeenCalled();
  });
});
