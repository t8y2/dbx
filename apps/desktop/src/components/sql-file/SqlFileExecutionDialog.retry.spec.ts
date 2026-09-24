// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: true,
  releaseSqlFilePreview: vi.fn(),
  previewWebSqlFile: vi.fn(),
  addSqlFileTask: vi.fn(),
  beginManualTransaction: vi.fn(),
  commitManualTransaction: vi.fn(),
  rollbackManualTransaction: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  ensureConnected: vi.fn(),
  executeSqlFiles: vi.fn(),
  fetchSqlFileTargetOptions: vi.fn(),
  highlight: vi.fn(),
  highlighterState: undefined as undefined | { ready: boolean; appearance: string },
  listenSqlFileProgress: vi.fn(),
  openFileDialog: vi.fn(),
  previewSqlFile: vi.fn(),
  inspectSqlFileTables: vi.fn(),
  progressHandler: undefined as undefined | ((progress: Record<string, unknown>) => void),
  changeDialogOpen: undefined as undefined | ((open: boolean) => void),
  refreshDatabaseTreeNode: vi.fn(),
  requestConfirmation: vi.fn(),
  toast: vi.fn(),
  trackerTask: undefined as any,
  unlisten: vi.fn(),
  updateSqlFileTask: vi.fn(),
  uuid: vi.fn(),
}));

function passthrough(tag: string) {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/common/utils", () => ({ uuid: mocks.uuid }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@/lib/backend/http", () => ({
  previewSqlFile: mocks.previewWebSqlFile,
  loadSqlFileUploadMaxBytes: vi.fn(async () => 200 * 1024 * 1024),
}));
vi.mock("@/lib/sql/httpSqlFileProgress", () => ({
  listenSqlFileProgressById: (_id: string, handler: (progress: Record<string, unknown>) => void) => mocks.listenSqlFileProgress(handler),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openFileDialog }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: mocks.highlight }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({ addSqlFileTask: mocks.addSqlFileTask, updateSqlFileTask: mocks.updateSqlFileTask }),
}));
vi.mock("@/composables/useDatabaseOptions", () => ({ fetchSqlFileTargetOptions: mocks.fetchSqlFileTargetOptions }));
vi.mock("@/lib/connection/connectionLevelDatabaseBootstrap", () => ({ requiresSqlFileTargetDatabaseSelection: () => false, supportsConnectionLevelDatabaseBootstrap: (connection: any) => connection?.db_type === "mysql" }));
vi.mock("@/lib/database/productionSafety", () => ({ productionContextForDatabase: () => ({ active: false, databases: [] }) }));
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({ requestConfirmation: mocks.requestConfirmation }),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "mysql-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    ensureConnected: mocks.ensureConnected,
    getConfig: () => ({ id: "mysql-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql", database: "" }),
    refreshDatabaseTreeNode: mocks.refreshDatabaseTreeNode,
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  beginManualTransaction: mocks.beginManualTransaction,
  commitManualTransaction: mocks.commitManualTransaction,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
  cancelSqlFileExecution: mocks.cancelSqlFileExecution,
  executeSqlFiles: mocks.executeSqlFiles,
  listenSqlFileProgress: mocks.listenSqlFileProgress,
  previewSqlFile: mocks.previewSqlFile,
  releaseSqlFilePreview: mocks.releaseSqlFilePreview,
  inspectSqlFileTables: mocks.inspectSqlFileTables,
}));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return { Check: Icon, CheckSquare: Icon, ChevronRight: Icon, FileCode: Icon, FolderOpen: Icon, Loader2: Icon, Play: Icon, Square: Icon, X: Icon };
});
vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    emits: ["update:open"],
    setup(_, { attrs, slots, emit }) {
      mocks.changeDialogOpen = (open) => emit("update:open", open);
      return () => h("div", attrs, slots.default?.());
    },
  }),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogScrollContent: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: passthrough("div"),
  TooltipContent: passthrough("div"),
  TooltipTrigger: passthrough("div"),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () => h("input", { value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
    },
  }),
}));
vi.mock("@/components/ui/label", () => ({ Label: passthrough("label") }));
vi.mock("@/components/ui/select", () => ({
  Select: passthrough("div"),
  SelectContent: passthrough("div"),
  SelectItem: passthrough("div"),
  SelectTrigger: passthrough("div"),
  SelectValue: passthrough("span"),
}));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: passthrough("span") }));
vi.mock("@/components/connection/ConnectionGroupBadge.vue", () => ({ default: passthrough("span") }));

