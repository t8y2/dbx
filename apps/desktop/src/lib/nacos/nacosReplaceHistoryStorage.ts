import type { NacosReplaceHistoryEntry } from "./nacosReplaceHistory";

const DB_NAME = "dbx-nacos-replace-history";
const KEY_ID = "encryption-key";
interface EncryptedRow {
  id: string;
  connectionId: string;
  createdAt: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("nacos-history-storage-failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error("nacos-history-storage-failed"));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) throw new Error("nacos-history-storage-unavailable");
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("keys");
    const entries = db.createObjectStore("entries", { keyPath: "id" });
    entries.createIndex("connectionId", "connectionId");
  };
  request.onblocked = () => request.onerror?.(new Event("error"));
  const db = await requestValue(request);
  db.onversionchange = () => db.close();
  return db;
}

async function encryptionKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await requestValue<CryptoKey | undefined>(db.transaction("keys").objectStore("keys").get(KEY_ID));
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const tx = db.transaction(["keys", "entries"], "readwrite");
  const done = transactionDone(tx);
  let key: CryptoKey = candidate;
  const lookup = tx.objectStore("keys").get(KEY_ID);
  lookup.onsuccess = () => {
    if (lookup.result) {
      key = lookup.result;
      return;
    }
    const count = tx.objectStore("entries").count();
    count.onsuccess = () => {
      if (count.result) tx.abort();
      else tx.objectStore("keys").add(candidate, KEY_ID);
    };
  };
  await done;
  return key;
}

function additionalData(row: Pick<EncryptedRow, "id" | "connectionId">) {
  return new TextEncoder().encode(`${row.id}\u0000${row.connectionId}`);
}

async function decryptRow(row: EncryptedRow, key: CryptoKey): Promise<NacosReplaceHistoryEntry> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv, additionalData: additionalData(row) }, key, row.data);
    const entry = JSON.parse(new TextDecoder().decode(plain)) as NacosReplaceHistoryEntry;
    if (entry.version !== 1 || entry.id !== row.id || entry.connectionId !== row.connectionId || !Array.isArray(entry.plan?.items) || !Array.isArray(entry.report?.items)) throw new Error();
    return entry;
  } catch {
    throw new Error("nacos-history-storage-failed");
  }
}

export async function saveNacosReplaceHistory(entry: NacosReplaceHistoryEntry): Promise<void> {
  const db = await openDatabase();
  try {
    const key = await encryptionKey(db);
    const row: EncryptedRow = { id: entry.id, connectionId: entry.connectionId, createdAt: entry.createdAt, iv: crypto.getRandomValues(new Uint8Array(12)), data: new ArrayBuffer(0) };
    row.data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: row.iv, additionalData: additionalData(row) }, key, new TextEncoder().encode(JSON.stringify(entry)));
    const tx = db.transaction("entries", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("entries").put(row);
    await done;
  } catch {
    throw new Error("nacos-history-storage-failed");
  } finally {
    db.close();
  }
}

export async function listNacosReplaceHistory(connectionId: string): Promise<NacosReplaceHistoryEntry[]> {
  const db = await openDatabase();
  try {
    const rows = await requestValue<EncryptedRow[]>(db.transaction("entries").objectStore("entries").index("connectionId").getAll(connectionId));
    if (!rows.length) return [];
    const key = await encryptionKey(db);
    const entries = await Promise.all(rows.map((row) => decryptRow(row, key)));
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function getNacosReplaceHistory(id: string, connectionId: string): Promise<NacosReplaceHistoryEntry | undefined> {
  const db = await openDatabase();
  try {
    const row = await requestValue<EncryptedRow | undefined>(db.transaction("entries").objectStore("entries").get(id));
    if (!row || row.connectionId !== connectionId) return undefined;
    return await decryptRow(row, await encryptionKey(db));
  } finally {
    db.close();
  }
}

export async function deleteNacosReplaceHistory(id: string, connectionId: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction("entries", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("entries");
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      if (lookup.result?.connectionId === connectionId) store.delete(id);
    };
    await done;
  } finally {
    db.close();
  }
}
