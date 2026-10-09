// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  cancelTransfer: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  cancelDatabaseExport: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  cancelTableExport: vi.fn(),
  cancelTransfer: mocks.cancelTransfer,
  startTransfer: vi.fn(),
}));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
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

import DataTransferProgressDialog from "@/components/transfer/DataTransferProgressDialog.vue";
import { useExportTracker } from "@/composables/useExportTracker";

const mountedApps: App[] = [];

function resetTracker() {
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTracker();
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  resetTracker();
});

describe("DataTransferProgressDialog", () => {
  it("shows an invalid package and recovery without reporting it as transferred", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("package-result", "SOURCE → TARGET", 1);
    tracker.updateDataTransferTask(task.exportId, { transferId: task.exportId, table: "P", tableIndex: 1, totalTables: 1, rowsTransferred: 0, totalRows: null, status: "error", terminal: false, error: "Compilation failed", objectResult: { objectType: "PACKAGE_BODY", name: "P", schema: "TARGET", status: "failed", compileStatus: "INVALID", sourceVerified: false, error: "PLS-00302", recovery: "Previous definition restored" } });
    tracker.updateDataTransferTask(task.exportId, { transferId: task.exportId, table: "", tableIndex: 1, totalTables: 1, rowsTransferred: 0, totalRows: null, status: "done", terminal: true, error: null });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({ render: () => h(DataTransferProgressDialog, { open: true, task }) });
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await nextTick();
    expect(task.status).toBe("Error");
    expect(container.textContent).toContain("PACKAGE_BODY TARGET.P");
    expect(container.textContent).toContain("Migration or verification failed");
    expect(container.textContent).toContain("INVALID");
    expect(container.textContent).toContain("PLS-00302");
    expect(container.textContent).toContain("Previous definition restored");
    expect(container.textContent).not.toContain("Migrated and verified");
  });

  it("minimizes without cancelling and keeps the explicit cancel action", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("transfer-progress", "source → target", 2);
    let dialogOpen!: Ref<boolean>;
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup() {
          dialogOpen = ref(true);
          return () => h(DataTransferProgressDialog, { open: dialogOpen.value, "onUpdate:open": (value: boolean) => (dialogOpen.value = value), task });
        },
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    buttons()
      .find((button) => button.textContent?.includes("Minimize to background"))
      ?.click();
    await nextTick();
    expect(dialogOpen.value).toBe(false);
    expect(mocks.cancelTransfer).not.toHaveBeenCalled();
    expect(task.status).toBe("Running");

    dialogOpen.value = true;
    await nextTick();
    buttons()
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await vi.waitFor(() => expect(mocks.cancelTransfer).toHaveBeenCalledWith(task.exportId));
  });
});
