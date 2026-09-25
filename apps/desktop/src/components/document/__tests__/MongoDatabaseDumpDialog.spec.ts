// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { inspectMongodbDatabaseDump: vi.fn(), prepareMongodbRestoreSource: vi.fn(), releaseMongodbRestoreSource: vi.fn(), dumpMongodbDatabase: vi.fn(), restoreMongodbDatabase: vi.fn(), cancelMongodbDatabaseDump: vi.fn() },
  store: { getConfig: vi.fn(), ensureConnected: vi.fn(), loadMongoDatabases: vi.fn(), loadMongoCollections: vi.fn(), mongoImportCompleted: null },
  guard: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => mocks.api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: mocks.guard }));
import MongoDatabaseDumpDialog from "../MongoDatabaseDumpDialog.vue";

const catalog = {
  databases: ["source"],
  collections: [
    { database: "source", name: "records", kind: "collection", documents: 2, sizeBytes: 30, indexes: 2 },
    { database: "source", name: "empty", kind: "collection", documents: 0, sizeBytes: 0, indexes: 0 },
  ],
};
const done = { taskId: "task", status: "done", phase: "done", collection: "records", collectionsDone: 2, collectionsTotal: 2, documentsRead: 2, documentsWritten: 2, documentsFailed: 0, indexesCreated: 2, elapsedMs: 10, errorMessage: null, filePath: null };
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
function checkbox(key: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.trim() === key);
  const checkbox = label?.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (!checkbox) throw new Error(`Missing checkbox ${key}`);
  return checkbox;
}
async function mount(mode: "dump" | "restore") {
  app = createApp(MongoDatabaseDumpDialog, { open: true, connectionId: "c1", database: "target", mode });
  app.mount(document.body);
  await flush();
}
async function filesSelected(files: File[]) {
  const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
  await flush();
}
async function formatSelected(value: string) {
  document.querySelector<HTMLElement>("[role=combobox]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(10);
  await flush();
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role=option]")).find((option) => option.textContent?.trim() === value)!;
  option.focus();
  option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(10);
  await flush();
}

