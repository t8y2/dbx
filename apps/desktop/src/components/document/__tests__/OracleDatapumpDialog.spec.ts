// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { startOracleDatapump: vi.fn(), cancelOracleDatapump: vi.fn(), listOracleDatapumpDirectories: vi.fn(), createOracleDatapumpDirectory: vi.fn(), dropOracleDatapumpDirectory: vi.fn() },
  store: { getConfig: vi.fn(), ensureConnected: vi.fn() },
  guard: vi.fn(),
  readOnly: vi.fn(() => false),
}));
vi.mock("@/lib/backend/api", () => mocks.api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: mocks.guard }));
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ connectionIsEffectivelyReadOnly: mocks.readOnly }));
vi.mock("@/lib/common/utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/common/utils")>()), uuid: () => "task-1" }));
import { useOracleDatapumpTask } from "@/composables/useOracleDatapumpTask";
import OracleDatapumpDialog from "../OracleDatapumpDialog.vue";

const done = { taskId: "task-1", status: "Done" as const, state: "succeeded", jobState: "COMPLETED", percent: 100, errorCount: 0, elapsedMs: 1200, error: null };
const directories = [
  { name: "DATA_PUMP_DIR", path: "/u01/app/oracle/admin/dpdump" },
  { name: "DUMP_DIR", path: "/u01/dumps" },
];
let app: App | null;
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function button(key: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === key);
  if (!element) throw new Error(`Missing button ${key}`);
  return element;
}
function setInputByLabel(labelKey: string, value: string) {
  const label = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.trim() === labelKey);
  const input = label?.parentElement?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`Missing input for ${labelKey}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function dumpfileInput(): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.trim() === "oracleDatapump.outputFile");
  const input = label?.parentElement?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing dumpfile input");
  return input;
}
async function mount(mode: "export" | "import") {
  app = createApp(OracleDatapumpDialog, { open: true, connectionId: "c1", database: "APP", mode });
  app.mount(document.body);
  await flush();
}

describe("OracleDatapumpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.getConfig.mockReturnValue({ name: "Oracle", read_only: false });
    mocks.store.ensureConnected.mockResolvedValue(undefined);
    mocks.api.listOracleDatapumpDirectories.mockResolvedValue(directories);
    mocks.api.startOracleDatapump.mockResolvedValue(done);
    mocks.api.cancelOracleDatapump.mockResolvedValue(undefined);
    mocks.api.createOracleDatapumpDirectory.mockResolvedValue(undefined);
    mocks.api.dropOracleDatapumpDirectory.mockResolvedValue(undefined);
    useOracleDatapumpTask().reset();
    mocks.guard.mockImplementation(async ({ execute }: { execute: () => Promise<boolean> }) => execute());
    mocks.readOnly.mockReturnValue(false);
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  it("loads directories on open and defaults to DATA_PUMP_DIR", async () => {
    await mount("export");
    expect(mocks.api.listOracleDatapumpDirectories).toHaveBeenCalledWith("c1", "APP");
    expect(document.body.textContent).toContain("/u01/app/oracle/admin/dpdump");
    expect(button("oracleDatapump.startExport").disabled).toBe(false);
  });

  it("exports the selected schema without the production guard", async () => {
    await mount("export");
    setInputByLabel("oracleDatapump.outputFile", "app.dmp");
    await flush();
    button("oracleDatapump.startExport").click();
    await flush();
    expect(mocks.api.startOracleDatapump).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        connectionId: "c1",
        kind: "export",
        mode: "schema",
        directory: "DATA_PUMP_DIR",
        dumpfile: "app.dmp",
        schemas: ["APP"],
        tables: [],
        remapSchemaFrom: null,
        tableExistsAction: null,
        compression: false,
      }),
      expect.any(Function),
    );
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("falls back to manual directory input when the agent cannot list directories", async () => {
    mocks.api.listOracleDatapumpDirectories.mockRejectedValue(new Error("agent too old"));
    await mount("export");
    const dirInput = document.querySelector<HTMLInputElement>('input[placeholder="oracleDatapump.directoryPlaceholder"]');
    if (!dirInput) throw new Error("Missing manual directory input");
    dirInput.value = "MY_DUMP_DIR";
    dirInput.dispatchEvent(new Event("input", { bubbles: true }));
    setInputByLabel("oracleDatapump.outputFile", "app.dmp");
    await flush();
    expect(document.body.textContent).toContain("oracleDatapump.directoryListFailed");
    button("oracleDatapump.startExport").click();
    await flush();
    expect(mocks.api.startOracleDatapump).toHaveBeenCalledWith(expect.objectContaining({ directory: "MY_DUMP_DIR" }), expect.any(Function));
  });

  it("imports with remap and the default table-exists action after the production guard", async () => {
    await mount("import");
    setInputByLabel("oracleDatapump.inputFile", "app.dmp");
    setInputByLabel("oracleDatapump.schemas", "SRC");
    setInputByLabel("oracleDatapump.remapTo", "DST");
    await flush();
    button("oracleDatapump.startImport").click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "DST", reviewText: expect.stringContaining("DATA_PUMP_DIR:app.dmp") }));
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ reviewText: expect.stringContaining("REMAP_SCHEMA=SRC:DST TABLE_EXISTS_ACTION=SKIP") }));
    expect(mocks.api.startOracleDatapump).toHaveBeenCalledWith(expect.objectContaining({ kind: "import", remapSchemaFrom: "SRC", remapSchemaTo: "DST", tableExistsAction: "SKIP", compression: false }), expect.any(Function));
  });

  it("does not import when the production guard declines", async () => {
    mocks.guard.mockResolvedValueOnce(false);
    await mount("import");
    setInputByLabel("oracleDatapump.inputFile", "app.dmp");
    setInputByLabel("oracleDatapump.schemas", "SRC");
    await flush();
    button("oracleDatapump.startImport").click();
    await flush();
    expect(mocks.api.startOracleDatapump).not.toHaveBeenCalled();
    expect(button("oracleDatapump.startImport").disabled).toBe(false);
  });

  it("disables start until a dump file name is provided", async () => {
    await mount("export");
    dumpfileInput().value = "";
    dumpfileInput().dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(button("oracleDatapump.startExport").disabled).toBe(true);
  });

  it("disables start for read-only connections in import mode", async () => {
    mocks.readOnly.mockReturnValue(true);
    await mount("import");
    setInputByLabel("oracleDatapump.inputFile", "app.dmp");
    await flush();
    expect(button("oracleDatapump.startImport").disabled).toBe(true);
    expect(document.body.textContent).toContain("oracleDatapump.readonly");
  });

  it("creates a directory through the manage panel and reloads the list", async () => {
    await mount("export");
    button("oracleDatapump.manage").click();
    await flush();
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="oracleDatapump.newNamePlaceholder"]');
    const pathInput = document.querySelector<HTMLInputElement>('input[placeholder="oracleDatapump.newPathPlaceholder"]');
    if (!nameInput || !pathInput) throw new Error("Missing manage inputs");
    nameInput.value = "MY_DUMP_DIR";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    pathInput.value = "/backup/dumps";
    pathInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    button("oracleDatapump.createButton").click();
    await flush();
    expect(mocks.api.createOracleDatapumpDirectory).toHaveBeenCalledWith("c1", "APP", "MY_DUMP_DIR", "/backup/dumps");
    expect(mocks.api.listOracleDatapumpDirectories).toHaveBeenCalledTimes(2);
  });

  it("drops a directory after confirmation and the production guard", async () => {
    const confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy as unknown as typeof window.confirm;
    await mount("export");
    button("oracleDatapump.manage").click();
    await flush();
    const dropButton = document.querySelector<HTMLButtonElement>('button[title="oracleDatapump.deleteButton"]');
    if (!dropButton) throw new Error("Missing drop button");
    dropButton.click();
    await flush();
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ reviewText: "DROP DIRECTORY DATA_PUMP_DIR" }));
    expect(mocks.api.dropOracleDatapumpDirectory).toHaveBeenCalledWith("c1", "APP", "DATA_PUMP_DIR");
    delete (window as { confirm?: unknown }).confirm;
  });

  it("hides the dialog when minimized while running (task continues in background)", async () => {
    let resolveStart!: (value: typeof done) => void;
    mocks.api.startOracleDatapump.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await mount("export");
    setInputByLabel("oracleDatapump.outputFile", "app.dmp");
    await flush();
    button("oracleDatapump.startExport").click();
    await flush();
    const minimize = document.querySelector<HTMLButtonElement>('button[aria-label="oracleDatapump.minimize"]');
    if (!minimize) throw new Error("Missing minimize button while running");
    minimize.click();
    await flush();
    // 弹窗关闭但任务在后端继续（药丸由独立组件渲染，不在此 spec 范围）
    resolveStart({ ...done, status: "Cancelled", state: "cancelled" });
    await flush();
  });

  it("cancels a running task through the backend", async () => {
    let resolveStart!: (value: typeof done) => void;
    mocks.api.startOracleDatapump.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await mount("export");
    setInputByLabel("oracleDatapump.outputFile", "app.dmp");
    await flush();
    button("oracleDatapump.startExport").click();
    await flush();
    button("oracleDatapump.cancel").click();
    await flush();
    expect(mocks.api.cancelOracleDatapump).toHaveBeenCalledWith("task-1");
    resolveStart({ ...done, status: "Cancelled", state: "cancelled" });
    await flush();
    expect(document.body.textContent).toContain("oracleDatapump.cancelled");
  });
});
