import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

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

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
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
    const transaction = db.transaction(STORE_NAME, mode);
    const request = requestToPromise(run(transaction.objectStore(STORE_NAME)));
    if (mode === "readwrite") {
      const [result] = await Promise.all([request, transactionToPromise(transaction)]);
      return result;
    }
    return await request;
  } catch (error) {
    // Never fully silent: a persistent failure here degrades every save to the
    // localStorage fallback while loads keep preferring the stale IndexedDB
    // snapshot — exactly the workspace-freeze regression this module guards
    // against elsewhere.
    console.warn("[DBX][browserAppStateStorage] IndexedDB operation failed; falling back to localStorage", error);
    return null;
  }
}

export async function loadBrowserAppState(key: string): Promise<unknown | null> {
  const value = await withStore("readonly", (store) => store.get(key));
  if (value !== null && value !== undefined) return value;

  return loadFallback(key);
}

function loadFallback(key: string): unknown | null {
  const fallback = safeLocalStorageGet(fallbackKey(key));
  if (!fallback) return null;
  try {
    return JSON.parse(fallback);
  } catch {
    return null;
  }
}

/**
 * Values handed to this module frequently come straight out of reactive stores
 * (open tabs carry reactive editor selection/viewport objects, editor settings
 * are store objects). IndexedDB's structured clone rejects Vue reactive
 * proxies with a DataCloneError, which used to silently degrade every save to
 * the localStorage fallback while loadBrowserAppState kept preferring the
 * stale IndexedDB snapshot — freezing workspace persistence in web mode after
 * the first cursor move. JSON round-tripping yields the exact plain
 * representation the fallback already stores (proxies unwrapped, undefined
 * fields dropped), keeping both copies equivalent.
 */
function toStorableValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export async function saveBrowserAppState(key: string, value: unknown): Promise<void> {
  const stored = toStorableValue(value);
  const result = await withStore("readwrite", (store) => store.put(stored, key));
  if (result !== null) {
    // Drop any fallback copy left behind by an earlier failed save: it is now
    // older than the IndexedDB value and must never be resurrected by a future
    // load that cannot reach IndexedDB.
    safeLocalStorageRemove(fallbackKey(key));
    return;
  }
  if (safeLocalStorageSet(fallbackKey(key), JSON.stringify(stored))) return;
  throw new Error(`Failed to persist browser app state: ${key}`);
}

// A fallback written by an update contains that key's newest snapshot, even
// when the older IndexedDB value is still readable after a failed write.
export async function loadUpdatedBrowserAppState(key: string): Promise<unknown | null> {
  return loadFallback(key) ?? (await withStore("readonly", (store) => store.get(key))) ?? null;
}

export async function updateBrowserAppState(key: string, update: (current: unknown) => unknown): Promise<void> {
  async function updateState() {
    const fallback = loadFallback(key);
    let stored: unknown;
    let updateFailure: { error: unknown } | undefined;
    try {
      const db = await openDb();
      if (db) {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        const complete = transactionToPromise(transaction);
        request.onsuccess = () => {
          try {
            stored = toStorableValue(update(fallback ?? request.result ?? null));
          } catch (error) {
            updateFailure = { error };
            transaction.abort();
            return;
          }
          try {
            store.put(stored, key);
          } catch {
            transaction.abort();
          }
        };
        await complete;
        safeLocalStorageRemove(fallbackKey(key));
        return;
      }
    } catch (error) {
      if (updateFailure) throw updateFailure.error;
      console.warn("[DBX][browserAppStateStorage] IndexedDB operation failed; falling back to localStorage", error);
    }

    // An abort may happen before the read callback. Recover the existing
    // snapshot so updating one file does not drop other windows' positions.
    if (stored === undefined) stored = toStorableValue(update(await loadUpdatedBrowserAppState(key)));
    if (!safeLocalStorageSet(fallbackKey(key), JSON.stringify(stored))) {
      throw new Error(`Failed to persist browser app state: ${key}`);
    }
  }

  if (globalThis.navigator?.locks) await navigator.locks.request(fallbackKey(key), updateState);
  else await updateState();
}
