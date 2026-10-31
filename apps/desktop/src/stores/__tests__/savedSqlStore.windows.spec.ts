import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import * as native from "@/lib/backend/tauri";
import { notifySavedSqlLibraryChanged, subscribeSavedSqlLibraryChanges } from "@/lib/savedSql/savedSqlLibraryEvents";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "@/types/database";

const bridge = vi.hoisted(() => ({
  native: true,
  window: "main",
  invoke: vi.fn(),
  emit: vi.fn(),
  listeners: new Set<(event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: bridge.emit,
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => void) => {
    bridge.listeners.add(listener);
    return () => {
      bridge.listeners.delete(listener);
    };
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: bridge.window }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => bridge.native }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ desktopSettings: { saved_sql_sync_dir: null } }) }));
vi.mock("@/lib/backend/api", async () => await vi.importActual("@/lib/backend/tauri"));

const timestamp = "2026-10-30T00:00:00.000Z";
let persisted: SavedSqlLibrary;

function file(overrides: Partial<SavedSqlFile> = {}): SavedSqlFile {
  return { id: "file-existing", connectionId: "mysql", database: "demo", folderId: "reports", name: "report.sql", sql: "SELECT 1;", sqlLoaded: true, createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

function summary(): SavedSqlLibrary {
  return structuredClone({ ...persisted, files: persisted.files.map((file) => ({ ...file, sql: "", sqlLoaded: false })) });
}

function windowStore(label: string) {
  bridge.window = label;
  const pinia = createPinia();
  setActivePinia(pinia);
  return useSavedSqlStore(pinia);
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.native = true;
  bridge.window = "main";
  bridge.listeners.clear();
  persisted = { folders: [{ id: "reports", connectionId: "mysql", name: "Reports", createdAt: timestamp, updatedAt: timestamp }], files: [] };
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) });
  bridge.emit.mockImplementation(async (_event: string, payload: unknown) => {
    for (const listener of bridge.listeners) listener({ payload });
  });
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
    if (command === "load_saved_sql_library") return summary();
    if (command === "load_saved_sql_file") return structuredClone(persisted.files.find((file) => file.id === args?.id) ?? null);
    if (command === "save_saved_sql_file") {
      const saved = structuredClone(args!.file) as SavedSqlFile;
      persisted.files = [...persisted.files.filter((file) => file.id !== saved.id), saved];
      return structuredClone(saved);
    }
    if (command === "save_saved_sql_folder") return args!.folder;
    if (command === "delete_saved_sql_folder" || command === "delete_saved_sql_file") return;
    if (command === "save_default_query_content") return;
    throw new Error(`Unexpected native command: ${command}`);
  });
});

