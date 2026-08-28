import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import { connectionIsEffectivelyReadOnly, ensureReadOnlyWriteAccess, formatWriteUnlockRemaining, sqlLooksLikeMutation } from "../readOnlyWriteAccess";

const unlockConnectionWrites = vi.fn();
const lockConnectionWrites = vi.fn();
const connectionWriteUnlockState = vi.fn();

vi.mock("@/lib/backend/api", () => ({
  unlockConnectionWrites: (...args: unknown[]) => unlockConnectionWrites(...args),
  lockConnectionWrites: (...args: unknown[]) => lockConnectionWrites(...args),
  connectionWriteUnlockState: (...args: unknown[]) => connectionWriteUnlockState(...args),
}));

async function waitForPending(connectionId: string) {
  const store = useReadOnlyUnlockStore();
  await vi.waitFor(() => {
    expect(store.pending?.connectionId).toBe(connectionId);
  });
  return store;
}

describe("read-only write unlock", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    unlockConnectionWrites.mockReset().mockResolvedValue(60_000);
    lockConnectionWrites.mockReset().mockResolvedValue(undefined);
    connectionWriteUnlockState.mockReset().mockResolvedValue(0);
    vi.useRealTimers();
  });

  it("formats remaining time as m:ss", () => {
    expect(formatWriteUnlockRemaining(60_000)).toBe("1:00");
    expect(formatWriteUnlockRemaining(5_000)).toBe("0:05");
    expect(formatWriteUnlockRemaining(0)).toBe("0:00");
  });

  it("classifies SQL and Redis writes without treating reads as mutations", () => {
    expect(sqlLooksLikeMutation("SELECT 1", "mysql")).toBe(false);
    expect(sqlLooksLikeMutation("INSERT INTO t VALUES (1)", "mysql")).toBe(true);
    expect(sqlLooksLikeMutation("UPDATE t SET a = 1", "postgres")).toBe(true);
    expect(sqlLooksLikeMutation("DELETE FROM t", "mysql")).toBe(true);
    expect(sqlLooksLikeMutation("CREATE TABLE t (id INT)", "mysql")).toBe(true);
    expect(sqlLooksLikeMutation("GET k", "redis")).toBe(false);
    expect(sqlLooksLikeMutation("SET k v", "redis")).toBe(true);
  });

  it("keeps the persistent read-only flag on while a window is active", async () => {
    const connection = { id: "prod", name: "prod-db", read_only: true, db_type: "mysql" as const };
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(true);

    const pending = ensureReadOnlyWriteAccess({ connection, sql: "INSERT INTO t VALUES (1)", source: "SQL editor" });
    const store = await waitForPending("prod");
    expect(unlockConnectionWrites).not.toHaveBeenCalled();

    await store.confirm(60);
    await expect(pending).resolves.toBe(true);
    expect(unlockConnectionWrites).toHaveBeenCalledWith("prod", 60);
    expect(connection.read_only).toBe(true);
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(false);
    expect(store.isUnlocked("prod")).toBe(true);
    expect(store.isUnlocked("other")).toBe(false);
  });

  it("cancels without unlocking and forgets the window when locked or expired", async () => {
    const connection = { id: "prod", name: "prod-db", read_only: true, db_type: "mysql" as const };

    const cancelled = ensureReadOnlyWriteAccess({ connection, sql: "DELETE FROM t", source: "SQL editor" });
    const store = await waitForPending("prod");
    store.cancel();
    await expect(cancelled).resolves.toBe(false);
    expect(unlockConnectionWrites).not.toHaveBeenCalled();
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(true);

    const unlocked = ensureReadOnlyWriteAccess({ connection, sql: "DELETE FROM t", source: "SQL editor" });
    await waitForPending("prod");
    await store.confirm(60);
    await expect(unlocked).resolves.toBe(true);
    expect(await ensureReadOnlyWriteAccess({ connection, sql: "UPDATE t SET a = 1" })).toBe(true);
    expect(unlockConnectionWrites).toHaveBeenCalledTimes(1);

    await store.lockNow("prod");
    expect(lockConnectionWrites).toHaveBeenCalledWith("prod");
    expect(store.isUnlocked("prod")).toBe(false);
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(true);
  });

  it("does not prompt for reads or writable connections", async () => {
    const store = useReadOnlyUnlockStore();
    await expect(ensureReadOnlyWriteAccess({ connection: { id: "w", read_only: false, db_type: "mysql" }, sql: "INSERT INTO t VALUES (1)" })).resolves.toBe(true);
    await expect(ensureReadOnlyWriteAccess({ connection: { id: "r", read_only: true, db_type: "mysql" }, sql: "SELECT 1" })).resolves.toBe(true);
    expect(store.pending).toBeUndefined();
    expect(connectionWriteUnlockState).not.toHaveBeenCalled();
  });

  it("reuses an existing backend window without prompting again", async () => {
    connectionWriteUnlockState.mockResolvedValue(45_000);
    const connection = { id: "prod", name: "prod-db", read_only: true, db_type: "mysql" as const };
    await expect(ensureReadOnlyWriteAccess({ connection, sql: "INSERT INTO t VALUES (1)" })).resolves.toBe(true);
    expect(unlockConnectionWrites).not.toHaveBeenCalled();
    expect(useReadOnlyUnlockStore().pending).toBeUndefined();
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(false);
  });

  it("returns to effectively read-only when the local timer expires", async () => {
    vi.useFakeTimers();
    const store = useReadOnlyUnlockStore();
    const connection = { id: "prod", name: "prod-db", read_only: true, db_type: "mysql" as const };
    store.rememberWindow("prod", 60_000);
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.isUnlocked("prod")).toBe(false);
    expect(connectionIsEffectivelyReadOnly(connection)).toBe(true);
    expect(connection.read_only).toBe(true);
  });
});
