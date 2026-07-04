import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const DB_NAME = "dbx-app-state";
const DB_VERSION = 1;
const STORE_NAME = "state";
const LOCAL_STORAGE_PREFIX = "dbx-app-state:";

function indexedDb(): IDBFactory | undefined {
  return typeof globalThis.indexedDB === "undefined" ? undefined : globalThis.indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const idb = indexedDb();
  if (!idb) return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function fallbackKey(key: string) {
  return `${LOCAL_STORAGE_PREFIX}${key}`;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await requestToPromise(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  } catch {
    return null;
  }
}

export async function loadBrowserAppState(key: string): Promise<unknown | null> {
  const value = await withStore("readonly", (store) => store.get(key));
  if (value !== null && value !== undefined) return value;

  const fallback = safeLocalStorageGet(fallbackKey(key));
  if (!fallback) return null;
  try {
    return JSON.parse(fallback);
  } catch {
    return null;
  }
}

export async function saveBrowserAppState(key: string, value: unknown): Promise<void> {
  const result = await withStore("readwrite", (store) => store.put(value, key));
  if (result !== null) return;
  safeLocalStorageSet(fallbackKey(key), JSON.stringify(value));
}
