import { computed, reactive, ref } from "vue";
import * as api from "@/lib/backend/api";
import type { MigrationPreflight, MigrationReport, CredentialResetPreparation, CredentialResetReport, CredentialResetFailure } from "@/lib/backend/migration";

type MigrationApi = Pick<typeof api, "migrationStatus" | "migrationStart" | "migrationRetry" | "migrationCleanupBackups"> & Partial<Pick<typeof api, "migrationPrepareCredentialReset" | "migrationResetCredentials">>;

// Each startup boundary owns its state; an action failure never erases its report.
export function useMigrationStore(backend: MigrationApi = api) {
  const state = reactive<{
    resetPreparation: CredentialResetPreparation | null;
    resetReport: CredentialResetReport | null;
    resetFailure: CredentialResetFailure | null;
    status: MigrationPreflight | null;
    report: MigrationReport | null;
    loading: boolean;
    busy: boolean;
    error: "statusFailed" | "migrationFailed" | "keyRecoveryRequired" | "cleanupFailed" | "resetFailed" | null;
    errorCode: string | null;
    errorMessage: string | null;
    entered: boolean;
    step: 1 | 2 | 3;
  }>({ resetPreparation: null, resetReport: null, resetFailure: null, status: null, report: null, loading: true, busy: false, error: null, errorCode: null, errorMessage: null, entered: false, step: 1 });
  const migrationAttempted = ref(false);
  const completed = computed(() => state.status !== null && !state.status.needsMigration && !state.status.keyRecoveryRequired && ["succeeded", "not_required"].includes(state.status.state));
  // A managed data-directory key is intentionally created when migration
  // starts. Its absence during the read-only preflight is actionable, not a
  // migration failure, as long as the backend explicitly allows creation.
  const hasBlockingError = () => Boolean(state.errorCode && state.status?.keyStatus !== "will_create" && !(state.errorCode === "MISSING_MANAGED_KEY" && state.status?.keyCreationAllowed === true));
  // A retained backup is a recovery asset and must not make the success page
  // reappear on later launches. An attempt in this session keeps the wizard
  // visible even when its response is lost, until the user enters the app.
  const blocking = computed(() => state.loading || state.busy || state.error === "statusFailed" || !completed.value || (!state.entered && (migrationAttempted.value || Boolean(state.report) || Boolean(state.resetReport))));
  function clearError() {
    state.error = null;
    state.errorCode = null;
    state.errorMessage = null;
  }
  async function refreshStatus(retry = false) {
    // Only this endpoint returns classified, redacted migration errors. Transport
    // exceptions may contain configuration values and must never enter UI state.
    state.status = await backend.migrationStatus(retry);
    state.errorCode = state.status.errorCode ?? null;
    state.errorMessage = state.status.errorMessage ?? null;
  }
  async function checkStatus(retry: boolean) {
    if (state.busy || (state.loading && state.status !== null)) return;
    state.resetPreparation = null;
    state.loading = true;
    clearError();
    try {
      await refreshStatus(retry);
      state.step = completed.value ? 3 : 1;
      // A completed migration only needs the success page in the session that
      // performed it. On later launches, retained backups are recovery assets,
      // not a reason to block the normal application startup. `entered` is
      // therefore only changed by the explicit success-page action below.
      state.entered = false;
      if (state.status?.keyRecoveryRequired) state.error = "keyRecoveryRequired";
      else if (state.status?.state === "failed" || hasBlockingError()) state.error = "migrationFailed";
    } catch {
      state.error = "statusFailed";
    } finally {
      state.loading = false;
    }
  }
  const initialize = () => checkStatus(false);
  const retryStatus = () => checkStatus(true);
  async function run(retry: boolean) {
    if (state.busy) return;
    state.busy = true;
    migrationAttempted.value = true;
    state.step = 2;
    clearError();
    try {
      state.report = await (retry ? backend.migrationRetry() : backend.migrationStart());
    } catch {
      state.error = "migrationFailed";
    }
    try {
      await refreshStatus();
      if (state.status?.keyRecoveryRequired) {
        state.step = 1;
        state.error = "keyRecoveryRequired";
      } else if (completed.value) {
        state.step = 3;
        state.error = null;
      } else if (hasBlockingError()) {
        state.error = "migrationFailed";
      }
    } catch {
      state.error = "statusFailed";
    } finally {
      state.busy = false;
    }
  }
  async function cleanup() {
    if (state.busy) return;
    state.busy = true;
    clearError();
    try {
      await backend.migrationCleanupBackups();
      if (state.status) state.status.backupPath = null;
      if (state.report) state.report.backupPath = null;
    } catch {
      state.error = "cleanupFailed";
    } finally {
      state.busy = false;
    }
  }
  function resetFailure(error: unknown) {
    // Only accept the structured, redacted desktop error contract; never expose
    // arbitrary transport exceptions or the confirmation token in diagnostics.
    const value = error as Partial<CredentialResetFailure> | null;
    state.resetFailure =
      value && typeof value.code === "string" && /^[A-Z_]+$/.test(value.code) && typeof value.stage === "string" && /^[a-z_]+$/.test(value.stage)
        ? { code: value.code, stage: value.stage, backupPath: typeof value.backupPath === "string" ? value.backupPath : null }
        : { code: "CREDENTIAL_RESET_FAILED", stage: "unknown" };
    state.error = "resetFailed";
  }
  async function prepareCredentialReset() {
    if (state.busy || state.loading || !state.status?.credentialResetAllowed || !backend.migrationPrepareCredentialReset) return;
    state.busy = true;
    state.resetPreparation = null;
    state.resetFailure = null;
    try {
      const preparation = await backend.migrationPrepareCredentialReset();
      await refreshStatus(true);
      if (state.status?.credentialResetAllowed) state.resetPreparation = preparation;
      state.step = completed.value ? 3 : 1;
    } catch (error) {
      resetFailure(error);
      try {
        await refreshStatus(true);
      } catch {
        state.error = "statusFailed";
      }
    } finally {
      state.busy = false;
    }
  }
  async function resetCredentials(confirmed: boolean) {
    if (!confirmed || state.busy || state.loading || !state.resetPreparation || !backend.migrationResetCredentials) return;
    const token = state.resetPreparation.confirmationToken;
    migrationAttempted.value = true;
    state.resetPreparation = null;
    state.busy = true;
    state.resetFailure = null;
    clearError();
    try {
      state.resetReport = await backend.migrationResetCredentials(token, true);
    } catch (error) {
      resetFailure(error);
    }
    try {
      await refreshStatus(true);
      state.step = completed.value ? 3 : 1;
      if (!state.resetFailure && state.status?.keyRecoveryRequired) state.error = "keyRecoveryRequired";
    } catch {
      state.error = "statusFailed";
    } finally {
      state.busy = false;
    }
  }
  function cancelCredentialReset() {
    if (!state.busy) state.resetPreparation = null;
  }
  function diagnostic() {
    const s = state.status;
    return {
      migrationId: s?.migrationId,
      actionError: state.error,
      step: state.step,
      needsMigration: s?.needsMigration,
      keyRecoveryRequired: s?.keyRecoveryRequired,
      encryptedRecordCount: s?.encryptedRecordCount,
      credentialResetAllowed: s?.credentialResetAllowed,
      credentialResetBlockedReason: s?.credentialResetBlockedReason,
      credentialResetFailure: state.resetFailure,
      credentialResetReport: state.resetReport,
      legacyJsonFiles: s?.legacyJsonFiles,
      state: s?.state,
      counts: s ? { connections: s.connectionCount, databasePlaintext: s.databasePlaintextCount, plugin: s.pluginSecretCount, ai: s.aiSecretCount, tunnel: s.tunnelSecretCount, sync: s.syncCredentialCount } : {},
      keyProviderAvailable: s?.keyProviderAvailable,
      keyStatus: s?.keyStatus,
      backupPath: s?.backupPath,
      errorCode: state.errorCode,
    };
  }
  function enter() {
    if (completed.value && !state.busy) state.entered = true;
  }
  return { state, blocking, completed, initialize, retryStatus, start: () => run(false), retry: () => run(true), cleanup, diagnostic, enter, prepareCredentialReset, resetCredentials, cancelCredentialReset };
}