describe("MongoDatabaseDumpDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.store.getConfig.mockReturnValue({ name: "MongoDB", read_only: false });
    mocks.store.ensureConnected.mockResolvedValue(undefined);
    mocks.api.inspectMongodbDatabaseDump.mockResolvedValue(catalog);
    mocks.api.prepareMongodbRestoreSource.mockResolvedValue({ ...catalog, sourceRef: "prepared-one" });
    mocks.api.releaseMongodbRestoreSource.mockResolvedValue(true);
    mocks.api.dumpMongodbDatabase.mockResolvedValue(done);
    mocks.api.restoreMongodbDatabase.mockResolvedValue(done);
    mocks.guard.mockImplementation(async ({ execute }) => execute());
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("exports selected collections using the explicit archive and gzip options", async () => {
    await mount("dump");
    checkbox("mongoDump.gzip").click();
    document.querySelector<HTMLInputElement>('input[aria-label="empty"]')!.click();
    await flush();
    button("mongoDump.review").click();
    await flush();
    button("mongoDump.dump").click();
    await flush();
    expect(mocks.api.dumpMongodbDatabase).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c1", database: "target", format: "archive", gzip: true, collections: ["records"], filePath: "target.archive.gz" }), expect.any(Function));
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("restores a directory into the chosen database only after drop confirmation", async () => {
    await mount("restore");
    await formatSelected("mongoDump.directory");
    checkbox("mongoDump.gzip").click();
    await filesSelected([new File([], "records.bson.gz")]);
    button("mongoDump.readSource").click();
    await flush();
    expect(mocks.api.prepareMongodbRestoreSource).toHaveBeenCalledWith(expect.any(Array), "directory", true, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    checkbox("mongoDump.dropExisting").click();
    await flush();
    button("mongoDump.review").click();
    await flush();
    expect(document.body.textContent).toContain("mongoDump.confirmDrop");
    expect(mocks.api.restoreMongodbDatabase).not.toHaveBeenCalled();
    button("mongoDump.restore").click();
    await flush();
    expect(mocks.api.restoreMongodbDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ database: "target", sourceDatabase: "source", sourceRef: "prepared-one", dropExisting: true, restoreOptions: true, restoreIndexes: true, objcheck: false, batchSize: 500 }),
      expect.any(Function),
      expect.objectContaining({ gzip: true }),
    );
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "target", reviewText: expect.stringContaining("DROP selected collections") }));
  });

  it("passes optional objcheck without a separate prevalidation request", async () => {
    await mount("restore");
    expect(checkbox("mongoDump.objcheck").checked).toBe(false);
    await filesSelected([new File([], "backup.archive")]);
    button("mongoDump.readSource").click();
    await flush();
    checkbox("mongoDump.objcheck").click();
    button("mongoDump.review").click();
    await flush();
    button("mongoDump.restore").click();
    await flush();
    expect(mocks.api.restoreMongodbDatabase).toHaveBeenCalledWith(expect.objectContaining({ objcheck: true }), expect.any(Function), undefined);
    expect(mocks.api.prepareMongodbRestoreSource).toHaveBeenCalledTimes(1);
  });

  it("starts only one restore when confirmation is pending and the button is clicked twice", async () => {
    let allow!: (value: boolean) => void;
    mocks.guard.mockReturnValue(
      new Promise<boolean>((resolve) => {
        allow = resolve;
      }),
    );
    await mount("restore");
    await filesSelected([new File([], "backup.archive")]);
    button("mongoDump.readSource").click();
    await flush();
    button("mongoDump.review").click();
    await flush();
    const restore = button("mongoDump.restore");
    restore.click();
    restore.click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledTimes(1);
    expect(button("mongoDump.back").disabled).toBe(true);
    expect(button("mongoDump.close").disabled).toBe(true);
    expect(mocks.api.restoreMongodbDatabase).not.toHaveBeenCalled();
    allow(true);
    await flush();
    expect(mocks.api.restoreMongodbDatabase).toHaveBeenCalledTimes(1);
  });

  it("does not restore if the dialog is unmounted while confirmation is pending", async () => {
    let allow!: (value: boolean) => void;
    mocks.guard.mockReturnValue(
      new Promise<boolean>((resolve) => {
        allow = resolve;
      }),
    );
    await mount("restore");
    await filesSelected([new File([], "backup.archive")]);
    button("mongoDump.readSource").click();
    await flush();
    button("mongoDump.review").click();
    await flush();
    button("mongoDump.restore").click();
    await flush();
    app!.unmount();
    app = null;
    allow(true);
    await flush();
    expect(mocks.api.restoreMongodbDatabase).not.toHaveBeenCalled();
    expect(mocks.store.ensureConnected).not.toHaveBeenCalled();
  });

  it("unlocks the dialog when production confirmation is declined", async () => {
    mocks.guard.mockResolvedValueOnce(false);
    await mount("restore");
    await filesSelected([new File([], "backup.archive")]);
    button("mongoDump.readSource").click();
    await flush();
    button("mongoDump.review").click();
    await flush();
    button("mongoDump.restore").click();
    await flush();
    expect(mocks.api.restoreMongodbDatabase).not.toHaveBeenCalled();
    expect(button("mongoDump.restore").disabled).toBe(false);
    button("mongoDump.restore").click();
    await flush();
    expect(mocks.api.restoreMongodbDatabase).toHaveBeenCalledTimes(1);
  });

  it("invalidates a prepared source when gzip changes without inferring the format from its name", async () => {
    await mount("restore");
    await filesSelected([new File([], "misleading.bson.gz")]);
    button("mongoDump.readSource").click();
    await flush();
    expect(mocks.api.prepareMongodbRestoreSource).toHaveBeenCalledWith(expect.any(File), "archive", false, expect.any(Object));
    checkbox("mongoDump.gzip").click();
    await flush();
    expect(mocks.api.releaseMongodbRestoreSource).toHaveBeenCalledWith("prepared-one");
    expect(button("mongoDump.review").disabled).toBe(true);
    expect(mocks.api.prepareMongodbRestoreSource).toHaveBeenCalledTimes(1);
  });

  it("releases a late preview after the dialog is unmounted", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.prepareMongodbRestoreSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount("restore");
    await filesSelected([new File([], "backup.archive")]);
    button("mongoDump.readSource").click();
    await flush();
    app!.unmount();
    app = null;
    resolve({ ...catalog, sourceRef: "late-source" });
    await flush();
    expect(mocks.api.releaseMongodbRestoreSource).toHaveBeenCalledWith("late-source");
  });
});
