// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { describe, it, expect, vi } from "vitest";
import { useMigrationStore } from "@/stores/migrationStore";
import Wizard from "./SecurityMigrationWizard.vue";
const mocks = vi.hoisted(() => ({ save: vi.fn().mockRejectedValue(new Error("unavailable")) }));
vi.mock("@/lib/backend/api", () => ({}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/i18n", () => ({ setLocale: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "en" }) }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: mocks.save }));
describe("migration failure actions", () => {
  it("shows a redacted diagnostic even when file saving fails and routes status retries correctly", async () => {
    const backend = { migrationStatus: vi.fn().mockRejectedValue(new Error("private transport detail")), migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() };
    const store = useMigrationStore(backend);
    await store.initialize();
    store.state.step = 2;
    const root = document.createElement("div");
    const app = createApp(Wizard, { store });
    app.mount(root);
    try {
      expect(root.querySelector("main")?.classList.contains("overflow-y-auto")).toBe(true);
      expect(root.querySelector("section")?.classList.contains("my-auto")).toBe(true);
      const button = (label: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label)!;
      expect(root.querySelector("textarea")?.value).toContain("statusFailed");
      button("migration.exportDiagnostic").click();
      await nextTick();
      await nextTick();
      expect(mocks.save).toHaveBeenCalledWith(expect.any(String), "dbx-migration-diagnostic.json", "JSON", "json");
      expect(root.querySelector("textarea")?.value).toContain("statusFailed");
      expect(root.querySelector("textarea")?.value).not.toContain("private transport detail");
      button("migration.retryStatus").click();
      await nextTick();
      expect(backend.migrationStatus).toHaveBeenCalledTimes(2);
      expect(backend.migrationStatus).toHaveBeenNthCalledWith(1, false);
      expect(backend.migrationStatus).toHaveBeenNthCalledWith(2, true);
      expect(backend.migrationRetry).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });

  it("updates the visible diagnostic after a failed action refreshes migration status", async () => {
    const pendingStatus = {
      migrationId: "secret-store-v1",
      state: "pending" as const,
      needsMigration: true,
      keyRecoveryRequired: false,
      keyProviderAvailable: true,
      databasePlaintextCount: 1,
      connectionCount: 1,
      pluginSecretCount: 0,
      aiSecretCount: 0,
      tunnelSecretCount: 0,
      syncCredentialCount: 0,
      legacyJsonFiles: [],
      backupRequired: false,
    };
    const failedStatus = { ...pendingStatus, state: "failed" as const, errorCode: "LEGACY_JSON_INVALID", errorMessage: "Repair connections.json" };
    const status = vi.fn().mockResolvedValueOnce(pendingStatus).mockResolvedValueOnce(failedStatus);
    const backend = { migrationStatus: status, migrationStart: vi.fn().mockRejectedValue(new Error("request failed")), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() };
    const store = useMigrationStore(backend);
    await store.initialize();
    const root = document.createElement("div");
    const app = createApp(Wizard, { store });
    app.mount(root);
    try {
      const start = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === "migration.start")!;
      start.click();
      await vi.waitFor(() => expect(root.querySelector("textarea")?.value).toContain("LEGACY_JSON_INVALID"));
      expect(root.querySelector("textarea")?.value).toContain('"state": "failed"');
    } finally {
      app.unmount();
    }
  });

  it("treats a locked key after migration as key recovery instead of retrying migration", async () => {
    const recoveryStatus = {
      migrationId: "secret-store-v1",
      state: "succeeded" as const,
      needsMigration: false,
      keyRecoveryRequired: true,
      keyProviderAvailable: false,
      keyCreationAllowed: false,
      keyStatus: "unavailable" as const,
      databasePlaintextCount: 0,
      connectionCount: 1,
      pluginSecretCount: 0,
      aiSecretCount: 0,
      tunnelSecretCount: 0,
      syncCredentialCount: 0,
      legacyJsonFiles: [],
      backupRequired: false,
      errorCode: "KEYRING_ACCESS_FAILED",
      errorMessage: "The platform credential store refused access",
    };
    const backend = {
      migrationStatus: vi.fn().mockResolvedValue(recoveryStatus),
      migrationStart: vi.fn(),
      migrationRetry: vi.fn(),
      migrationCleanupBackups: vi.fn(),
    };
    const store = useMigrationStore(backend);
    await store.initialize();
    const root = document.createElement("div");
    const app = createApp(Wizard, { store });
    app.mount(root);
    try {
      const labels = Array.from(root.querySelectorAll("button")).map((button) => button.textContent);
      expect(root.textContent).toContain("migration.recoveryIntro");
      expect(root.textContent).not.toContain("migration.failed");
      expect(labels).toContain("migration.recheckKey");
      expect(labels).not.toContain("migration.start");
      expect(labels).not.toContain("migration.retryMigration");
      expect(root.querySelector("textarea")?.value).toContain('"keyRecoveryRequired": true');
    } finally {
      app.unmount();
    }
  });
});

it("requires the acknowledgement before resetting and keeps reset backups out of cleanup", async () => {
  const recovery = {
    migrationId: "secret-store-v1",
    state: "succeeded" as const,
    needsMigration: false,
    keyRecoveryRequired: true,
    credentialResetAllowed: true,
    encryptedRecordCount: 19,
    keyProviderAvailable: false,
    databasePlaintextCount: 0,
    connectionCount: 16,
    pluginSecretCount: 0,
    aiSecretCount: 0,
    tunnelSecretCount: 0,
    syncCredentialCount: 0,
    legacyJsonFiles: [],
    backupRequired: false,
  };
  const backend = {
    migrationStatus: vi.fn().mockResolvedValue(recovery),
    migrationStart: vi.fn(),
    migrationRetry: vi.fn(),
    migrationCleanupBackups: vi.fn(),
    migrationPrepareCredentialReset: vi.fn().mockResolvedValue({ confirmationToken: "token", encryptedRecordCount: 19 }),
    migrationResetCredentials: vi.fn().mockResolvedValue({ backupPath: "/tmp/reset-backup", clearedRecordCount: 19, state: "succeeded" }),
  };
  const store = useMigrationStore(backend);
  await store.initialize();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(Wizard, { store });
  app.mount(root);
  const button = (label: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label)!;
  try {
    expect(root.textContent).not.toContain("migration.step1");
    expect(root.textContent).not.toContain("migration.backupRequiredLabel");
    expect(root.textContent).toContain("migration.encryptedRecordCountLabel 19");
    button("migration.resetEntry").click();
    await vi.waitFor(() => expect(root.querySelector('[role="alertdialog"]')).not.toBeNull());
    await nextTick();
    expect(document.activeElement).toBe(button("migration.cancel"));
    expect(button("migration.resetConfirm").disabled).toBe(true);
    const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await nextTick();
    expect(button("migration.resetConfirm").disabled).toBe(false);
    backend.migrationStatus.mockResolvedValue({ ...recovery, keyRecoveryRequired: false });
    button("migration.resetConfirm").click();
    await vi.waitFor(() => expect(root.textContent).toContain("migration.resetSuccessIntro"));
    expect(root.textContent).toContain("/tmp/reset-backup");
    expect(root.textContent).not.toContain("migration.deleteBackup");
  } finally {
    app.unmount();
    root.remove();
  }
});

it("shows postcheck failure and backup even when refreshed status allows entry", async () => {
  const backend = { migrationStatus: vi.fn(), migrationStart: vi.fn(), migrationRetry: vi.fn(), migrationCleanupBackups: vi.fn() };
  const store = useMigrationStore(backend);
  store.state.loading = false;
  store.state.step = 3;
  store.state.resetFailure = { code: "CREDENTIAL_RESET_POSTCHECK_FAILED", stage: "postcheck", backupPath: "/tmp/retained-reset-backup" };
  store.state.error = "resetFailed";
  const root = document.createElement("div");
  const app = createApp(Wizard, { store });
  app.mount(root);
  try {
    expect(root.textContent).toContain("migration.resetReadyAfterFailure");
    expect(root.textContent).toContain("CREDENTIAL_RESET_POSTCHECK_FAILED (postcheck)");
    expect(root.textContent).toContain("/tmp/retained-reset-backup");
    expect(root.textContent).not.toContain("migration.successTitle");
    expect(root.textContent).not.toContain("migration.resetSuccessTitle");
    expect(root.textContent).toContain("migration.enter");
  } finally {
    app.unmount();
  }
});