import SqlFileExecutionDialog from "./SqlFileExecutionDialog.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

function progress(executionId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    executionId,
    status,
    statementIndex: 0,
    successCount: 0,
    failureCount: 0,
    affectedRows: 0,
    elapsedMs: 10,
    statementSummary: "",
    ...overrides,
  };
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(root!.querySelectorAll("button")).find((item) => item.textContent?.trim().endsWith(label));
  expect(button, `button ${label}`).toBeDefined();
  return button!;
}

async function mountReadyDialog(onOpenChange = vi.fn()) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(SqlFileExecutionDialog, { open: true, "onUpdate:open": onOpenChange });
  app.mount(root);

  await vi.waitFor(() => expect(mocks.fetchSqlFileTargetOptions).toHaveBeenCalled());
  findButton("sqlFile.browse").click();
  await vi.waitFor(() => expect(mocks.previewSqlFile).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
}

async function completeFirstExecution() {
  mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
    mocks.progressHandler?.(progress(request.executionId, "running", { fileIndex: 0, fileName: "first.sql" }));
    mocks.progressHandler?.(progress(request.executionId, "statementDone", { fileIndex: 0, fileName: "first.sql", statementIndex: 1, successCount: 1 }));
    mocks.progressHandler?.(progress(request.executionId, "running", { fileIndex: 1, fileName: "second.sql", statementIndex: 1, successCount: 1 }));
    mocks.progressHandler?.(progress(request.executionId, "statementDone", { fileIndex: 1, fileName: "second.sql", statementIndex: 1, successCount: 1, affectedRows: 2 }));
    mocks.progressHandler?.(progress(request.executionId, "done", { statementIndex: 2, successCount: 2, affectedRows: 2 }));
  });

  findButton("sqlFile.execute").click();
  await vi.waitFor(() => expect(root!.querySelector("table")).not.toBeNull());
  expect(root!.querySelector("table")!.textContent).toContain("first.sql");
  expect(root!.querySelector("table")!.textContent).toContain("second.sql");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  mocks.releaseSqlFilePreview.mockResolvedValue(undefined);
  mocks.progressHandler = undefined;
  mocks.highlighterState = reactive({ ready: false, appearance: "light" });
  mocks.highlight.mockReset().mockImplementation((sql: string) => (mocks.highlighterState!.ready ? `<span data-theme="${mocks.highlighterState!.appearance}">${sql}</span>` : sql));
  mocks.trackerTask = undefined;
  mocks.addSqlFileTask.mockImplementation((exportId: string, tableName: string, filePath: string) => {
    mocks.trackerTask = reactive({
      exportId,
      kind: "sql-file",
      tableName,
      format: "sql",
      filePath,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
      sqlFileFailures: [],
      sqlFileFailuresOmitted: 0,
    });
    return mocks.trackerTask;
  });
  mocks.updateSqlFileTask.mockImplementation((_executionId: string, next: Record<string, any>, context?: { fileIndex?: number; fileName?: string }) => {
    if (next.status === "statementFailed" && next.error) {
      mocks.trackerTask.sqlFileFailures.push({
        statementIndex: next.statementIndex,
        statementSummary: next.statementSummary,
        error: next.error,
        ...(context?.fileIndex === undefined ? {} : { fileIndex: context.fileIndex }),
        ...(context?.fileName ? { fileName: context.fileName } : {}),
      });
    }
  });
  mocks.beginManualTransaction.mockReset().mockResolvedValue("txn-1");
  mocks.commitManualTransaction.mockReset().mockResolvedValue(undefined);
  mocks.rollbackManualTransaction.mockReset().mockResolvedValue(undefined);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.inspectSqlFileTables.mockResolvedValue([
    { database: "app", name: "users" },
    { database: "app", name: "orders" },
    { database: "archive", name: "users" },
  ]);
  mocks.fetchSqlFileTargetOptions.mockResolvedValue([]);
  mocks.openFileDialog.mockResolvedValue(["/tmp/first.sql", "/tmp/second.sql"]);
  mocks.previewSqlFile.mockImplementation(async (filePath: string) => ({
    fileName: filePath.split("/").pop()!,
    filePath,
    sizeBytes: 9,
    preview: "select 1;",
    canExecuteWithoutSelectedDatabase: true,
  }));
  mocks.listenSqlFileProgress.mockImplementation((handler: (event: Record<string, unknown>) => void) => {
    mocks.progressHandler = handler;
    return mocks.unlisten;
  });
  mocks.cancelSqlFileExecution.mockResolvedValue(true);
  mocks.refreshDatabaseTreeNode.mockResolvedValue(undefined);
  mocks.requestConfirmation.mockResolvedValue(true);
  mocks.uuid.mockReset().mockReturnValueOnce("run-1").mockReturnValueOnce("run-2");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
});

