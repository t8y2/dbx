// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DatabaseExportDialog from "../DatabaseExportDialog.vue";
import { useExportTracker } from "@/composables/useExportTracker";
import type { ConnectionConfig } from "@/types/database";
import type { DatabaseExportRequest, ExportProgress } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({ export: vi.fn(), begin: vi.fn(), rollback: vi.fn(), cancel: vi.fn(), toast: vi.fn(), listSchemas: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  listDatabases: vi.fn(async () => [{ name: "app" }, { name: "other" }]),
  listSchemas: mocks.listSchemas,
  listTables: vi.fn(async () => [
    { name: "orders", table_type: "TABLE" },
    { name: "audit", table_type: "TABLE" },
  ]),
  exportDatabaseSql: mocks.export,
  beginDatabaseBackupSnapshot: mocks.begin,
  rollbackManualTransaction: mocks.rollback,
  cancelDatabaseExport: mocks.cancel,
  recordDatabaseExportDestination: vi.fn(async () => undefined),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [connection], getConfig: () => connection, ensureConnected: vi.fn(async () => undefined) }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: {} }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/export/exportPath", () => ({ promptExportSavePath: vi.fn(async () => "C:/exports/original.sql"), autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:/exports") }));
vi.mock("@tauri-apps/api/path", () => ({ dirname: vi.fn(async () => "C:/exports") }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { install() {}, global: { t: (key: string) => key } } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/connection/ConnectionGroupBadge.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/dialog", () => {
  const component = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Dialog: component, DialogHeader: component, DialogTitle: component, DialogFooter: component, DialogContent: component };
});
vi.mock("@/components/ui/select", () => {
  const component = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Select: component, SelectContent: component, SelectItem: component, SelectTrigger: component, SelectValue: component };
});

const connection = { id: "database-export-queue", name: "MySQL", db_type: "mysql", database: "app", transport_layers: [] } as unknown as ConnectionConfig;
const operations: Array<{ request: DatabaseExportRequest; progress: (value: ExportProgress) => void; resolve: () => void; reject: (error: Error) => void }> = [];
const mounted: Array<{ app: App; host: HTMLElement }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  operations.length = 0;
  connection.db_type = "mysql";
  mocks.listSchemas.mockResolvedValue(["public"]);
  mocks.begin.mockReset().mockImplementation(async (_id, database) => ({ sessionId: `snapshot-${database}` }));
  mocks.rollback.mockReset().mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.export.mockImplementation((request, progress) => new Promise<void>((resolve, reject) => operations.push({ request, progress, resolve, reject })));
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
});
async function mountDialog(allDatabases = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const open = ref(true);
  const app = createApp({
    setup: () => () =>
      h(DatabaseExportDialog, {
        open: open.value,
        "onUpdate:open": (value: boolean) => {
          open.value = value;
        },
        prefillConnectionId: connection.id,
        ...(allDatabases ? { prefillAllDatabases: true } : { prefillDatabase: "app", prefillSchema: "app", prefillTable: "orders" }),
      }),
  });
  mounted.push({ app, host });
  app.mount(host);
  const key = allDatabases ? "databaseExport.exportAllDatabases" : "databaseExport.export";
  const button = await vi.waitFor(() => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === key);
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    return button!;
  });
  return {
    host,
    open,
    start: async () => {
      const radio = host.querySelector<HTMLInputElement>('input[value="queued"]')!;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
      button.click();
      await vi.waitFor(() => expect(useExportTracker().tasks.value.some((task) => task.kind === "database-export")).toBe(true));
    },
  };
}
function terminal(index: number, status: "Done" | "Cancelled" = "Done", resolve = true) {
  const operation = operations[index]!;
  operation.progress({ exportId: operation.request.exportId, currentObject: "orders", objectIndex: 1, totalObjects: 1, rowsExported: 7, totalRows: 7, status, error: null });
  if (resolve) operation.resolve();
}
it("does not begin a snapshot or database export while queued and cancels waiting without RPCs", async () => {
  const tracker = useExportTracker();
  let release!: () => void;
  tracker.submitExportTask(
    tracker.addTask("blocker", "csv", "first.csv"),
    "immediate",
    () =>
      new Promise((resolve) => {
        release = () => resolve("settled");
      }),
  );
  const dialog = await mountDialog();
  await dialog.start();
  expect(dialog.host.textContent).toContain("exportProgress.queued");
  expect(mocks.begin).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
  await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
  release();
  await nextTick();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.begin).not.toHaveBeenCalled();
});
it("keeps a single database lease through native completion and snapshot rollback", async () => {
  const tracker = useExportTracker();
  const dialog = await mountDialog();
  await dialog.start();
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  let rollback!: () => void;
  mocks.rollback.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        rollback = resolve;
      }),
  );
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  terminal(0, "Done", false);
  expect(next).not.toHaveBeenCalled();
  expect(mocks.rollback).not.toHaveBeenCalled();
  operations[0]!.resolve();
  await vi.waitFor(() => expect(mocks.rollback).toHaveBeenCalledOnce());
  expect(tracker.tasks.value[0]!.status).toBe("Running");
  expect(next).not.toHaveBeenCalled();
  rollback();
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  expect(tracker.tasks.value[0]!.status).toBe("Done");
  expect(operations[0]!.request).toMatchObject({ database: "app", selectedTables: ["orders"], snapshotSessionId: "snapshot-app", filePath: "C:/exports/original.sql" });
});
it("holds the whole multi-database operation across child completion and each rollback", async () => {
  const tracker = useExportTracker();
  const dialog = await mountDialog(true);
  await dialog.start();
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  terminal(0);
  await vi.waitFor(() => expect(operations).toHaveLength(2));
  expect(next).not.toHaveBeenCalled();
  expect(mocks.rollback).toHaveBeenCalledWith("snapshot-app");
  expect(operations.map((operation) => operation.request.filePath)).toEqual(["C:/exports/app.sql", "C:/exports/other.sql"]);
  terminal(1);
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  expect(mocks.rollback).toHaveBeenCalledWith("snapshot-other");
});
it.each([false, true])("waits through cancellation and rollback without starting another database (batch: %s)", async (batch) => {
  const tracker = useExportTracker();
  const dialog = await mountDialog(batch);
  await dialog.start();
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
  expect(mocks.cancel).toHaveBeenCalledWith(operations[0]!.request.exportId);
  expect(next).not.toHaveBeenCalled();
  terminal(0, "Cancelled");
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  expect(operations).toHaveLength(1);
  expect(tracker.tasks.value[0]!.status).toBe("Cancelled");
  expect(mocks.rollback).toHaveBeenCalledOnce();
});
it("does not release the queue when rollback completion is unknown", async () => {
  const tracker = useExportTracker();
  const dialog = await mountDialog();
  await dialog.start();
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  mocks.rollback.mockRejectedValueOnce(new Error("rollback reply lost"));
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  terminal(0);
  await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
  expect(next).not.toHaveBeenCalled();
  expect(tracker.tasks.value[0]!.errorMessage).toBe("rollback reply lost");
});
