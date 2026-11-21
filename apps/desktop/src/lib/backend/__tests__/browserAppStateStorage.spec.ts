import { afterEach, describe, expect, it, vi } from "vitest";

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