describe("SqlFileExecutionDialog retries", () => {
  async function mountRestoredPreview() {
    mocks.desktop = false;
    const preview = {
      fileName: "backup.sql",
      filePath: "/server/tmp/sql_file/restore-token/backup.sql",
      preview: "SELECT 42;",
      sizeBytes: 10,
      canExecuteWithoutSelectedDatabase: true,
      cleanupToken: "restore-token",
    };
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SqlFileExecutionDialog, { open: true, prefillPreview: preview });
    app.mount(root);
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    expect(root.textContent).toContain("SELECT 42;");
    expect(mocks.previewSqlFile).not.toHaveBeenCalled();
    expect(mocks.previewWebSqlFile).not.toHaveBeenCalled();
    return preview;
  }

  it("renders a prepared Web preview without uploading a server path and releases it on unmount", async () => {
    await mountRestoredPreview();
    app!.unmount();
    app = undefined;
    await vi.waitFor(() => expect(mocks.releaseSqlFilePreview).toHaveBeenCalledWith("restore-token"));
  });

  it.each(["done", "error", "cancelled"])("executes the prepared server object and releases it after %s", async (status) => {
    const preview = await mountRestoredPreview();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      expect(mocks.releaseSqlFilePreview).not.toHaveBeenCalled();
      mocks.progressHandler?.(progress(request.executionId, status, status === "error" ? { error: "restore failed" } : {}));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledWith(expect.objectContaining({ filePath: preview.filePath }), [preview.filePath]));
    await vi.waitFor(() => expect(mocks.releaseSqlFilePreview).toHaveBeenCalledWith("restore-token"));
    expect(mocks.previewWebSqlFile).not.toHaveBeenCalled();
  });

  it("keeps browser uploads on the File-only preview path", async () => {
    await mountRestoredPreview();
    const file = new File(["SELECT 2;"], "upload.sql", { type: "text/plain" });
    mocks.previewWebSqlFile.mockResolvedValueOnce({ fileName: file.name, filePath: "/server/tmp/sql_file/upload.sql", sizeBytes: file.size, preview: "SELECT 2;", canExecuteWithoutSelectedDatabase: true });
    const input = root!.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.previewWebSqlFile).toHaveBeenCalledWith(file));
    expect(mocks.releaseSqlFilePreview).toHaveBeenCalledWith("restore-token");
  });

  it("reuses the unchanged preview across progress and failure updates while keeping controls responsive", async () => {
    const onOpenChange = vi.fn();
    await mountReadyDialog(onOpenChange);
    const gate = deferred();
    mocks.executeSqlFiles.mockImplementationOnce(() => gate.promise);
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledOnce());
    mocks.highlight.mockClear();

    try {
      for (let statementIndex = 1; statementIndex <= 100; statementIndex += 1) {
        mocks.progressHandler?.(progress("run-1", "statementDone", { statementIndex, successCount: statementIndex, bytesRead: statementIndex, totalBytes: 200 }));
        await nextTick();
      }
      mocks.progressHandler?.(progress("run-1", "statementFailed", { statementIndex: 101, failureCount: 1, error: "statement rejected", statementSummary: "insert into missing_table values (1)" }));
      await nextTick();

      expect(mocks.highlight).not.toHaveBeenCalled();
      expect(root!.textContent).toContain("statement rejected");
      findButton("sqlFile.runInBackground").click();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(mocks.cancelSqlFileExecution).not.toHaveBeenCalled();
      findButton("sqlFile.cancel").click();
      await vi.waitFor(() => expect(mocks.cancelSqlFileExecution).toHaveBeenCalledWith("run-1"));
    } finally {
      mocks.progressHandler?.(progress("run-1", "cancelled"));
      gate.resolve();
    }
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
  });

  it("refreshes the preview after highlighter initialization and appearance changes", async () => {
    await mountReadyDialog();
    mocks.highlight.mockClear();
    expect(root!.querySelector("pre")!.textContent).toBe("select 1;");

    mocks.highlighterState!.ready = true;
    await nextTick();
    expect(mocks.highlight).toHaveBeenCalledOnce();
    expect(root!.querySelector("pre span")!.getAttribute("data-theme")).toBe("light");

    mocks.highlighterState!.appearance = "dark";
    await nextTick();
    expect(mocks.highlight).toHaveBeenCalledTimes(2);
    expect(root!.querySelector("pre span")!.getAttribute("data-theme")).toBe("dark");
    expect(root!.querySelector("pre")!.textContent).toBe("select 1;");
  });

  it("refreshes the preview when switching files and reloading the same path", async () => {
    mocks.previewSqlFile.mockImplementation(async (filePath: string) => ({ filePath, fileName: filePath.split("/").pop()!, sizeBytes: 9, preview: filePath.endsWith("first.sql") ? "select 1;" : "select 2;", canExecuteWithoutSelectedDatabase: true }));
    await mountReadyDialog();
    mocks.highlight.mockClear();

    findButton("second.sql").click();
    await nextTick();
    expect(mocks.highlight).toHaveBeenCalledOnce();
    expect(root!.querySelector("pre")!.textContent).toBe("select 2;");

    mocks.openFileDialog.mockResolvedValueOnce(["/tmp/second.sql"]);
    mocks.previewSqlFile.mockResolvedValueOnce({ filePath: "/tmp/second.sql", fileName: "second.sql", sizeBytes: 9, preview: "select 3;", canExecuteWithoutSelectedDatabase: true });
    findButton("sqlFile.browse").click();
    await vi.waitFor(() => expect(root!.querySelector("pre")!.textContent).toBe("select 3;"));
    expect(mocks.highlight).toHaveBeenLastCalledWith("select 3;");
  });

  it("allows an ordinary execution to continue in the background and close after completion", async () => {
    const onOpenChange = vi.fn();
    await mountReadyDialog(onOpenChange);
    const gate = deferred();
    mocks.executeSqlFiles.mockImplementationOnce(() => gate.promise);
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledOnce());
    findButton("sqlFile.runInBackground").click();
    await nextTick();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.cancelSqlFileExecution).not.toHaveBeenCalled();
    mocks.progressHandler?.(progress("run-1", "done"));
    gate.resolve();
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    onOpenChange.mockClear();
    findButton("common.close").click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels the active ordinary run and allows a fresh retry", async () => {
    await mountReadyDialog();
    const gate = deferred();
    mocks.executeSqlFiles.mockImplementationOnce(() => gate.promise);
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledOnce());
    findButton("sqlFile.cancel").click();
    await vi.waitFor(() => expect(mocks.cancelSqlFileExecution).toHaveBeenCalledWith("run-1"));
    mocks.progressHandler?.(progress("run-1", "cancelled"));
    gate.resolve();
    await vi.waitFor(() => expect(root!.textContent).toContain("sqlFile.status.cancelled"));
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    mocks.executeSqlFiles.mockImplementationOnce(async (request) => mocks.progressHandler?.(progress(request.executionId, "done")));
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledTimes(2));
    expect(mocks.executeSqlFiles.mock.calls[1]![0].executionId).toBe("run-2");
    await vi.waitFor(() => expect(root!.textContent).toContain("sqlFile.status.done"));
  });

  async function enableManualTransaction() {
    await mountReadyDialog();
    const label = Array.from(root!.querySelectorAll("label")).find((item) => item.textContent?.includes("toolbar.manualTransaction"));
    expect(label).toBeDefined();
    label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await nextTick();
  }

  it("keeps successful files pending until an explicit commit and locks file selection", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(false));
    expect(mocks.beginManualTransaction).toHaveBeenCalledWith("mysql-1", "");
    expect(mocks.executeSqlFiles.mock.calls[0]![0]).toMatchObject({ txnSessionId: "txn-1", continueOnError: false, skipRelationalConstraints: false });
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    expect(mocks.refreshDatabaseTreeNode).not.toHaveBeenCalled();
    expect(findButton("sqlFile.browse").disabled).toBe(true);
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "running", statementSummary: "sqlFile.pendingTransaction" }), expect.anything());
    findButton("toolbar.commit").click();
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    expect(mocks.commitManualTransaction).toHaveBeenCalledExactlyOnceWith("txn-1");
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "done" }));
  });

  it("rolls back pending files without marking their task committed", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.rollback").disabled).toBe(false));
    const buttons = root!.querySelectorAll("button");
    expect(buttons[buttons.length - 1]).toBe(findButton("toolbar.rollback"));
    findButton("toolbar.rollback").click();
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledExactlyOnceWith("txn-1");
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "cancelled" }));
  });

  it("rolls back on execution failure without retrying the file", async () => {
    await enableManualTransaction();
    mocks.executeSqlFiles.mockRejectedValueOnce(new Error("statement failed"));
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-1"));
    expect(mocks.executeSqlFiles).toHaveBeenCalledTimes(1);
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("statement failed", 5000);
  });

  it("waits for the active statement to finish before rolling back a cancellation", async () => {
    await enableManualTransaction();
    const gate = deferred();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      await gate.promise;
      mocks.progressHandler?.(progress(request.executionId, "cancelled"));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalled());
    findButton("sqlFile.cancel").click();
    await vi.waitFor(() => expect(mocks.cancelSqlFileExecution).toHaveBeenCalledWith("run-1"));
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-1"));
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
  });

  it("releases a transaction that begins after the dialog unmounts", async () => {
    await enableManualTransaction();
    const gate = deferred();
    mocks.beginManualTransaction.mockImplementationOnce(async () => {
      await gate.promise;
      return "late-txn";
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.beginManualTransaction).toHaveBeenCalled());
    app!.unmount();
    app = undefined;
    gate.resolve();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("late-txn"));
    expect(mocks.executeSqlFiles).not.toHaveBeenCalled();
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "cancelled" }));
  });

  it("rolls back before closing pending files and keeps them open when close is declined", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(false));
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    mocks.changeDialogOpen!(false);
    await nextTick();
    expect(confirm).toHaveBeenCalledWith("sqlFile.rollbackBeforeClose");
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    mocks.changeDialogOpen!(false);
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledExactlyOnceWith("txn-1"));
  });

  it("does not start file execution if cancelled while registering progress", async () => {
    await enableManualTransaction();
    const gate = deferred();
    mocks.listenSqlFileProgress.mockImplementationOnce(async () => {
      await gate.promise;
      return mocks.unlisten;
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.listenSqlFileProgress).toHaveBeenCalled());
    findButton("sqlFile.cancel").click();
    gate.resolve();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-1"));
    expect(mocks.executeSqlFiles).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalled();
  });

  it("does not allow committing a failed file when cleanup could not be confirmed", async () => {
    await enableManualTransaction();
    mocks.executeSqlFiles.mockRejectedValueOnce(new Error("file failed"));
    mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("rollback connection lost"));
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(findButton("toolbar.rollback").disabled).toBe(false));
    expect(findButton("toolbar.commit").disabled).toBe(true);
    expect(findButton("sqlFile.browse").disabled).toBe(true);
    findButton("toolbar.rollback").click();
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
  });

  it("retains pending controls when commit fails, allowing rollback", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(false));
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("connection lost"));
    findButton("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("connection lost", 5000));
    expect(findButton("sqlFile.browse").disabled).toBe(true);
    expect(findButton("toolbar.rollback").disabled).toBe(false);
    expect(findButton("toolbar.commit").disabled).toBe(true);
    findButton("toolbar.rollback").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-1"));
  });

  it("reports an expired transaction instead of claiming commit succeeded", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(false));
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
    findButton("toolbar.commit").click();
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    expect(mocks.toast).toHaveBeenCalledWith("sqlFile.transactionEnded", 5000);
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "cancelled" }));
  });

  it("reports an unknown commit outcome when the response was lost and rollback finds no session", async () => {
    await enableManualTransaction();
    await completeFirstExecution();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(false));
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("response lost"));
    findButton("toolbar.commit").click();
    await vi.waitFor(() => expect(findButton("toolbar.commit").disabled).toBe(true));
    await vi.waitFor(() => expect(findButton("toolbar.rollback").disabled).toBe(false));
    mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
    findButton("toolbar.rollback").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("toolbar.commitOutcomeUnknown", 5000));
    expect(mocks.updateSqlFileTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "error" }));
    expect(mocks.commitManualTransaction).toHaveBeenCalledTimes(1);
  });

  it("shows byte-based progress while SQL executes and only completes on a terminal event", async () => {
    await mountReadyDialog();
    const executionGate = deferred();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      mocks.progressHandler?.(progress(request.executionId, "running", { statementIndex: 500, successCount: 499, bytesRead: 1024, totalBytes: 4096, phase: "executing" }));
      await executionGate.promise;
      mocks.progressHandler?.(progress(request.executionId, "done", { bytesRead: 4096, totalBytes: 4096 }));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(root!.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25"));
    expect(root!.textContent).toContain("sqlFile.progressPhase.executing");
    executionGate.resolve();
    await vi.waitFor(() => expect(root!.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100"));
  });

  it("does not auto-select the first connection for an unassociated external file", async () => {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SqlFileExecutionDialog, { open: true, prefillFilePath: "/tmp/unassociated.sql" });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.previewSqlFile).toHaveBeenCalledWith("/tmp/unassociated.sql"));
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.fetchSqlFileTargetOptions).not.toHaveBeenCalled();
    expect(findButton("sqlFile.execute").disabled).toBe(true);
  });

  it("does not restore a completed run's file summary after an early retry failure", async () => {
    await mountReadyDialog();
    await completeFirstExecution();

    mocks.ensureConnected.mockRejectedValueOnce(new Error("retry connection failed"));
    findButton("sqlFile.execute").click();

    await vi.waitFor(() => expect(root!.textContent).toContain("retry connection failed"));
    expect(root!.querySelector("table")).toBeNull();
  });

  it("does not restore a completed run's file summary after an early retry cancellation", async () => {
    await mountReadyDialog();
    await completeFirstExecution();
    const connectionGate = deferred();
    mocks.ensureConnected.mockImplementationOnce(() => connectionGate.promise);

    findButton("sqlFile.execute").click();
    await nextTick();
    findButton("sqlFile.cancel").click();
    connectionGate.resolve();

    await vi.waitFor(() => expect(root!.textContent).toContain("sqlFile.status.cancelled"));
    expect(root!.querySelector("table")).toBeNull();
    expect(mocks.executeSqlFiles).toHaveBeenCalledTimes(1);
  });

  it("shows every statement failure in order after continue-on-error completion", async () => {
    await mountReadyDialog();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      mocks.progressHandler?.(progress(request.executionId, "statementFailed", { statementIndex: 1, failureCount: 1, statementSummary: "INSERT bad_one", error: "unknown column one" }));
      mocks.progressHandler?.(progress(request.executionId, "statementFailed", { statementIndex: 2, failureCount: 2, statementSummary: "INSERT bad_two", error: "unknown column two" }));
      mocks.progressHandler?.(progress(request.executionId, "statementFailed", { statementIndex: 3, failureCount: 3, statementSummary: "INSERT bad_three", error: "syntax error three" }));
      mocks.progressHandler?.(progress(request.executionId, "done", { statementIndex: 4, successCount: 1, failureCount: 3 }));
    });

    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(root!.textContent).toContain("syntax error three"));

    const text = root!.textContent ?? "";
    expect(text).toContain("unknown column one");
    expect(text).toContain("unknown column two");
    expect(text.indexOf("INSERT bad_one")).toBeLessThan(text.indexOf("INSERT bad_two"));
    expect(text.indexOf("INSERT bad_two")).toBeLessThan(text.indexOf("INSERT bad_three"));
  });

  it("shows the first statement failure when stop-on-error becomes terminal", async () => {
    await mountReadyDialog();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      mocks.progressHandler?.(progress(request.executionId, "statementFailed", { statementIndex: 1, failureCount: 1, statementSummary: "INSERT stop_here", error: "stop-on-error failure" }));
      mocks.progressHandler?.(progress(request.executionId, "error", { statementIndex: 1, failureCount: 1, statementSummary: "INSERT stop_here", error: "stop-on-error failure" }));
    });

    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(root!.textContent).toContain("stop-on-error failure"));

    expect(root!.textContent?.match(/stop-on-error failure/g)).toHaveLength(1);
    expect(root!.textContent).toContain("INSERT stop_here");
  });

  it("clears statement failure details before an early retry failure", async () => {
    await mountReadyDialog();
    mocks.executeSqlFiles.mockImplementationOnce(async (request: { executionId: string }) => {
      mocks.progressHandler?.(progress(request.executionId, "statementFailed", { statementIndex: 1, failureCount: 1, statementSummary: "INSERT stale", error: "stale statement failure" }));
      mocks.progressHandler?.(progress(request.executionId, "done", { statementIndex: 2, successCount: 1, failureCount: 1 }));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(root!.textContent).toContain("stale statement failure"));

    mocks.ensureConnected.mockRejectedValueOnce(new Error("retry connection failed"));
    findButton("sqlFile.execute").click();

    await vi.waitFor(() => expect(root!.textContent).toContain("retry connection failed"));
    expect(root!.textContent).not.toContain("stale statement failure");
  });
});

