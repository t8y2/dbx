// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSqlFileTask: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  ensureConnected: vi.fn(),
  executeSqlFiles: vi.fn(),
  fetchSqlFileTargetOptions: vi.fn(),
  listenSqlFileProgress: vi.fn(),
  openFileDialog: vi.fn(),
  previewSqlFile: vi.fn(),
  progressHandler: undefined as undefined | ((progress: Record<string, unknown>) => void),
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
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openFileDialog }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({ addSqlFileTask: mocks.addSqlFileTask, updateSqlFileTask: mocks.updateSqlFileTask }),
}));
vi.mock("@/composables/useDatabaseOptions", () => ({ fetchSqlFileTargetOptions: mocks.fetchSqlFileTargetOptions }));
vi.mock("@/lib/connection/connectionLevelDatabaseBootstrap", () => ({ requiresSqlFileTargetDatabaseSelection: () => false }));
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
  cancelSqlFileExecution: mocks.cancelSqlFileExecution,
  executeSqlFiles: mocks.executeSqlFiles,
  listenSqlFileProgress: mocks.listenSqlFileProgress,
  previewSqlFile: mocks.previewSqlFile,
}));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return { Check: Icon, CheckSquare: Icon, ChevronRight: Icon, FileCode: Icon, FolderOpen: Icon, Loader2: Icon, Play: Icon, Square: Icon, X: Icon };
});
vi.mock("@/components/ui/dialog", () => ({
  Dialog: passthrough("div"),
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
vi.mock("@/components/ui/input", () => ({ Input: passthrough("input") }));
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

async function mountReadyDialog() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(SqlFileExecutionDialog, { open: true });
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
  mocks.progressHandler = undefined;
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
  mocks.ensureConnected.mockResolvedValue(undefined);
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
  mocks.uuid.mockReturnValueOnce("run-1").mockReturnValueOnce("run-2");
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
});

describe("SqlFileExecutionDialog retries", () => {
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
