// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { ConnectionConfig } from "@/types/database";
import type { TableExportProgress, TableExportRequest } from "@/lib/backend/api";
import { useExportTracker } from "@/composables/useExportTracker";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  save: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  query: vi.fn(),
  json: vi.fn(),
  toast: vi.fn(),
  menu: [] as ContextMenuItem[],
  settings: { shortcuts: { refreshData: "F5" }, objectBrowserViewMode: "list", objectBrowserShowCheckbox: false, exportBatchSize: 123, csvQuoteMode: "minimal", csvNullMode: "empty", exportRowLimitEnabled: false, generateSqlIncludeDatabaseName: true },
}));
vi.mock("@/lib/backend/api", () => ({
  listObjects: vi.fn(async () => [{ name: "orders", object_type: "TABLE" }]),
  listSchemas: vi.fn(async () => []),
  getColumns: vi.fn(async () => []),
  listObjectStatistics: vi.fn(async () => []),
  startTableExport: mocks.start,
  cancelTableExport: mocks.cancel,
  executeQuery: mocks.query,
  exportQueryResultJson: mocks.json,
  buildTableSelectSql: vi.fn(async ({ tableName }) => `SELECT * FROM ${tableName}`),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => connection, ensureConnected: vi.fn(async () => undefined), connectionIdentifierQuote: () => "`", tableNameFilterForScope: () => undefined, orderByPinnedTreeNodes: (rows: unknown[]) => rows }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: mocks.settings }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/export/exportExecutionMode", () => ({ showExportExecutionModeDialog: mocks.mode }));
vi.mock("@/lib/export/exportPath", () => ({ promptExportSavePath: mocks.save, autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        slots.default?.({
          onContextMenu: () => {
            mocks.menu = typeof props.items === "function" ? props.items() : props.items;
          },
          isOpen: false,
        }),
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "export-queue-mysql", name: "MySQL", db_type: "mysql", database: "app", transport_layers: [] } as unknown as ConnectionConfig;
const mounted: Array<{ app: App; host: HTMLElement }> = [];
const operations: Array<{ request: TableExportRequest; progress: (value: TableExportProgress) => void; resolve: (value: TableExportProgress) => void; reject: (error: Error) => void }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.menu = [];
  operations.length = 0;
  mocks.settings.exportBatchSize = 123;
  mocks.mode.mockResolvedValue("queued");
  mocks.save.mockResolvedValue("C:/exports/orders.csv");
  mocks.cancel.mockResolvedValue(undefined);
  mocks.query.mockReset().mockResolvedValue({ columns: ["ID"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 });
  mocks.json.mockReset().mockResolvedValue(undefined);
  mocks.start.mockImplementation((request, progress) => new Promise((resolve, reject) => operations.push({ request, progress, resolve, reject })));
  invalidateObjectBrowserRowsCache({});
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
  invalidateObjectBrowserRowsCache({});
});
async function mountBrowser() {
  const database = ref("app");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: database.value }) });
  mounted.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain("orders"));
  const row = host.querySelector<HTMLElement>(".grid.h-\\[34px\\]")!;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  return {
    database,
    export: async (format: string) => {
      const find = (items: ContextMenuItem[]): ContextMenuItem | undefined => {
        for (const item of items) {
          if (item.label === `contextMenu.exportData · ${format}`) return item;
          const child = item.children && find(item.children);
          if (child) return child;
        }
      };
      const item = find(mocks.menu);
      expect(item, JSON.stringify(mocks.menu.map((item) => ({ label: item.label, children: item.children?.map((item) => item.label) })))).toBeDefined();
      const action = item!.action!;
      await action();
      await nextTick();
    },
  };
}
function finish(index: number, status: "Done" | "Cancelled" = "Done") {
  const operation = operations[index]!;
  const terminal: TableExportProgress = { exportId: operation.request.exportId, tableName: "orders", rowsExported: 10, totalRows: 10, status };
  operation.progress(terminal);
  operation.resolve(terminal);
}
it("captures the actual object-menu target and settings before queue waiting", async () => {
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
  const browser = await mountBrowser();
  await browser.export("CSV");
  expect(operations).toHaveLength(0);
  browser.database.value = "other";
  mocks.settings.exportBatchSize = 999;
  release();
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  expect(operations[0]!.request).toMatchObject({ connectionId: connection.id, database: "app", tableName: "orders", batchSize: 123, filePath: "C:/exports/orders.csv" });
  finish(0);
  await vi.waitFor(() => expect(tracker.tasks.value[1]!.status).toBe("Done"));
});
it("does not let a cancel acknowledgement release a running object export", async () => {
  const browser = await mountBrowser();
  await browser.export("CSV");
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  const tracker = useExportTracker();
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
  expect(next).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledOnce();
  finish(0, "Cancelled");
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
});
it("queues JSON before reading and waits for its actual writer", async () => {
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
  let written!: () => void;
  mocks.json.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        written = resolve;
      }),
  );
  const browser = await mountBrowser();
  await browser.export("JSON");
  expect(mocks.query).not.toHaveBeenCalled();
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  release();
  await vi.waitFor(() => expect(mocks.json).toHaveBeenCalledOnce());
  expect(mocks.json).toHaveBeenCalledWith("C:/exports/orders.csv", ["ID"], [[7]]);
  expect(tracker.tasks.value[1]!.canCancel).toBe(false);
  expect(next).not.toHaveBeenCalled();
  written();
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
});

it("keeps a transport rejection unknown instead of advancing the queue after cancellation", async () => {
  const browser = await mountBrowser();
  await browser.export("CSV");
  await vi.waitFor(() => expect(operations).toHaveLength(1));
  const tracker = useExportTracker();
  const next = vi.fn().mockResolvedValue("settled");
  tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
  await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
  operations[0]!.reject(new Error("invoke reply lost"));
  await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
  expect(tracker.tasks.value[0]!.finishedAt).toBeUndefined();
  expect(next).not.toHaveBeenCalled();
});
