// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TransferRequest, TransferOwnershipPreview } from "@/lib/backend/api";
import { createOracleRoutineDeployment } from "@/lib/schema/oracleRoutineDeploy";
import type { OracleRoutineSnapshot } from "@/types/schemaDiff";

const calls = vi.hoisted(() => ({
  preview: vi.fn(),
  start: vi.fn(),
  cancelTransfer: vi.fn(),
  tables: vi.fn(),
  writable: vi.fn(),
  confirm: vi.fn(),
  cancelScope: vi.fn(),
  toast: vi.fn(),
  openTask: vi.fn(),
}));

const sourceConnection = { id: "source-conn", name: "Source Connection", db_type: "postgres", database: "postgres" };
const targetConnection = { id: "target-conn", name: "Target Connection", db_type: "postgres", database: "tenant", is_production: false, production_databases: [] as string[] };
const connections = [sourceConnection, targetConnection];

vi.mock("@/lib/backend/api", () => ({
  previewTransferOwnership: calls.preview,
  startTransfer: calls.start,
  cancelTransfer: calls.cancelTransfer,
  listDatabases: vi.fn(async () => [{ name: "postgres" }, { name: "tenant" }]),
  listSchemas: vi.fn(async () => ["public"]),
  listTables: calls.tables,
  listObjects: vi.fn(async () => [{ name: "orders" }, { name: "users" }]),
  updateOracleRoutineOperationReferences: vi.fn(),
  observeOracleRoutineOperation: vi.fn(),
  prepareOracleRoutinePlan: vi.fn(),
  executeOracleRoutineOperation: vi.fn(),
  loadSchemaDiffRoutines: vi.fn(),
  prepareSchemaDiff: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections,
    sidebarLayout: { groups: [], order: [] },
    getConfig: (id: string) => connections.find((c) => c.id === id),
    ensureConnected: async () => {},
    refreshObjectListTreeNode: vi.fn(),
  }),
}));

vi.mock("@/stores/transferTaskStore", () => ({
  useTransferTaskStore: () => ({
    initFromStorage: async () => {},
    getTask: () => undefined,
    listTasks: () => [],
    saveTask: vi.fn(),
  }),
  TransferTaskNameConflictError: class extends Error {},
  nextTransferTaskCopyName: (name: string) => name,
}));

vi.mock("@/components/transfer/TransferTaskTree.vue", () => ({
  default: defineComponent({
    setup() {
      return () => h("div", { "data-testid": "task-tree" });
    },
  }),
}));

vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({
  default: defineComponent({
    props: ["modelValue", "connections"],
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "select",
          {
            value: props.modelValue,
            onChange: (e: Event) => emit("update:modelValue", (e.target as HTMLSelectElement).value),
          },
          (props.connections ?? []).map((c: any) => h("option", { value: c.id }, c.name)),
        );
    },
  }),
}));

vi.mock("@/composables/useDialogSources", () => ({
  openDataTransferTask: calls.openTask,
  openSchemaDiffSession: vi.fn(),
  reexecuteDataTransferTask: vi.fn(),
}));

vi.mock("@/lib/database/readOnlyWriteAccess", () => ({
  ensureReadOnlyWriteAccess: calls.writable,
}));

vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({
    requestConfirmation: calls.confirm,
    cancelScope: calls.cancelScope,
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: calls.toast }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (t: string) => t }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn() }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({
  createShikiSqlHighlighter: async () => (sql: string) => sql,
}));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: vi.fn() }));

vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static updateListener = { of: (listener: unknown) => ({ listener }) };
    static scrollIntoView = () => ({});
    state: any;
    constructor({ state }: any) {
      this.state = state;
    }
    dispatch() {}
    focus() {}
    destroy() {}
  },
}));
vi.mock("@codemirror/state", () => ({
  EditorState: {
    readOnly: { of: () => [] },
    create: (config: any) => ({ ...config, doc: { toString: () => config.doc, length: config.doc.length } }),
  },
  Compartment: class {
    of() {
      return [];
    }
  },
}));
vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));
vi.mock("codemirror", () => ({ basicSetup: [] }));

import DataTransferDialog from "@/components/transfer/DataTransferDialog.vue";
import { useExportTracker } from "@/composables/useExportTracker";

