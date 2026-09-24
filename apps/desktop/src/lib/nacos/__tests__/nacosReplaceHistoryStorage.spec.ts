import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveNacosReplaceHistory, getNacosReplaceHistory, listNacosReplaceHistory, deleteNacosReplaceHistory } from "../nacosReplaceHistoryStorage";
import { buildNacosContentReplacePlan } from "../nacosContentReplace";
import type { NacosReplaceHistoryEntry } from "../nacosReplaceHistory";

const plan = buildNacosContentReplacePlan([{ namespace: "", group: "test", dataId: "one", content: "secret-test-old" }], "secret-test-old", "secret-test-new");
function entry(id = "one", connectionId = "main", createdAt = 1): NacosReplaceHistoryEntry {
  return {
    version: 1,
    id,
    connectionId,
    target: "local",
    createdAt,
    updatedAt: createdAt,
    scope: { scope: "allNamespaces", namespace: "", group: "", dataId: "" },
    state: "completed",
    plan,
    report: { ...plan, items: [{ ...plan.items[0], status: "replaced" }], replaced: 1, conflicts: 0, failed: 0, cancelled: false },
  };
}
function value<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function open() {
  return value(indexedDB.open("dbx-nacos-replace-history", 1));
}
async function stored() {
  const db = await open();
  const row = await value(db.transaction("entries").objectStore("entries").get("one"));
  const key = await value(db.transaction("keys").objectStore("keys").get("encryption-key"));
  db.close();
  return { row, key };
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encrypted local Nacos history storage", () => {
  it("round trips snapshots with a durable non-extractable key and no plaintext values", async () => {
    await saveNacosReplaceHistory(entry());
    expect(await getNacosReplaceHistory("one", "main")).toEqual(JSON.parse(JSON.stringify(entry())));
    const { row, key } = await stored();
    expect(row.data).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(row.data)).not.toContain("secret-test");
    expect(JSON.stringify(row)).not.toContain("secret-test");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
  it("lists only the current connection, sorts newest first, updates one row and deletes only that connection's record", async () => {
    expect(await listNacosReplaceHistory("main")).toEqual([]);
    await saveNacosReplaceHistory(entry());
    await saveNacosReplaceHistory(entry("two", "main", 2));
    await saveNacosReplaceHistory(entry("foreign", "other", 3));
    await saveNacosReplaceHistory({ ...entry(), state: "rollbackCompleted" });
    expect((await listNacosReplaceHistory("main")).map((item) => item.id)).toEqual(["two", "one"]);
    expect((await getNacosReplaceHistory("one", "main"))?.state).toBe("rollbackCompleted");
    expect(await getNacosReplaceHistory("one", "other")).toBeUndefined();
    expect(await getNacosReplaceHistory("missing", "main")).toBeUndefined();
    await deleteNacosReplaceHistory("one", "other");
    expect(await getNacosReplaceHistory("one", "main")).toBeDefined();
    await deleteNacosReplaceHistory("one", "main");
    await deleteNacosReplaceHistory("missing", "main");
    expect((await listNacosReplaceHistory("main")).map((item) => item.id)).toEqual(["two"]);
  });
  it("atomically initializes one shared key during concurrent first saves", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveNacosReplaceHistory(entry(String(i)))));
    expect(await listNacosReplaceHistory("main")).toHaveLength(8);
  });
  it("rejects tampered ciphertext rather than returning untrusted snapshots", async () => {
    await saveNacosReplaceHistory(entry());
    const { row } = await stored();
    new Uint8Array(row.data)[0] ^= 1;
    const db = await open();
    await value(db.transaction("entries", "readwrite").objectStore("entries").put(row));
    db.close();
    await expect(getNacosReplaceHistory("one", "main")).rejects.toThrow("nacos-history-storage-failed");
    await expect(listNacosReplaceHistory("main")).rejects.toThrow("nacos-history-storage-failed");
  });
  it.each([{ version: 2 }, { id: "changed" }, { connectionId: "other" }, { plan: {} }, { report: {} }])("validates authenticated record identity and version (%j)", async (change) => {
    await saveNacosReplaceHistory(entry());
    const { row, key } = await stored();
    row.data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: row.iv, additionalData: new TextEncoder().encode("one\u0000main") }, key, new TextEncoder().encode(JSON.stringify({ ...entry(), ...change })));
    const db = await open();
    await value(db.transaction("entries", "readwrite").objectStore("entries").put(row));
    db.close();
    await expect(getNacosReplaceHistory("one", "main")).rejects.toThrow("nacos-history-storage-failed");
  });
  it("never replaces a lost key when encrypted backups already exist", async () => {
    await saveNacosReplaceHistory(entry());
    const db = await open();
    await value(db.transaction("keys", "readwrite").objectStore("keys").delete("encryption-key"));
    db.close();
    await expect(getNacosReplaceHistory("one", "main")).rejects.toThrow("nacos-history-storage-failed");
    await expect(saveNacosReplaceHistory(entry("two"))).rejects.toThrow("nacos-history-storage-failed");
  });
  it("fails closed without IndexedDB or Web Crypto and never falls back to localStorage", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveNacosReplaceHistory(entry())).rejects.toThrow("nacos-history-storage-unavailable");
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("crypto", {});
    await expect(saveNacosReplaceHistory(entry())).rejects.toThrow("nacos-history-storage-unavailable");
    expect(setItem).not.toHaveBeenCalled();
  });
  it("reports quota/transaction errors rather than silently losing snapshots", async () => {
    await saveNacosReplaceHistory(entry());
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await expect(saveNacosReplaceHistory(entry("two"))).rejects.toThrow("nacos-history-storage-failed");
    expect(await getNacosReplaceHistory("one", "main")).toBeDefined();
  });
  it("reports a database open error", async () => {
    await value(indexedDB.open("dbx-nacos-replace-history", 2)).then((db) => db.close());
    await expect(listNacosReplaceHistory("main")).rejects.toThrow("nacos-history-storage-failed");
  });
});
