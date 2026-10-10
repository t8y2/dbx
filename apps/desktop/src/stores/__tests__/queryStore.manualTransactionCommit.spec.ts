import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseType } from "@/types/database";

const mocks = vi.hoisted(() => ({
  beginManualTransaction: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  commitManualTransaction: vi.fn(),
  rollbackManualTransaction: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function setupManualTab(dbType: DatabaseType) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const { useQueryStore } = await import("@/stores/queryStore");
  useConnectionStore().connections.push(...["conn", "other-conn"].map((id) => ({ id, name: id, db_type: dbType, database: "ORCL", host: "localhost", port: 1521, username: "", password: "" })));
  useSettingsStore().editorSettings.confirmUnsavedSqlClose = false;
  const store = useQueryStore();
  const id = store.createTab("conn", "ORCL", "Query", "query", "APP");
  store.setAutoCommit(id, false);
  mocks.beginManualTransaction.mockResolvedValueOnce("txn-old");
  await store.ensureManualTransactionSession(id, "ORCL", "APP");
  store.markManualTransactionDirty(id);
  const tab = store.tabs.find((candidate) => candidate.id === id)!;
  return { store, id, tab };
}

async function finishCommit(commit: ReturnType<typeof deferred<void>>, committing: Promise<void>, outcome: "success" | "failure") {
  const error = new Error("Commit response lost");
  const settled = outcome === "success" ? expect(committing).resolves.toBeUndefined() : expect(committing).rejects.toBe(error);
  if (outcome === "success") commit.resolve();
  else commit.reject(error);
  await settled;
}

describe.each(["oracle", "oceanbase-oracle"] as const)("queryStore %s commit lifecycle", (dbType) => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    setActivePinia(createPinia());
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    mocks.closeClientConnectionSession.mockResolvedValue(undefined);
    mocks.rollbackManualTransaction.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("preserves a synchronous backend error and permits the next transaction to commit", async () => {
    const { store, id, tab } = await setupManualTab(dbType);
    const error = new Error("Synchronous commit boundary failure");
    mocks.commitManualTransaction.mockImplementationOnce(() => {
      throw error;
    });

    await expect(store.commitTransaction(id)).rejects.toBe(error);
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.txnPossiblyDirty).toBe(false);

    mocks.beginManualTransaction.mockResolvedValueOnce("txn-next");
    await store.ensureManualTransactionSession(id, "ORCL", "APP");
    mocks.commitManualTransaction.mockResolvedValueOnce(undefined);
    await expect(store.commitTransaction(id)).resolves.toBeUndefined();
    expect(mocks.commitManualTransaction.mock.calls.map(([sessionId]) => sessionId)).toEqual(["txn-old", "txn-next"]);
    expect(tab.txnSessionId).toBeUndefined();
  });

  it.each(["success", "failure"] as const)("shares an in-flight commit until its %s result arrives", async (outcome) => {
    const { store, id, tab } = await setupManualTab(dbType);
    const commit = deferred<void>();
    mocks.commitManualTransaction.mockReturnValueOnce(commit.promise).mockRejectedValue(new Error("Transaction session not found"));
    const first = store.commitTransaction(id);
    const second = store.commitTransaction(id);
    const secondResult = second.then(
      () => undefined,
      (error) => error,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.commitManualTransaction).toHaveBeenCalledTimes(1);
    expect(tab.txnSessionId).toBe("txn-old");
    expect(tab.txnPossiblyDirty).toBe(true);

    await finishCommit(commit, first, outcome);
    expect(await secondResult).toEqual(outcome === "success" ? undefined : new Error("Commit response lost"));
    expect(tab.txnSessionId).toBeUndefined();
  });

  it("tracks a replacement commit independently while the old commit finishes", async () => {
    const { store, id, tab } = await setupManualTab(dbType);
    const oldCommit = deferred<void>();
    const newCommit = deferred<void>();
    mocks.commitManualTransaction.mockReturnValueOnce(oldCommit.promise).mockReturnValueOnce(newCommit.promise);
    const oldCommitting = store.commitTransaction(id);
    store.updateSchema(id, "OTHER");
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-new");
    await store.ensureManualTransactionSession(id, "ORCL", "OTHER");
    store.markManualTransactionDirty(id);
    const newCommitting = store.commitTransaction(id);

    oldCommit.resolve();
    await oldCommitting;
    const duplicate = store.commitTransaction(id);
    expect(mocks.commitManualTransaction.mock.calls.map(([sessionId]) => sessionId)).toEqual(["txn-old", "txn-new"]);
    expect(tab.txnSessionId).toBe("txn-new");
    expect(tab.txnPossiblyDirty).toBe(true);

    newCommit.resolve();
    await Promise.all([newCommitting, duplicate]);
    expect(tab.txnSessionId).toBeUndefined();
  });

  describe.each(["success", "failure"] as const)("old commit %s", (outcome) => {
    it.each(["mode", "schema", "database", "connection"] as const)("preserves a replacement transaction after a %s change", async (change) => {
      const { store, id, tab } = await setupManualTab(dbType);
      const commit = deferred<void>();
      mocks.commitManualTransaction.mockReturnValueOnce(commit.promise);
      const committing = store.commitTransaction(id);
      expect(mocks.commitManualTransaction).toHaveBeenCalledWith("txn-old");
      const rollback = deferred<void>();
      if (change === "schema") mocks.rollbackManualTransaction.mockReturnValueOnce(rollback.promise);

      if (change === "mode") {
        // Core removes the old session before awaiting COMMIT, so rollback can see not-found.
        mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
        store.setAutoCommit(id, true);
        store.setAutoCommit(id, false);
      } else if (change === "schema") store.updateSchema(id, "OTHER");
      else if (change === "database") store.updateDatabase(id, "OTHER");
      else {
        store.updateConnection(id, "other-conn", "OTHER");
        store.setAutoCommit(id, false);
      }
      mocks.beginManualTransaction.mockResolvedValueOnce("txn-new");
      await store.ensureManualTransactionSession(id, tab.database, tab.schema);
      store.markManualTransactionDirty(id);

      await finishCommit(commit, committing, outcome);

      expect(tab.txnSessionId).toBe("txn-new");
      expect(tab.txnPossiblyDirty).toBe(true);
      rollback.resolve();
      await rollback.promise;
      // The replacement remains usable by the next caller and by the rollback control.
      await expect(store.ensureManualTransactionSession(id, tab.database, tab.schema)).resolves.toBe("txn-new");
      await store.rollbackTransaction(id);
      expect(mocks.rollbackManualTransaction).toHaveBeenLastCalledWith("txn-new");
      expect(tab.txnSessionId).toBeUndefined();
      expect(tab.txnPossiblyDirty).toBe(false);
    });

    it("cleans up the original session when no replacement was opened", async () => {
      const { store, id, tab } = await setupManualTab(dbType);
      const commit = deferred<void>();
      mocks.commitManualTransaction.mockReturnValueOnce(commit.promise);
      const committing = store.commitTransaction(id);

      await finishCommit(commit, committing, outcome);

      expect(tab.txnSessionId).toBeUndefined();
      expect(tab.txnStatus).toBeUndefined();
      expect(tab.txnPossiblyDirty).toBe(false);
      expect(tab.txnAutoRolledBack).toBe(false);
      expect(tab.autoCommit).toBe(false);
    });

    it("keeps auto-commit mode after the old session was discarded", async () => {
      const { store, id, tab } = await setupManualTab(dbType);
      const commit = deferred<void>();
      mocks.commitManualTransaction.mockReturnValueOnce(commit.promise);
      const committing = store.commitTransaction(id);
      store.setAutoCommit(id, true);

      await finishCommit(commit, committing, outcome);

      expect(tab.autoCommit).toBe(true);
      expect(tab.txnSessionId).toBeUndefined();
      expect(tab.txnPossiblyDirty).toBe(false);
    });

    it("allows a replacement session still opening when the old commit ends", async () => {
      const { store, id, tab } = await setupManualTab(dbType);
      const commit = deferred<void>();
      mocks.commitManualTransaction.mockReturnValueOnce(commit.promise);
      const committing = store.commitTransaction(id);
      store.setAutoCommit(id, true);
      store.setAutoCommit(id, false);
      const begin = deferred<string>();
      mocks.beginManualTransaction.mockReturnValueOnce(begin.promise);
      const starting = store.ensureManualTransactionSession(id, "ORCL", "APP");

      await finishCommit(commit, committing, outcome);
      begin.resolve("txn-new");
      await expect(starting).resolves.toBe("txn-new");
      store.markManualTransactionDirty(id);

      expect(tab.txnSessionId).toBe("txn-new");
      expect(tab.txnPossiblyDirty).toBe(true);
    });

    it("does not affect a new tab after the committing tab closes", async () => {
      const { store, id } = await setupManualTab(dbType);
      const commit = deferred<void>();
      mocks.commitManualTransaction.mockReturnValueOnce(commit.promise);
      const committing = store.commitTransaction(id);
      store.closeTab(id);
      expect(store.tabs.some((tab) => tab.id === id)).toBe(false);
      const newId = store.createTab("conn", "ORCL", "Query", "query", "APP");
      store.setAutoCommit(newId, false);
      mocks.beginManualTransaction.mockResolvedValueOnce("txn-new");
      await store.ensureManualTransactionSession(newId, "ORCL", "APP");
      store.markManualTransactionDirty(newId);

      await finishCommit(commit, committing, outcome);

      const newTab = store.tabs.find((tab) => tab.id === newId)!;
      expect(newTab.txnSessionId).toBe("txn-new");
      expect(newTab.txnPossiblyDirty).toBe(true);
      expect(store.activeTabId).toBe(newId);
    });
  });
});