const apps: App[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  calls.tables.mockResolvedValue([
    { name: "orders", table_type: "TABLE" },
    { name: "users", table_type: "TABLE" },
  ]);
  calls.writable.mockResolvedValue(true);
  calls.confirm.mockResolvedValue(true);
  targetConnection.is_production = false;
  targetConnection.production_databases = [];
  i18n.global.locale.value = "en";

  calls.preview.mockImplementation(async (request: TransferRequest): Promise<TransferOwnershipPreview> => {
    if (request.dropTargetBeforeCreate) {
      return {
        missingOwners: [],
        targetOwner: "tenant",
        structure: {
          sql: "CREATE TABLE orders (id INT);",
          tables: [{ sourceTable: "orders", targetTable: "orders", sql: "CREATE TABLE orders (id INT);" }],
          operations: [],
          schemaObjectsExpanded: true,
        },
        rebuild: {
          sql: "ALTER TABLE orders RENAME TO orders_bak; CREATE TABLE orders (id INT); DROP TABLE orders_bak;",
          tables: [{ sourceTable: "orders", targetTable: "orders", backupTable: "orders_bak" }],
          backupSql: "ALTER TABLE orders RENAME TO orders_bak;",
          structureSql: "CREATE TABLE orders (id INT);",
          cleanupSql: "DROP TABLE orders_bak;",
        },
      };
    }
    return {
      missingOwners: [],
      targetOwner: "tenant",
    };
  });

  calls.start.mockImplementation(async (request, progress, started) => {
    started?.();
    progress({
      transferId: request.transferId,
      table: "orders",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      terminal: true,
      error: null,
    });
  });
});

afterEach(async () => {
  apps.splice(0).forEach((app) => app.unmount());
  const tracker = useExportTracker();
  tracker.clearFinished();
  await nextTick();
  document.body.innerHTML = "";
});

function findButton(predicate: (text: string) => boolean): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => predicate(b.textContent?.trim() || ""));
}

