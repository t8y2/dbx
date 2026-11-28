import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBFactory } from "fake-indexeddb";

function installIndexedDb(transactionOutcome: "complete" | "abort", capturedPuts?: unknown[]) {
  const transaction: Record<string, any> = {
    error: null,
    oncomplete: null,
    onabort: null,
    onerror: null,
  };
  const store = {
    put(value: unknown, key: IDBValidKey) {
      capturedPuts?.push(value);
      const request: Record<string, any> = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        request.result = key;
        request.onsuccess?.();
        queueMicrotask(() => {
          if (transactionOutcome === "complete") {
            transaction.oncomplete?.();
          } else {
            transaction.error = new Error("transaction aborted");
            transaction.onabort?.();
          }
        });
      });
      return request as IDBRequest<IDBValidKey>;
    },
  };
  transaction.objectStore = () => store;
  const database = {
    transaction: () => transaction as IDBTransaction,
  };
  const indexedDB = {
    open() {
      const request: Record<string, any> = { result: database, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => request.onsuccess?.());
      return request as IDBOpenDBRequest;
    },
  };
  vi.stubGlobal("indexedDB", indexedDB);
}

function installLocalStorage(setItem: (key: string, value: string) => void) {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(setItem),
    removeItem: vi.fn(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("saveBrowserAppState", () => {
  it("waits for transaction commit and falls back after an IndexedDB abort", async () => {
    installIndexedDb("abort");
    installLocalStorage(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { saveBrowserAppState } = await import("@/lib/backend/browserAppStateStorage");

    await expect(saveBrowserAppState("transfer_task_library", { version: 1 })).resolves.toBeUndefined();

    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith("dbx-app-state:transfer_task_library", JSON.stringify({ version: 1 }));
  });

  it("normalizes reactive proxies so IndexedDB structured clone cannot reject the put", async () => {
    const captured: unknown[] = [];
    installIndexedDb("complete", captured);
    installLocalStorage(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { saveBrowserAppState } = await import("@/lib/backend/browserAppStateStorage");

    // Vue reactive objects are proxies; structured clone (IndexedDB's put
    // serialization) rejects them wholesale with a DataCloneError.
    const reactiveSelection = new Proxy({ anchor: 3, head: 7 }, {});
    expect(() => structuredClone(reactiveSelection)).toThrow();

    await expect(
      saveBrowserAppState("open_tabs", {
        tabs: [{ id: "t1", sql: "SELECT 1", editorSelection: reactiveSelection, untouched: undefined }],
      }),
    ).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    // The stored value must itself be structured-cloneable.
    expect(() => structuredClone(captured[0])).not.toThrow();
    const storedTabs = (captured[0] as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(storedTabs[0].editorSelection).toEqual({ anchor: 3, head: 7 });
    // Undefined fields drop out, matching the localStorage fallback's JSON
    // representation exactly.
    expect("untouched" in storedTabs[0]).toBe(false);
    // A successful IndexedDB write clears any stale fallback copy instead of
    // leaving an older localStorage value that a future load could resurrect.
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith("dbx-app-state:open_tabs");
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("throws when localStorage quota prevents the fallback write", async () => {
    vi.stubGlobal("indexedDB", undefined);
    installLocalStorage(() => {
      throw new Error("quota exceeded");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { saveBrowserAppState } = await import("@/lib/backend/browserAppStateStorage");

    await expect(saveBrowserAppState("transfer_task_library", { version: 1 })).rejects.toThrow("Failed to persist browser app state: transfer_task_library");
  });

  it("throws when both IndexedDB and localStorage fail", async () => {
    installIndexedDb("abort");
    installLocalStorage(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { saveBrowserAppState } = await import("@/lib/backend/browserAppStateStorage");

    await expect(saveBrowserAppState("transfer_task_library", { version: 1 })).rejects.toThrow("Failed to persist browser app state: transfer_task_library");
  });
});

it("keeps concurrent updates to different saved SQL files from separate browser tabs", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  installLocalStorage(() => undefined);
  const { createSavedSqlEditorFoldSnapshot, createSavedSqlEditorPosition } = await import("@/lib/app/savedSqlEditorPosition");
  const windowA = await import("@/lib/backend/http");
  vi.resetModules();
  const windowB = await import("@/lib/backend/http");
  const sql = "SELECT\n  1;";
  const folds = createSavedSqlEditorFoldSnapshot(sql, [{ from: 6, to: 10 }]);
  const a = createSavedSqlEditorPosition({ savedSqlId: "file-a", sql, folds, now: 1 });
  const b = createSavedSqlEditorPosition({ savedSqlId: "file-b", sql, selection: { anchor: 4, head: 4 }, now: 2 });
  expect(await windowA.loadSavedSqlEditorPositions()).toBeNull();
  expect(await windowB.loadSavedSqlEditorPositions()).toBeNull();

  await Promise.all([windowA.saveSavedSqlEditorPositions({ type: "save", position: a }), windowB.saveSavedSqlEditorPositions({ type: "save", position: b })]);
  expect(await windowB.loadSavedSqlEditorPositions()).toEqual([b, a]);
  await windowB.saveSavedSqlEditorPositions({ type: "initialize", positions: [] });
  expect(await windowA.loadSavedSqlEditorPositions()).toEqual([b, a]);
  await windowB.saveSavedSqlEditorPositions({ type: "remove", savedSqlId: b.savedSqlId });
  expect(await windowA.loadSavedSqlEditorPositions()).toEqual([a]);
});

it("restores fallback positions after a failed IndexedDB write and carries them forward on recovery", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const localValues = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const windowA = await import("@/lib/backend/http");
  const { createSavedSqlEditorFoldSnapshot, createSavedSqlEditorPosition } = await import("@/lib/app/savedSqlEditorPosition");
  const sql = "SELECT\n  1;";
  const old = createSavedSqlEditorPosition({ savedSqlId: "file-a", sql, now: 1 });
  const folded = createSavedSqlEditorPosition({ savedSqlId: "file-b", sql, folds: createSavedSqlEditorFoldSnapshot(sql, [{ from: 6, to: 10 }]), now: 2 });
  const recovered = createSavedSqlEditorPosition({ savedSqlId: "file-c", sql, now: 3 });
  await windowA.saveSavedSqlEditorPositions({ type: "save", position: old });

  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    const opened = transaction.apply(this, args);
    if (args[1] === "readwrite") queueMicrotask(() => opened.abort());
    return opened;
  });
  await windowA.saveSavedSqlEditorPositions({ type: "save", position: folded });
  vi.resetModules();
  const windowB = await import("@/lib/backend/http");
  expect(await windowB.loadSavedSqlEditorPositions()).toEqual([folded, old]);

  vi.mocked(IDBDatabase.prototype.transaction).mockRestore();
  await windowB.saveSavedSqlEditorPositions({ type: "save", position: recovered });
  expect(localValues.has("dbx-app-state:saved_sql_editor_positions")).toBe(false);
  expect(await windowA.loadSavedSqlEditorPositions()).toEqual([recovered, folded, old]);
});
