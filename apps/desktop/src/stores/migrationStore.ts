import { computed, reactive } from "vue";
import * as api from "@/lib/backend/api";
import type { MigrationPreflight, MigrationReport } from "@/lib/backend/migration";

type MigrationApi = Pick<typeof api, "migrationStatus" | "migrationStart" | "migrationRetry" | "migrationCleanupBackups">;

// Each startup boundary owns its state; an action failure never erases its report.
export function useMigrationStore(backend: MigrationApi = api) {
  const state = reactive<{
    status: MigrationPreflight | null;
    report: MigrationReport | null;
    loading: boolean;
    busy: boolean;
    error: "statusFailed" | "migrationFailed" | "cleanupFailed" | null;
    errorCode: string | null;
    errorMessage: string | null;
    entered: boolean;
    step: 1 | 2 | 3;
  }>({ status: null, report: null, loading: true, busy: false, error: null, errorCode: null, errorMessage: null, entered: false, step: 1 });
  const completed = computed(() => state.status !== null && !state.status.needsMigration && ["succeeded", "not_required"].includes(state.status.state));
  // A managed data-directory key is intentionally created when migration
  // starts. Its absence during the read-only preflight is actionable, not a
  // migration failure, as long as the backend explicitly allows creation.
  const hasBlockingError = () => Boolean(state.errorCode && !(state.errorCode === "MISSING_MANAGED_KEY" && state.status?.keyCreationAllowed === true));
  const blocking = computed(() => state.loading || state.busy || state.error === "statusFailed" || !completed.value || (!state.entered && Boolean(state.report || state.status?.backupPath)));
  function clearError() {
    state.error = null;
    state.errorCode = null;
    state.errorMessage = null;
  }
  async function refreshStatus() {
    // Only this endpoint returns classified, redacted migration errors. Transport
    // exceptions may contain configuration values and must never enter UI state.
    state.status = await backend.migrationStatus();
    state.errorCode = state.status.errorCode ?? null;
    state.errorMessage = state.status.errorMessage ?? null;
  }
  async function initialize() {
    state.loading = true;
    clearError();
    try {
      await refreshStatus();
      state.step = completed.value ? 3 : 1;
      // A completed migration only needs the success page in the session that
      // performed it. On later launches, retained backups are recovery assets,
      // not a reason to block the normal application startup.
      state.entered = completed.value;
      if (state.status?.state === "failed" || hasBlockingError()) state.error = "migrationFailed";
    } catch {
      state.error = "statusFailed";
    } finally {
      state.loading = false;
    }
  }
  async function run(retry: boolean) {
    if (state.busy) return;
    state.busy = true;
    state.step = 2;
    clearError();
    try {
      state.report = await (retry ? backend.migrationRetry() : backend.migrationStart());
    } catch {
      state.error = "migrationFailed";
    }
    try {
      await refreshStatus();
      if (completed.value) {
        state.step = 3;
        state.error = null;
      }
      if (!completed.value || hasBlockingError()) state.error = "migrationFailed";
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
  function diagnostic() {
    const s = state.status;
    return {
      migrationId: s?.migrationId,
      actionError: state.error,
      step: state.step,
      needsMigration: s?.needsMigration,
      legacyJsonFiles: s?.legacyJsonFiles,
      state: s?.state,
      counts: s ? { connections: s.connectionCount, databasePlaintext: s.databasePlaintextCount, plugin: s.pluginSecretCount, ai: s.aiSecretCount, tunnel: s.tunnelSecretCount, sync: s.syncCredentialCount } : {},
      keyProviderAvailable: s?.keyProviderAvailable,
      backupPath: s?.backupPath,
      errorCode: state.errorCode,
    };
  }
  function enter() {
    if (completed.value && !state.busy) state.entered = true;
  }
  return { state, blocking, completed, initialize, start: () => run(false), retry: () => run(true), cleanup, diagnostic, enter };
}