describe("DataTransferDialog Re-execution (#13621 / P1 review)", () => {
  it("re-executes overwrite transfer: prefills parameters, regenerates plan, requires confirmation before start", async () => {
    const tracker = useExportTracker();
    const task = tracker.startDataTransferTask(
      {
        transferId: "task-initial-overwrite",
        sourceConnectionId: sourceConnection.id,
        sourceDatabase: "postgres",
        sourceSchema: "public",
        targetConnectionId: targetConnection.id,
        targetDatabase: "tenant",
        targetSchema: "public",
        tables: ["orders"],
        createTable: true,
        content: "structureAndData",
        objects: [{ objectType: "TABLE", names: ["orders"] }],
        mode: "overwrite",
        targetTableNameCase: "preserve",
        quoteTargetColumnNames: true,
        batchSize: 500,
        dropTargetBeforeCreate: false,
        dropTargetConfirmed: false,
      },
      "postgres → tenant",
    );

    // Complete the task
    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "orders",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      terminal: true,
      error: null,
    });
    await nextTick();

    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ open: true, taskId: task.exportId as string | null });
    const app = createApp({
      render: () =>
        h(TooltipProvider, {}, () =>
          h(DataTransferDialog, {
            open: state.open,
            taskId: state.taskId,
            "onUpdate:open": (v: boolean) => (state.open = v),
            "onUpdate:taskId": (v: string | null) => (state.taskId = v),
          }),
        ),
    });
    apps.push(app);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    // In progress dialog mode for completed task, Re-execute button is rendered
    const reexecuteBtn = findButton((text) => text.includes("Re-execute"));
    expect(reexecuteBtn).toBeDefined();

    // Click Re-execute
    reexecuteBtn!.click();
    await vi.waitFor(() => expect(calls.preview).toHaveBeenCalled());

    // Plan was regenerated via previewTransferOwnership with unconfirmed dropTargetConfirmed
    expect(calls.preview).toHaveBeenCalledTimes(1);
    const previewArg = calls.preview.mock.calls[0][0] as TransferRequest;
    expect(previewArg.dropTargetConfirmed).toBe(false);
    expect(previewArg.mode).toBe("overwrite");
    expect(previewArg.tables).toEqual(["orders"]);

    // Confirmation dialog is shown; startTransfer must NOT have been called yet!
    expect(calls.start).toHaveBeenCalledTimes(1); // Only the initial run from task setup

    // Confirm the transfer
    const confirmBtn = findButton((text) => text === "Start Transfer" || text === "Start");
    expect(confirmBtn).toBeDefined();
    confirmBtn!.click();

    // Now startTransfer is invoked with fresh transferId and overwrite mode
    await vi.waitFor(() => expect(calls.start).toHaveBeenCalledTimes(2));
    const startArg = calls.start.mock.calls[1][0] as TransferRequest;
    expect(startArg.transferId).not.toBe("task-initial-overwrite");
    expect(startArg.mode).toBe("overwrite");
    expect(startArg.dropTargetConfirmed).toBe(false);
    expect(startArg.tables).toEqual(["orders"]);
  });

  it("re-executes rebuild transfer: displays SQL preview, danger warning, and only sets dropTargetConfirmed on acceptance", async () => {
    const tracker = useExportTracker();
    const task = tracker.startDataTransferTask(
      {
        transferId: "task-initial-rebuild",
        sourceConnectionId: sourceConnection.id,
        sourceDatabase: "postgres",
        sourceSchema: "public",
        targetConnectionId: targetConnection.id,
        targetDatabase: "tenant",
        targetSchema: "public",
        tables: ["orders"],
        createTable: true,
        content: "structureAndData",
        objects: [{ objectType: "TABLE", names: ["orders"] }],
        mode: "append",
        targetTableNameCase: "preserve",
        quoteTargetColumnNames: true,
        batchSize: 500,
        dropTargetBeforeCreate: true,
        dropTargetConfirmed: false,
      },
      "postgres → tenant",
    );

    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "orders",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      terminal: true,
      error: null,
    });
    await nextTick();

    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ open: true, taskId: task.exportId as string | null });
    const app = createApp({
      render: () =>
        h(TooltipProvider, {}, () =>
          h(DataTransferDialog, {
            open: state.open,
            taskId: state.taskId,
            "onUpdate:open": (v: boolean) => (state.open = v),
            "onUpdate:taskId": (v: string | null) => (state.taskId = v),
          }),
        ),
    });
    apps.push(app);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const reexecuteBtn = findButton((text) => text.includes("Re-execute"));
    expect(reexecuteBtn).toBeDefined();

    reexecuteBtn!.click();
    await vi.waitFor(() => expect(calls.preview).toHaveBeenCalled());

    // SQL preview confirmation dialog is shown with rebuild plan and danger notice
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("orders_bak");
    });
    // startTransfer has NOT been called yet for the re-execution
    expect(calls.start).toHaveBeenCalledTimes(1);

    // User confirms rebuild execution
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('button[data-variant="destructive"]');
    expect(confirmBtn).toBeDefined();
    confirmBtn!.click();

    // Now startTransfer is called with dropTargetConfirmed = true
    await vi.waitFor(() => expect(calls.start).toHaveBeenCalledTimes(2));
    const startArg = calls.start.mock.calls[1][0] as TransferRequest;
    expect(startArg.transferId).not.toBe("task-initial-rebuild");
    expect(startArg.dropTargetBeforeCreate).toBe(true);
    expect(startArg.dropTargetConfirmed).toBe(true);
  });

  it("triggers production safety confirmation when target is production database", async () => {
    targetConnection.is_production = false;
    targetConnection.production_databases = ["tenant"];

    const tracker = useExportTracker();
    const task = tracker.startDataTransferTask(
      {
        transferId: "task-initial-prod",
        sourceConnectionId: sourceConnection.id,
        sourceDatabase: "postgres",
        sourceSchema: "public",
        targetConnectionId: targetConnection.id,
        targetDatabase: "tenant",
        targetSchema: "public",
        tables: ["orders"],
        createTable: true,
        content: "structureAndData",
        objects: [{ objectType: "TABLE", names: ["orders"] }],
        mode: "overwrite",
        targetTableNameCase: "preserve",
        quoteTargetColumnNames: true,
        batchSize: 500,
        dropTargetBeforeCreate: false,
        dropTargetConfirmed: false,
      },
      "postgres → tenant",
    );

    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "orders",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      terminal: true,
      error: null,
    });
    await nextTick();

    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ open: true, taskId: task.exportId as string | null });
    const app = createApp({
      render: () =>
        h(TooltipProvider, {}, () =>
          h(DataTransferDialog, {
            open: state.open,
            taskId: state.taskId,
            "onUpdate:open": (v: boolean) => (state.open = v),
            "onUpdate:taskId": (v: string | null) => (state.taskId = v),
          }),
        ),
    });
    apps.push(app);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const reexecuteBtn = findButton((text) => text.includes("Re-execute"));
    reexecuteBtn!.click();

    // Production safety check was requested
    await vi.waitFor(() => expect(calls.confirm).toHaveBeenCalled());
    expect(calls.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        database: "tenant",
        productionDatabases: ["tenant"],
      }),
    );
  });

  it("cancel regression: cancelling confirmation does not call startTransfer and preserves prefilled form", async () => {
    const tracker = useExportTracker();
    const task = tracker.startDataTransferTask(
      {
        transferId: "task-initial-cancel",
        sourceConnectionId: sourceConnection.id,
        sourceDatabase: "postgres",
        sourceSchema: "public",
        targetConnectionId: targetConnection.id,
        targetDatabase: "tenant",
        targetSchema: "public",
        tables: ["orders"],
        createTable: true,
        content: "structureAndData",
        objects: [{ objectType: "TABLE", names: ["orders"] }],
        mode: "append",
        targetTableNameCase: "preserve",
        quoteTargetColumnNames: true,
        batchSize: 500,
        dropTargetBeforeCreate: true,
        dropTargetConfirmed: false,
      },
      "postgres → tenant",
    );

    tracker.updateDataTransferTask(task.exportId, {
      transferId: task.exportId,
      table: "orders",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 10,
      totalRows: 10,
      status: "done",
      terminal: true,
      error: null,
    });
    await nextTick();

    const host = document.createElement("div");
    document.body.append(host);
    const state = reactive({ open: true, taskId: task.exportId as string | null });
    const app = createApp({
      render: () =>
        h(TooltipProvider, {}, () =>
          h(DataTransferDialog, {
            open: state.open,
            taskId: state.taskId,
            "onUpdate:open": (v: boolean) => (state.open = v),
            "onUpdate:taskId": (v: string | null) => (state.taskId = v),
          }),
        ),
    });
    apps.push(app);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    findButton((text) => text.includes("Re-execute"))!.click();
    await vi.waitFor(() => expect(calls.preview).toHaveBeenCalled());

    // Cancel button in SQL preview dialog
    await vi.waitFor(() => {
      expect(document.body.querySelector('button[data-variant="destructive"]')).not.toBeNull();
    });
    const dangerFooter = document.body.querySelector('button[data-variant="destructive"]')?.closest('[data-slot="dialog-footer"]');
    const cancelBtn = dangerFooter?.querySelector<HTMLButtonElement>('button[data-variant="outline"]');
    expect(cancelBtn).toBeDefined();
    cancelBtn!.click();
    await nextTick();

    // startTransfer was NOT invoked for re-execution
    expect(calls.start).toHaveBeenCalledTimes(1);

    // Form remains open and prefilled with the task configuration
    expect(state.open).toBe(true);
    expect(state.taskId).toBeNull();
  });

  it("does not reuse executed OracleRoutineDeployment instance", async () => {
    const dummySnapshot: OracleRoutineSnapshot = {
      endpoint: { connectionId: "source-conn", database: "postgres", schema: "public", databaseType: "postgres", generation: 1 },
      state: "complete",
      enumerationComplete: true,
      objects: [],
      issues: [],
    };
    const oldDeployment = reactive(createOracleRoutineDeployment(dummySnapshot, dummySnapshot));
    oldDeployment.executing = false;

    const tracker = useExportTracker();
    const task = tracker.startDataTransferTask(
      {
        transferId: "task-initial-oracle",
        sourceConnectionId: sourceConnection.id,
        sourceDatabase: "postgres",
        sourceSchema: "public",
        targetConnectionId: targetConnection.id,
        targetDatabase: "tenant",
        targetSchema: "public",
        tables: ["orders"],
        createTable: true,
        content: "structureAndData",
        objects: [{ objectType: "TABLE", names: ["orders"] }],
        mode: "append",
        targetTableNameCase: "preserve",
        quoteTargetColumnNames: true,
        batchSize: 500,
        dropTargetBeforeCreate: false,
        dropTargetConfirmed: false,
      },
      "postgres → tenant",
      { oracleRoutineDeployment: oldDeployment },
    );

    // The initial task tracker options do NOT retain oracleRoutineDeployment
    expect(task.dataTransferOptions?.oracleRoutineDeployment).toBeUndefined();
  });
});
