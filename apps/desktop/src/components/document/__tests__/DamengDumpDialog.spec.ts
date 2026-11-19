// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { startDamengDump: vi.fn(), cancelDamengDump: vi.fn(), resolveDamengDumpTool: vi.fn() },
  store: { getConfig: vi.fn(), ensureConnected: vi.fn() },
  settings: { editorSettings: { damengClientBinDir: "/opt/dm8/bin" } },
  guard: vi.fn(),
  readOnly: vi.fn(() => false),
}));
vi.mock("@/lib/backend/api", () => mocks.api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: mocks.guard }));
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ connectionIsEffectivelyReadOnly: mocks.readOnly }));
vi.mock("@/lib/common/utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/common/utils")>()), uuid: () => "task-1" }));
import DamengDumpDialog from "../DamengDumpDialog.vue";

const done = { taskId: "task-1", status: "done" as const, success: true, warnings: false, elapsedSeconds: "1.2s", error: null };
let app: App | null;
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function button(key: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === key);
  if (!button) throw new Error(`Missing button ${key}`);
  return button;
}
function filePathInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="damengDump.filePlaceholder"]');
  if (!input) throw new Error("Missing file path input");
  return input;
}
function setFilePath(path: string) {
  const input = filePathInput();
  input.value = path;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function setInputByLabel(labelKey: string, value: string) {
  const label = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.trim() === labelKey);
  const input = label?.parentElement?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`Missing input for ${labelKey}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function mount(mode: "export" | "import") {
  app = createApp(DamengDumpDialog, { open: true, connectionId: "c1", database: "APP", mode });
  app.mount(document.body);
  await flush();
}

describe("DamengDumpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.getConfig.mockReturnValue({ name: "Dameng", read_only: false });
    mocks.store.ensureConnected.mockResolvedValue(undefined);
    mocks.settings.editorSettings.damengClientBinDir = "/opt/dm8/bin";
    mocks.api.resolveDamengDumpTool.mockResolvedValue("/opt/dm8/bin/dexp");
    mocks.api.startDamengDump.mockResolvedValue(done);
    mocks.api.cancelDamengDump.mockResolvedValue(undefined);
    mocks.guard.mockImplementation(async ({ execute }: { execute: () => Promise<boolean> }) => execute());
    mocks.readOnly.mockReturnValue(false);
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  it("exports the selected schema to the chosen .dmp path without the production guard", async () => {
    await mount("export");
    setFilePath("C:/backups/app.dmp");
    await flush();
    button("damengDump.startExport").click();
    await flush();
    expect(mocks.api.resolveDamengDumpTool).toHaveBeenCalledWith("/opt/dm8/bin", "export");
    expect(mocks.api.startDamengDump).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", connectionId: "c1", kind: "export", toolPath: "/opt/dm8/bin/dexp", filePath: "C:/backups/app.dmp", schemas: ["APP"], tables: [], remapSchema: null, tableExistsAction: null }),
      expect.any(Function),
    );
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("parses comma-separated tables and keeps them out of the schema list", async () => {
    await mount("export");
    setFilePath("C:/backups/tables.dmp");
    setInputByLabel("damengDump.tables", "EMP, DEPT");
    await flush();
    button("damengDump.startExport").click();
    await flush();
    expect(mocks.api.startDamengDump).toHaveBeenCalledWith(expect.objectContaining({ schemas: ["APP"], tables: ["EMP", "DEPT"] }), expect.any(Function));
  });

  it("imports with remap and the default table-exists action after the production guard", async () => {
    mocks.api.resolveDamengDumpTool.mockResolvedValue("/opt/dm8/bin/dimp");
    await mount("import");
    setFilePath("C:/backups/app.dmp");
    setInputByLabel("damengDump.remapFrom", "SRC");
    setInputByLabel("damengDump.remapTo", "DST");
    await flush();
    button("damengDump.startImport").click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "DST", reviewText: expect.stringContaining("REMAP_SCHEMA=SRC:DST TABLE_EXISTS_ACTION=SKIP") }));
    expect(mocks.api.resolveDamengDumpTool).toHaveBeenCalledWith("/opt/dm8/bin", "import");
    expect(mocks.api.startDamengDump).toHaveBeenCalledWith(expect.objectContaining({ kind: "import", toolPath: "/opt/dm8/bin/dimp", remapSchema: ["SRC", "DST"], tableExistsAction: "SKIP", tables: [] }), expect.any(Function));
  });

  it("does not import when the production guard declines", async () => {
    mocks.guard.mockResolvedValueOnce(false);
    await mount("import");
    setFilePath("C:/backups/app.dmp");
    await flush();
    button("damengDump.startImport").click();
    await flush();
    expect(mocks.api.startDamengDump).not.toHaveBeenCalled();
    expect(button("damengDump.startImport").disabled).toBe(false);
  });

  it("disables start while the client bin directory is missing", async () => {
    mocks.settings.editorSettings.damengClientBinDir = "";
    await mount("export");
    setFilePath("C:/backups/app.dmp");
    await flush();
    expect(button("damengDump.startExport").disabled).toBe(true);
    expect(document.body.textContent).toContain("damengDump.binDirMissing");
  });

  it("disables start for read-only connections in import mode", async () => {
    mocks.readOnly.mockReturnValue(true);
    await mount("import");
    setFilePath("C:/backups/app.dmp");
    await flush();
    expect(button("damengDump.startImport").disabled).toBe(true);
    expect(document.body.textContent).toContain("damengDump.readonly");
  });

  it("cancels a running task through the backend", async () => {
    let resolveStart!: (value: typeof done) => void;
    mocks.api.startDamengDump.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await mount("export");
    setFilePath("C:/backups/app.dmp");
    await flush();
    button("damengDump.startExport").click();
    await flush();
    button("damengDump.cancel").click();
    await flush();
    expect(mocks.api.cancelDamengDump).toHaveBeenCalledWith("task-1");
    resolveStart({ ...done, status: "cancelled" });
    await flush();
    expect(document.body.textContent).toContain("damengDump.cancelled");
  });
});