afterEach(() => {
  bridge.listeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saved SQL across detached windows", () => {
  it.each(["mysql", "postgres", "sqlserver", "sqlite"])("makes a detached %s save visible in an already-loaded main window", async (connectionId) => {
    const main = windowStore("main");
    await subscribeSavedSqlLibraryChanges(() => main.refreshFromStorage());
    await main.initFromStorage();
    expect(main.allFiles).toEqual([]);

    const child = windowStore("detached-tab-query");
    const saved = await child.saveFile({ connectionId, database: "demo", name: "new-query.sql", sql: "SELECT 42;" });
    await vi.waitFor(() => expect(main.getFile(saved.id)?.name).toBe("new-query.sql"));
    expect((await main.ensureFileContent(saved.id))?.sql).toBe("SELECT 42;");
    expect(persisted.files.find((file) => file.id === saved.id)?.sql).toBe("SELECT 42;");
    expect(child.getFile(saved.id)?.sqlLoaded).toBe(true);
    const reopened = windowStore("reopened-window");
    await reopened.initFromStorage();
    expect((await reopened.ensureFileContent(saved.id))?.sql).toBe("SELECT 42;");
  });

  it("loads an existing file before saving so its id, folder and creation time survive", async () => {
    persisted.files = [file()];
    const child = windowStore("detached-tab-existing");
    const saved = await child.saveFile({ id: "file-existing", connectionId: "mysql", database: "demo", name: "report.sql", sql: "SELECT 2;" });
    expect(saved).toMatchObject({ id: "file-existing", folderId: "reports", createdAt: timestamp, sql: "SELECT 2;" });
    expect(persisted.files).toHaveLength(1);
  });

  it("does not lose a save that arrives while the main window's initial library read is pending", async () => {
    const main = windowStore("main");
    await subscribeSavedSqlLibraryChanges(() => main.refreshFromStorage());
    let resolve!: (value: SavedSqlLibrary) => void;
    bridge.invoke.mockReturnValueOnce(
      new Promise<SavedSqlLibrary>((done) => {
        resolve = done;
      }),
    );
    const startup = main.initFromStorage();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
    const child = windowStore("detached-tab-query");
    const saved = await child.saveFile({ connectionId: "mysql", database: "demo", name: "during-startup.sql", sql: "SELECT 5;" });
    resolve({ files: [], folders: [] });
    await startup;
    await vi.waitFor(() => expect(main.getFile(saved.id)?.name).toBe("during-startup.sql"));
  });

  it("refreshes other detached windows as well as the main window", async () => {
    const main = windowStore("main");
    await main.initFromStorage();
    await subscribeSavedSqlLibraryChanges(() => main.refreshFromStorage());
    const other = windowStore("detached-tab-other");
    await other.initFromStorage();
    await subscribeSavedSqlLibraryChanges(() => other.refreshFromStorage());
    const writer = windowStore("detached-tab-writer");
    const saved = await writer.saveFile({ connectionId: "mysql", database: "demo", name: "shared.sql", sql: "SELECT 7;" });
    await vi.waitFor(() => {
      expect(main.getFile(saved.id)?.name).toBe("shared.sql");
      expect(other.getFile(saved.id)?.name).toBe("shared.sql");
    });
  });

  it("does not invalidate the saving window's loaded SQL cache", async () => {
    const child = windowStore("detached-tab-query");
    const refresh = vi.fn(() => child.refreshFromStorage());
    await subscribeSavedSqlLibraryChanges(refresh);
    await child.saveFile({ connectionId: "mysql", database: "demo", name: "new-query.sql", sql: "SELECT 42;" });
    expect(refresh).not.toHaveBeenCalled();
    expect(child.allFiles[0]?.sql).toBe("SELECT 42;");
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "load_saved_sql_library")).toHaveLength(1);
  });

  it("invalidates stale loaded SQL in other windows after an overwrite", async () => {
    persisted.files = [file()];
    const main = windowStore("main");
    await main.initFromStorage();
    expect((await main.ensureFileContent("file-existing"))?.sql).toBe("SELECT 1;");
    await subscribeSavedSqlLibraryChanges(() => main.refreshFromStorage());
    const child = windowStore("detached-tab-existing");
    await child.saveFile({ id: "file-existing", connectionId: "mysql", database: "demo", name: "report.sql", sql: "SELECT 99;" });
    await vi.waitFor(() => expect(main.getFile("file-existing")?.sqlLoaded).toBe(false));
    expect((await main.ensureFileContent("file-existing"))?.sql).toBe("SELECT 99;");
  });

  it("preserves the previous list when refresh fails and allows retry", async () => {
    persisted.files = [file()];
    const main = windowStore("main");
    await main.initFromStorage();
    bridge.invoke.mockRejectedValueOnce(new Error("read failed"));
    await expect(main.refreshFromStorage()).rejects.toThrow("read failed");
    expect(main.allFiles).toHaveLength(1);
    persisted.files.push(file({ id: "new", name: "new.sql" }));
    await main.refreshFromStorage();
    expect(main.allFiles).toHaveLength(2);
  });

  it("coalesces change notifications but reads again if another change arrives during a read", async () => {
    const main = windowStore("main");
    await main.initFromStorage();
    let resolve!: (value: SavedSqlLibrary) => void;
    const oldSnapshot = new Promise<SavedSqlLibrary>((done) => {
      resolve = done;
    });
    bridge.invoke.mockReturnValueOnce(oldSnapshot);
    const first = main.refreshFromStorage();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(2));
    persisted.files = [file()];
    const second = main.refreshFromStorage();
    resolve({ files: [], folders: [] });
    await Promise.all([first, second]);
    expect(main.getFile("file-existing")?.name).toBe("report.sql");
    expect(bridge.invoke).toHaveBeenCalledTimes(3);
  });

  it("does not apply a stale refresh over a newer local save", async () => {
    persisted.files = [file()];
    const main = windowStore("main");
    await main.initFromStorage();
    let resolve!: (value: SavedSqlLibrary) => void;
    const stale = summary();
    bridge.invoke.mockReturnValueOnce(
      new Promise<SavedSqlLibrary>((done) => {
        resolve = done;
      }),
    );
    const refresh = main.refreshFromStorage();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(2));
    await main.saveFile({ id: "file-existing", connectionId: "mysql", database: "demo", name: "new-name.sql", sql: "SELECT 100;" });
    resolve(stale);
    await refresh;
    expect(main.getFile("file-existing")?.name).toBe("new-name.sql");
    expect((await main.ensureFileContent("file-existing"))?.sql).toBe("SELECT 100;");
  });

  it("does not write or notify when initial library loading fails", async () => {
    const child = windowStore("detached-tab-query");
    bridge.invoke.mockRejectedValueOnce(new Error("library unavailable"));
    await expect(child.saveFile({ connectionId: "mysql", database: "demo", name: "new.sql", sql: "SELECT 1;" })).rejects.toThrow("library unavailable");
    expect(persisted.files).toEqual([]);
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it("keeps a failed save out of the local library and releases its reserved name", async () => {
    const child = windowStore("detached-tab-query");
    await child.initFromStorage();
    bridge.invoke.mockRejectedValueOnce(new Error("disk full"));
    const input = { connectionId: "mysql", database: "demo", name: "new.sql", sql: "SELECT 1;" };
    await expect(child.saveFile(input)).rejects.toThrow("disk full");
    expect(child.allFiles).toEqual([]);
    expect(bridge.emit).not.toHaveBeenCalled();
    expect((await child.saveFile(input)).name).toBe("new.sql");
  });
});

