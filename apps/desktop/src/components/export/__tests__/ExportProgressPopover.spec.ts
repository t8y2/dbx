// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { slots }) {
        return () => h("button", slots.default?.());
      },
    }),
  };
});

import ExportProgressPopover from "@/components/export/ExportProgressPopover.vue";
import { useExportTracker } from "@/composables/useExportTracker";

const mountedApps: App[] = [];
let now = 0;

function resetTracker() {
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
}

beforeEach(() => {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  resetTracker();
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  resetTracker();
  vi.restoreAllMocks();
});

async function mountPopover() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ExportProgressPopover);
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

describe("ExportProgressPopover task duration", () => {
  it("distinguishes manual exports from scheduled backups and uses a compact failure dot", async () => {
    const tracker = useExportTracker();
    tracker.addDatabaseExportTask("manual-export", "app", "/tmp/app.sql");
    tracker.addDatabaseExportTask("scheduled-backup", "Nightly", "/tmp/backups", "scheduled");
    tracker.updateDatabaseExportTask("manual-export", {
      exportId: "manual-export",
      currentObject: "",
      objectIndex: 0,
      totalObjects: 0,
      rowsExported: 0,
      totalRows: null,
      status: "Error",
      error: "export failed",
    });

    await mountPopover();

    expect(document.body.textContent).toContain("Database export: app");
    expect(document.body.textContent).toContain("Database backup: Nightly");
    const failureDot = document.body.querySelector<HTMLSpanElement>("button > span");
    expect(failureDot?.classList.contains("h-2.5")).toBe(true);
    expect(failureDot?.classList.contains("w-2.5")).toBe(true);
    expect(failureDot?.classList.contains("right-0.5")).toBe(true);
    expect(failureDot?.classList.contains("top-0.5")).toBe(true);
    expect(failureDot?.textContent?.trim()).toBe("");
  });

  it("shows the current database export object without replacing the task title", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDatabaseExportTask("database-export", "demo_2000_tables", "/tmp/demo.sql");
    tracker.updateDatabaseExportTask(task.exportId, {
      exportId: task.exportId,
      currentObject: "t_0123_with_a_long_descriptive_name",
      objectIndex: 123,
      totalObjects: 2000,
      rowsExported: 456,
      totalRows: null,
      status: "Running",
      error: null,
      preparing: false,
    });

    await mountPopover();

    expect(document.body.textContent).toContain("Database export: demo_2000_tables");
    expect(document.body.textContent).toContain("Current: t_0123_with_a_long_descriptive_name (123/2,000)");
    expect(document.body.querySelector('[title="t_0123_with_a_long_descriptive_name"]')).not.toBeNull();
  });

  it("shows the current object while database export metadata is being prepared", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDatabaseExportTask("preparing-export", "demo", "/tmp/demo.sql");
    tracker.updateDatabaseExportTask(task.exportId, {
      exportId: task.exportId,
      currentObject: "t_0001",
      objectIndex: 0,
      totalObjects: 0,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      error: null,
      preparing: true,
    });

    await mountPopover();

    expect(document.body.textContent).toContain("Preparing: t_0001");
  });

  it.each(["Done", "Error", "Cancelled"] as const)("hides stale database object text after the task reaches %s", async (status) => {
    const tracker = useExportTracker();
    const task = tracker.addDatabaseExportTask(`terminal-${status}`, "Nightly", "/tmp/backups", "scheduled");
    tracker.updateDatabaseExportTask(task.exportId, {
      exportId: task.exportId,
      currentObject: "Nightly",
      objectIndex: 2,
      totalObjects: status === "Error" ? 0 : 2,
      rowsExported: 0,
      totalRows: null,
      status,
      error: status === "Error" ? "backup failed" : null,
      preparing: status === "Error",
    });

    await mountPopover();

    expect(document.body.textContent).not.toContain("Preparing: Nightly");
    expect(document.body.textContent).not.toContain("Current: Nightly");
  });

  it("shows frozen transfer elapsed time and live duration for table tasks", async () => {
    const tracker = useExportTracker();
    now = 1_000;
    const transfer = tracker.addDataTransferTask("transfer", "users", 1);
    now = 66_000;
    tracker.updateDataTransferTask(transfer.exportId, {
      transferId: transfer.exportId,
      table: "users",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      error: null,
      terminal: true,
    });
    tracker.addTask("audit_log", "csv", "/tmp/audit_log.csv");

    now = 120_000;
    await mountPopover();

    expect(document.body.textContent).toContain("Elapsed: 1m 5s");
    expect(document.body.textContent?.match(/Elapsed:/g)).toHaveLength(2);
  });

  it("expands complete per-table transfer failure details", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("failed-transfer", "source to target", 2);
    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "users",
      tableIndex: 0,
      totalTables: 2,
      rowsTransferred: 0,
      totalRows: null,
      status: "error",
      error: "permission denied for relation users",
      terminal: false,
    });
    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "",
      tableIndex: 2,
      totalTables: 2,
      rowsTransferred: 0,
      totalRows: null,
      status: "error",
      error: "1 table(s) failed: users",
      terminal: true,
    });

    await mountPopover();

    const detailsButton = document.body.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(detailsButton?.textContent).toContain("Failure details (1)");
    expect(document.body.textContent).not.toContain("permission denied for relation users");

    detailsButton?.click();
    await nextTick();

    expect(detailsButton?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("users");
    expect(document.body.textContent).toContain("permission denied for relation users");
  });

  it("shows the total failure count and omitted-detail notice when the bounded list is full", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("bounded-failures", "source to target", 101);
    for (let index = 0; index < 101; index += 1) {
      tracker.updateDataTransferTask(task.exportId, {
        transferId: task.exportId,
        table: `table_${index}`,
        tableIndex: index,
        totalTables: 101,
        rowsTransferred: 0,
        totalRows: null,
        status: "error",
        error: `failure ${index}`,
        terminal: false,
      });
    }

    await mountPopover();

    const detailsButton = document.body.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(detailsButton?.textContent).toContain("Failure details (101)");
    detailsButton?.click();
    await nextTick();

    expect(document.body.textContent).toContain("1 additional failure detail(s) not shown");
    expect(document.body.textContent).not.toContain("failure 100");
  });
});
