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

describe("ExportProgressPopover data transfer duration", () => {
  it("shows frozen transfer elapsed time without adding it to other task kinds", async () => {
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
    expect(document.body.textContent?.match(/Elapsed:/g)).toHaveLength(1);
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
