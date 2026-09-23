import { describe, expect, it, vi } from "vitest";
import { useMigrationStore } from "./migrationStore";
import type { MigrationPreflight, MigrationReport } from "@/lib/backend/migration";

const pending = (): MigrationPreflight => ({
  migrationId: "secret-store-v1",
  state: "pending",
  needsMigration: true,
  keyProviderAvailable: true,
  keyCreationAllowed: false,
  databasePlaintextCount: 2,
  connectionCount: 1,
  pluginSecretCount: 0,
  aiSecretCount: 0,
  tunnelSecretCount: 0,
  syncCredentialCount: 0,
  legacyJsonFiles: [],
  backupRequired: true,
});
const done = (): MigrationPreflight => ({ ...pending(), state: "succeeded", needsMigration: false, databasePlaintextCount: 0, backupPath: "/tmp/backup" });
const report: MigrationReport = { migrationId: "secret-store-v1", state: "succeeded", backupPath: "/tmp/backup", databasePlaintextCount: 2, legacyJsonFiles: [], verifiedSecretCount: 2 };

describe("migration store", () => {
  it("keeps the wizard blocked until explicit entry after a successful migration", async () => {
    const status = vi.fn().mockResolvedValueOnce(pending()).mockResolvedValue(done());
    const store = useMigrationStore({ migrationStatus: status, migrationStart: vi.fn().mockResolvedValue(report), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() });
    await store.initialize();
    expect(store.blocking.value).toBe(true);
    await store.start();
    expect(store.state.report).toEqual(report);
    expect(store.blocking.value).toBe(true);
    store.enter();
    expect(store.blocking.value).toBe(false);
  });

  it("preserves the report and status when cleanup fails", async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error("failed"));
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValue(done()), migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: cleanup });
    await store.initialize();
    store.state.report = report;
    await store.cleanup();
    expect(store.state.error).toBe("cleanupFailed");
    expect(store.state.report).toEqual(report);
  });

  it("allows a completed migration with a retained backup to enter after restart", async () => {
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValue(done()), migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() });
    await store.initialize();
    expect(store.completed.value).toBe(true);
    expect(store.blocking.value).toBe(false);
  });

  it("keeps status failures on the status retry path", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unavailable"), { backendError: { code: "KEY_PROVIDER_UNAVAILABLE", detail: "safe detail" } }))
      .mockResolvedValue(done());
    const store = useMigrationStore({ migrationStatus: status, migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() });
    await store.initialize();
    expect(store.state.error).toBe("statusFailed");
    expect(store.state.errorCode).toBeNull();
    expect(store.state.errorMessage).toBeNull();
    await store.initialize();
    expect(store.state.error).toBeNull();
    expect(store.completed.value).toBe(true);
  });
  it("discards arbitrary transport exception values in state and diagnostics", async () => {
    const secret = "password=DO_NOT_EXPOSE";
    const failure = Object.assign(new Error(secret), { backendError: { code: secret, detail: secret } });
    const status = vi.fn().mockRejectedValue(failure);
    const store = useMigrationStore({ migrationStatus: status, migrationStart: vi.fn().mockRejectedValue(failure), migrationRetry: vi.fn().mockRejectedValue(failure), migrationCleanupBackups: vi.fn().mockRejectedValue(failure) });
    for (const action of [store.initialize, store.start, store.retry, store.cleanup]) {
      await action();
      expect(JSON.stringify(store.state)).not.toContain(secret);
      expect(JSON.stringify(store.diagnostic())).not.toContain(secret);
    }
  });

  it("shows safe preflight errors even when the migration is pending", async () => {
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValue({ ...pending(), errorCode: "MISSING_PERSISTENT_KEY", errorMessage: "Configure a persistent key." }), migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() });
    await store.initialize();
    expect(store.state.error).toBe("migrationFailed");
    expect(store.state.errorCode).toBe("MISSING_PERSISTENT_KEY");
    expect(store.state.errorMessage).toBe("Configure a persistent key.");
  });

  it("does not show a failure for a managed key created by migration", async () => {
    const store = useMigrationStore({
      migrationStatus: vi.fn().mockResolvedValue({
        ...pending(),
        keyProviderAvailable: false,
        keyCreationAllowed: true,
        errorCode: "MISSING_MANAGED_KEY",
        errorMessage: "A managed data-directory secret key will be created when migration starts",
      }),
      migrationStart: vi.fn(),
      migrationRetry: vi.fn(),
      migrationCleanupBackups: vi.fn(),
    });

    await store.initialize();

    expect(store.state.error).toBeNull();
    expect(store.state.errorCode).toBe("MISSING_MANAGED_KEY");
  });

  it("keeps completion through a failed cleanup and successful cleanup retry", async () => {
    let finishCleanup!: () => void;
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("password=secret"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
    const retry = vi.fn();
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValue(done()), migrationStart: vi.fn(), migrationRetry: retry, migrationCleanupBackups: cleanup });
    await store.initialize();
    await store.cleanup();
    expect(store.state.error).toBe("cleanupFailed");
    expect(store.state.step).toBe(3);
    expect(store.completed.value).toBe(true);
    expect(store.state.status?.backupPath).toBe("/tmp/backup");
    const cleanupAttempt = store.cleanup();
    expect(store.state.busy).toBe(true);
    await store.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(2);
    store.enter();
    expect(store.state.entered).toBe(true);
    finishCleanup();
    await cleanupAttempt;
    expect(store.state.busy).toBe(false);
    expect(store.state.step).toBe(3);
    expect(store.state.error).toBeNull();
    expect(store.completed.value).toBe(true);
    expect(store.state.status?.backupPath).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it("recovers when a lost action response is followed by verified completion", async () => {
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValue(done()), migrationStart: vi.fn().mockRejectedValue(new Error("response lost")), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() });
    await store.start();
    expect(store.state.step).toBe(3);
    expect(store.state.error).toBeNull();
    expect(store.state.busy).toBe(false);
  });
  it("retries a failed migration and completes without losing the error report", async () => {
    const failed = { ...pending(), state: "failed" as const, errorCode: "BACKUP_FAILED", errorMessage: "Cannot create backup" };
    const retry = vi.fn().mockResolvedValue(report);
    const store = useMigrationStore({ migrationStatus: vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(done()), migrationStart: vi.fn().mockRejectedValue(new Error("failure")), migrationRetry: retry, migrationCleanupBackups: vi.fn() });
    await store.start();
    expect(store.state.errorCode).toBe("BACKUP_FAILED");
    expect(store.diagnostic().actionError).toBe("migrationFailed");
    await store.retry();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.state.step).toBe(3);
    expect(store.state.error).toBeNull();
  });
});