describe("native SQL library change notifications", () => {
  it.each([
    ["file save", () => native.saveSavedSqlFile(file())],
    ["folder save", () => native.saveSavedSqlFolder(persisted.folders[0] as SavedSqlFolder)],
    ["file deletion", () => native.deleteSavedSqlFile("file-existing")],
    ["folder deletion", () => native.deleteSavedSqlFolder("reports")],
    ["default query autosave", () => native.saveDefaultQueryContent("file-existing", "SELECT 2;", timestamp)],
  ] as const)("notifies only after the native %s finishes", async (_name, operation) => {
    let resolve!: (value: unknown) => void;
    bridge.invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = operation();
    expect(bridge.emit).not.toHaveBeenCalled();
    resolve(file());
    await pending;
    expect(bridge.emit).toHaveBeenCalledOnce();
  });

  it("does not notify if persistence fails", async () => {
    bridge.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(native.saveSavedSqlFile(file())).rejects.toThrow("disk full");
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it("keeps a durable save successful if notification fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.emit.mockRejectedValueOnce(new Error("event transport unavailable"));
    expect(await native.saveSavedSqlFile(file())).toEqual(file());
    expect(persisted.files).toHaveLength(1);
    expect(warning).toHaveBeenCalled();
  });

  it("removes listeners when a window is disposed", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = await subscribeSavedSqlLibraryChanges(refresh);
    stop();
    bridge.window = "detached-tab-query";
    await notifySavedSqlLibraryChanged();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("handles a receiving window's refresh failure without rejecting the sender's save", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await subscribeSavedSqlLibraryChanges(async () => {
      throw new Error("read failed");
    });
    bridge.window = "detached-tab-query";
    await native.saveSavedSqlFile(file());
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("[DBX][saved-sql:refresh:error]", expect.any(Error)));
    expect(persisted.files).toHaveLength(1);
  });

  it("does not use native events in the web runtime", async () => {
    bridge.native = false;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = await subscribeSavedSqlLibraryChanges(refresh);
    await notifySavedSqlLibraryChanged();
    stop();
    expect(bridge.listeners.size).toBe(0);
    expect(bridge.emit).not.toHaveBeenCalled();
  });
});
