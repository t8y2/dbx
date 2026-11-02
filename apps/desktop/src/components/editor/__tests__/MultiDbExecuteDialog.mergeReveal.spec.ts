// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, h, nextTick, ref, type App, type Ref } from "vue";
import { createPinia } from "pinia";
import MultiDbExecuteDialog from "../MultiDbExecuteDialog.vue";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import type { MultiDbExecutionAdapter } from "@/composables/useMultiDbExecution";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  exportQueryResultsXlsx: vi.fn().mockResolvedValue(undefined),
  exportQueryResultXlsx: vi.fn().mockResolvedValue(undefined),
  registerTaskCancelHandler: vi.fn(),
  unregisterTaskCancelHandler: vi.fn(),
}));

// Parameters are rendered so a call that forgot them is visible in the DOM.
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join("/")})` : key) }),
}));
// Web runtime: exports skip the save dialog and manual transactions are unavailable.
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", () => ({
  exportQueryResultsXlsx: mocks.exportQueryResultsXlsx,
  exportQueryResultXlsx: mocks.exportQueryResultXlsx,
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/sqlExecutionTargetGroupStore", () => ({ useSqlExecutionTargetGroupStore: () => ({ getGroupsByDatabaseType: () => [], getGroup: () => undefined }) }));
vi.mock("@/composables/useExportTracker", () => ({
  formatDataTransferDuration: String,
  useExportTracker: () => ({ addMultiDbExecutionTask: vi.fn(), updateMultiDbExecutionTask: vi.fn(), registerTaskCancelHandler: mocks.registerTaskCancelHandler, unregisterTaskCancelHandler: mocks.unregisterTaskCancelHandler }),
}));
vi.mock("@/composables/useMultiDbTargetSelection", () => ({
  useMultiDbTargetSelection: () => ({
    compatibleConnections: computed(() => []),
    connection: () => ({ id: "test", name: "Test", db_type: "oceanbase-oracle" }),
    loadConnection: vi.fn().mockResolvedValue(undefined),
    validateTarget: async () => ({ state: "valid" }),
    validateTargets: async (targets: unknown[]) => targets.map((target) => ({ target, state: "valid" })),
  }),
}));

const SQL = "SELECT id, amount FROM t";
const TWO_TARGETS = [
  { connectionId: "test", database: "db-a" },
  { connectionId: "test", database: "db-b" },
];

function table(rows: (string | number)[][]): QueryResult {
  return { columns: ["id", "amount"], rows, affected_rows: rows.length, execution_time_ms: 1 };
}

function write(affectedRows: number): QueryResult {
  return { columns: [], rows: [], affected_rows: affectedRows, execution_time_ms: 1 };
}

function resultFor(database: string): QueryResult {
  return database === "db-a" ? table([[1, 10]]) : table([[2, 20]]);
}

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  mocks.toast.mockClear();
  mocks.exportQueryResultsXlsx.mockClear();
  mocks.registerTaskCancelHandler.mockClear();
  mocks.unregisterTaskCancelHandler.mockClear();
  vi.restoreAllMocks();
});

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

/** Mounts with a reactive `open` so minimizing and reopening can be observed. */
interface DialogOptions {
  open: Ref<boolean>;
  targets?: Array<{ connectionId: string; database: string }>;
  launchId?: Ref<number>;
  cancelTarget?: MultiDbExecutionAdapter["cancelTarget"];
  cancelPending?: MultiDbExecutionAdapter["cancelPending"];
}

function mountDialog(executeTarget: MultiDbExecutionAdapter["executeTarget"], options: DialogOptions) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(MultiDbExecuteDialog, {
        open: options.open.value,
        "onUpdate:open": (value: boolean) => (options.open.value = value),
        sql: SQL,
        sourceTabId: "source",
        databaseType: "oceanbase-oracle",
        initialTargets: options.targets ?? TWO_TARGETS,
        launchId: options.launchId?.value ?? 1,
        executeTarget,
        cancelTarget: options.cancelTarget,
        cancelPending: options.cancelPending,
      }),
  });
  app.use(createPinia());
  app.mount(root);
}

async function executeBatch(executeTarget: MultiDbExecutionAdapter["executeTarget"], options: DialogOptions) {
  mountDialog(executeTarget, options);
  await flushPromises();
  button("multiDbExecute.execute").click();
  await flushPromises();
}

describe("multi-database merged view reveal paths", () => {
  it("unions every source and labels the rows, the statement and the batch timings", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => ({ status: "success" as const, durationMs: 3, result: resultFor(input.target.database) }));
    await executeBatch(executeTarget, { open });

    button("multiDbExecute.mergeResults").click();
    await nextTick();

    const view = document.querySelector("[data-multi-source-merge-view]");
    expect(view).not.toBeNull();
    const rows = [...(view?.querySelectorAll("tbody tr") ?? [])].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()));
    expect(rows).toEqual([
      ["Test / db-a", "1", "10"],
      ["Test / db-b", "2", "20"],
    ]);

    // The statement, the elapsed time and the start time come from the batch.
    expect(document.querySelector("[data-merge-sql]")?.textContent?.trim()).toBe(SQL);
    expect(document.querySelector("[data-merge-duration]")?.textContent?.trim()).not.toBe("");
    expect(document.querySelector("[data-merge-executed-at]")?.textContent?.trim()).not.toBe("");
  });

  it("names the merged view in the title instead of the bar's parametrized progress", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => ({ status: "success" as const, durationMs: 3, result: resultFor(input.target.database) }));
    await executeBatch(executeTarget, { open });

    const title = () => document.querySelector('[data-slot="dialog-title"]')?.textContent?.trim() ?? "";
    expect(title()).toContain("multiDbExecute.progress(");

    button("multiDbExecute.mergeResults").click();
    await nextTick();

    expect(title()).toBe("multiDbExecute.mergeResults");
    expect(document.body.textContent).toContain("multiDbExecute.progress(2/2)");
  });

  it("exports the merged rows and the statement through the dialog footer", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => ({ status: "success" as const, durationMs: 3, result: resultFor(input.target.database) }));
    await executeBatch(executeTarget, { open });

    button("multiDbExecute.mergeResults").click();
    await nextTick();
    (document.querySelector("[data-multi-db-merge-export-all]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledTimes(1));

    const sheets = (mocks.exportQueryResultsXlsx.mock.calls[0] as [string, Array<{ sheetName: string; rows: unknown[][] }>])[1];
    expect(sheets[0]?.rows).toHaveLength(2);
    expect(sheets[1]?.rows.flat().join("\n")).toContain(SQL);
  });

  it("re-runs only the failed target from the per-target list", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => (input.target.database === "db-a" ? { status: "success" as const, durationMs: 4, result: write(3) } : { status: "failed" as const, durationMs: 2, errorMessage: "boom" }));
    await executeBatch(executeTarget, { open });

    button("multiDbExecute.mergeResults").click();
    await nextTick();
    expect(document.body.textContent).toContain("boom");

    executeTarget.mockImplementation(async (input) => (input.target.database === "db-a" ? { status: "success" as const, durationMs: 4, result: write(3) } : { status: "success" as const, durationMs: 6, result: write(1) }));
    (document.querySelector("[data-merge-rerun]") as HTMLButtonElement).click();
    await flushPromises();

    // The adapter ran for the retried target only, and the row shows the retry's own outcome.
    expect(executeTarget).toHaveBeenCalledTimes(3);
    expect(executeTarget.mock.calls[2]?.[0].target.database).toBe("db-b");
    expect(document.querySelector("[data-merge-rerun]")).toBeNull();
    expect(document.body.textContent).not.toContain("boom");
  });

  it("keeps deferred retries cancellable across reopen and rolls back their late transactions on unmount", async () => {
    const open = ref(true);
    const launchId = ref(1);
    const cancelTarget = vi.fn().mockResolvedValue(undefined);
    const cancelPending = vi.fn();
    const finish = vi.fn().mockResolvedValue(undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>().mockResolvedValue({ status: "failed", errorMessage: "boom" });
    await executeBatch(executeTarget, { open, launchId, cancelTarget, cancelPending });
    const batchId = document.querySelector("[data-multi-db-batch-id]")?.getAttribute("data-multi-db-batch-id");
    button("multiDbExecute.mergeResults").click();
    await nextTick();
    mocks.registerTaskCancelHandler.mockClear();
    executeTarget.mockImplementationOnce(async () => {
      await gate;
      return { status: "pending_commit", transaction: { canCommit: true, finish } };
    });
    (document.querySelector("[data-merge-rerun]") as HTMLButtonElement).click();
    await flushPromises();

    expect(document.querySelector<HTMLButtonElement>("[data-merge-rerun]")?.disabled).toBe(true);
    expect(mocks.registerTaskCancelHandler).toHaveBeenLastCalledWith(batchId, expect.any(Function));
    const cancel = mocks.registerTaskCancelHandler.mock.calls.at(-1)![1] as () => Promise<void>;
    open.value = false;
    await flushPromises();
    launchId.value += 1;
    open.value = true;
    await flushPromises();
    expect(document.querySelector("[data-multi-db-batch-id]")?.getAttribute("data-multi-db-batch-id")).toBe(batchId);
    expect(executeTarget).toHaveBeenCalledTimes(3);
    await cancel();
    expect(cancelTarget).toHaveBeenCalledExactlyOnceWith("source", batchId);
    expect(cancelPending).toHaveBeenCalledExactlyOnceWith(batchId);
    expect(executeTarget.mock.calls[2]![0].isCancellationRequested()).toBe(true);

    app?.unmount();
    app = undefined;
    expect(finish).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledExactlyOnceWith("rollback"));
  });

  it.each([0, 5000])("resets confirmation timing for a new batch with %i ms wait but preserves same-batch reopen", async (secondWaitMs) => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const open = ref(true);
    const launchId = ref(1);
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => {
      if (input.target.database === "db-a") await gate;
      return { status: "success", result: resultFor(input.target.database) };
    });
    await executeBatch(executeTarget, { open, launchId });
    const firstBatchId = document.querySelector("[data-multi-db-batch-id]")?.getAttribute("data-multi-db-batch-id");
    const dangerStore = useSqlExecutionDangerStore();
    dangerStore.pending = { sql: SQL, kind: "sql", scopeId: firstBatchId ?? undefined, targetLabel: "Test / db-a" };
    await nextTick();
    now = 11_000;
    dangerStore.pending = undefined;
    await nextTick();
    now = 11_100;
    release();
    await flushPromises();
    expect(document.querySelector("[data-multi-db-elapsed]")?.textContent).toBe("multiDbExecute.elapsed(100)");

    open.value = false;
    await flushPromises();
    open.value = true;
    await flushPromises();
    expect(document.querySelector("[data-multi-db-elapsed]")?.textContent).toBe("multiDbExecute.elapsed(100)");
    expect(executeTarget).toHaveBeenCalledTimes(2);

    now = 20_000;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    launchId.value += 1;
    await flushPromises();
    button("multiDbExecute.execute").click();
    await flushPromises();
    const secondBatchId = document.querySelector("[data-multi-db-batch-id]")?.getAttribute("data-multi-db-batch-id");
    expect(secondBatchId).not.toBe(firstBatchId);
    if (secondWaitMs > 0) {
      dangerStore.pending = { sql: SQL, kind: "sql", scopeId: secondBatchId ?? undefined, targetLabel: "Test / db-a" };
      await nextTick();
      now += secondWaitMs;
      dangerStore.pending = undefined;
      await nextTick();
    }
    now += 250;
    release();
    await flushPromises();
    expect(document.querySelector("[data-multi-db-elapsed]")?.textContent).toBe("multiDbExecute.elapsed(250)");
    button("multiDbExecute.mergeResults").click();
    await nextTick();
    button("multiDbExecute.exportAllRows").click();
    await flushPromises();
    const sheets = mocks.exportQueryResultsXlsx.mock.calls[0]?.[1] as Array<{ sheetName: string; rows: string[][] }>;
    expect(
      sheets
        .find((sheet) => sheet.sheetName === "SQL")
        ?.rows.flat()
        .join("\n"),
    ).toContain("250 ms");
  });

  it("keeps merging out of a single-target batch", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => ({ status: "success" as const, durationMs: 3, result: resultFor(input.target.database) }));
    await executeBatch(executeTarget, { open, targets: [{ connectionId: "test", database: "db-a" }] });

    expect(document.querySelector("[data-multi-db-merge]")).toBeNull();
  });

  it("parks the clock and labels the target while its confirmation is on screen", async () => {
    const open = ref(true);
    const releases: Array<() => void> = [];
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: "success" as const, durationMs: 3, result: resultFor(input.target.database) };
    });
    await executeBatch(executeTarget, { open });

    const batchId = document.querySelector("[data-multi-db-batch-id]")?.getAttribute("data-multi-db-batch-id");
    expect(batchId).toBeTruthy();
    // The prompt the batch is waiting for, as the danger store publishes it.
    useSqlExecutionDangerStore().pending = { sql: SQL, kind: "sql", scopeId: batchId ?? undefined, targetLabel: "Test / db-a" };
    await nextTick();

    // The parked target is waiting for the operator, not running.
    expect(document.body.textContent).toContain("multiDbExecute.awaitingConfirmation");
    const elapsedBefore = document.querySelector("[data-multi-db-elapsed]")?.textContent;
    expect(elapsedBefore).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await nextTick();
    expect(document.querySelector("[data-multi-db-elapsed]")?.textContent).toBe(elapsedBefore);

    releases.splice(0).forEach((release) => release());
  });

  it("announces a batch that finished while minimized with an action into the merged view", async () => {
    const open = ref(true);
    const releases: Array<() => void> = [];
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: "success" as const, durationMs: 3, result: resultFor(input.target.database) };
    });
    await executeBatch(executeTarget, { open });

    // Minimize while the targets are still running, then let them finish.
    open.value = false;
    await nextTick();
    for (let round = 0; round < 4; round += 1) {
      releases.splice(0).forEach((release) => release());
      await flushPromises();
    }

    const announcement = mocks.toast.mock.calls.at(-1) as [string, number, { label: string; onClick: () => void }];
    expect(announcement[0]).toBe("multiDbExecute.backgroundBatchDone(2)");
    expect(announcement[1]).toBe(8000);
    expect(announcement[2].label).toBe("multiDbExecute.mergeResults");

    announcement[2].onClick();
    await nextTick();
    expect(open.value).toBe(true);
    expect(document.querySelector("[data-multi-source-merge-view]")).not.toBeNull();
  });

  it("reopens a settled batch straight in the merged view without re-running it", async () => {
    const open = ref(true);
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async (input) => ({ status: "success" as const, durationMs: 3, result: resultFor(input.target.database) }));
    await executeBatch(executeTarget, { open });

    button("common.close").click();
    await flushPromises();
    expect(open.value).toBe(false);

    open.value = true;
    await flushPromises();

    expect(document.querySelector("[data-multi-source-merge-view]")).not.toBeNull();
    expect(executeTarget).toHaveBeenCalledTimes(2);
  });
});