describe("SqlFileExecutionDialog selected-table restore", () => {
  async function mountBackup() {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SqlFileExecutionDialog, { open: true, prefillConnectionId: "mysql-1", prefillDatabase: "app", prefillFilePath: "/tmp/backup.sql.gz" });
    app.mount(root);
    await vi.waitFor(() => expect(findButton("sqlFile.execute").disabled).toBe(false));
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click();
    await nextTick();
  }

  it("scans the backup and sends only checked table identities", async () => {
    await mountBackup();
    await vi.waitFor(() => expect(root!.textContent).toContain("archive.users"));
    expect(mocks.inspectSqlFileTables).toHaveBeenCalledWith("/tmp/backup.sql.gz");
    expect(findButton("sqlFile.execute").disabled).toBe(true);
    const label = Array.from(root!.querySelectorAll("label")).find((label) => label.textContent === "app.users")!;
    label.querySelector<HTMLInputElement>("input")!.click();
    await nextTick();
    mocks.executeSqlFiles.mockImplementationOnce(async (request) => {
      mocks.progressHandler?.(progress(request.executionId, "done", { successCount: 2 }));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalledWith(expect.objectContaining({ selectedTables: [{ database: "app", name: "users" }] }), ["/tmp/backup.sql.gz"]));
  });

  it("selects only search matches and preserves selections outside the search", async () => {
    await mountBackup();
    await vi.waitFor(() => expect(root!.textContent).toContain("archive.users"));
    const search = root!.querySelector<HTMLInputElement>('[aria-label="sqlFile.searchBackupTables"]')!;
    search.value = "app.";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    root!.querySelector<HTMLInputElement>('[data-table-restore] input[type="checkbox"]')!.click();
    await nextTick();
    search.value = "archive";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(root!.querySelector<HTMLInputElement>('[data-table-restore] input[type="checkbox"]')!.checked).toBe(false);
    mocks.executeSqlFiles.mockImplementationOnce(async (request) => {
      mocks.progressHandler?.(progress(request.executionId, "done"));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() =>
      expect(mocks.executeSqlFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedTables: [
            { database: "app", name: "users" },
            { database: "app", name: "orders" },
          ],
        }),
        expect.any(Array),
      ),
    );
  });

  it("blocks execution on scan failure and allows switching back to full restore", async () => {
    mocks.inspectSqlFileTables.mockRejectedValueOnce(new Error("unsupported dump statement"));
    await mountBackup();
    await vi.waitFor(() => expect(root!.querySelector('[role="alert"]')?.textContent).toContain("unsupported dump statement"));
    expect(findButton("sqlFile.execute").disabled).toBe(true);
    root!.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
    await nextTick();
    expect(findButton("sqlFile.execute").disabled).toBe(false);
  });

  it("ignores a scan result after switching back to all contents", async () => {
    let finish!: (tables: any[]) => void;
    mocks.inspectSqlFileTables.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mountBackup();
    expect(findButton("sqlFile.execute").disabled).toBe(true);
    root!.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
    await nextTick();
    finish([{ database: null, name: "stale" }]);
    await nextTick();
    expect(root!.textContent).not.toContain("stale");
    mocks.executeSqlFiles.mockImplementationOnce(async (request) => {
      mocks.progressHandler?.(progress(request.executionId, "done"));
    });
    findButton("sqlFile.execute").click();
    await vi.waitFor(() => expect(mocks.executeSqlFiles).toHaveBeenCalled());
    expect(mocks.executeSqlFiles.mock.calls[0]![0]).not.toHaveProperty("selectedTables");
  });

  it("loads previews from a pasted file path on Enter", async () => {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SqlFileExecutionDialog, { open: true });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.fetchSqlFileTargetOptions).toHaveBeenCalled());
    mocks.previewSqlFile.mockClear();

    const input = root.querySelector("input:not([type=file])") as HTMLInputElement;
    input.value = ' "/tmp/pasted.sql" ';
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(mocks.previewSqlFile).toHaveBeenCalledWith("/tmp/pasted.sql"));
    expect(mocks.previewSqlFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the typed path when the pasted file cannot be loaded", async () => {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(SqlFileExecutionDialog, { open: true });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.fetchSqlFileTargetOptions).toHaveBeenCalled());
    mocks.previewSqlFile.mockReset();
    mocks.previewSqlFile.mockRejectedValueOnce(new Error("no such file"));

    const input = root.querySelector("input:not([type=file])") as HTMLInputElement;
    input.value = "/tmp/missing.sql";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("no such file", 5000));
    await nextTick();
    expect(input.value).toBe("/tmp/missing.sql");
  });
});
