import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { webdavSyncSecretsStatus, webdavSyncUpload } from "@/lib/backend/api";
import { readWebDavAutoUploadConfig, readWebDavBackupSelection, readWebDavLastUploadAt, recordWebDavSyncSuccess, webDavSyncTarget, writeWebDavLastUploadAt, type WebDavAutoUploadConfig, WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS } from "@/lib/webdav/webdavAutoUploadConfig";

export function useWebDavAutoUpload() {
  const settingsStore = useSettingsStore();
  const maxTimeoutDelayMs = 2_147_000_000;
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  let timerSequence = 0;
  let nextUploadAt = 0;
  let uploading = false;

  function clearTimer() {
    timerSequence++;
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  }

  function computeNextUploadAt(config: WebDavAutoUploadConfig): number {
    const intervalMs = config.intervalMinutes * 60_000;
    const lastUploadAt = readWebDavLastUploadAt(config.webDavConfig);
    const now = Date.now();
    if (lastUploadAt === null) {
      if (config.webDavConfig) {
        writeWebDavLastUploadAt(config.webDavConfig, now, false);
      }
      return now + intervalMs;
    }
    if (lastUploadAt > now) {
      return now + intervalMs;
    }
    return lastUploadAt + intervalMs;
  }

  function armTimer() {
    clearTimer();
    const sequence = timerSequence;
    const remainingMs = Math.max(0, nextUploadAt - Date.now());
    timer = window.setTimeout(
      async () => {
        if (sequence !== timerSequence) return;
        timer = undefined;

        if (Date.now() < nextUploadAt) {
          armTimer();
          return;
        }

        const success = await runAutoUpload(sequence);
        if (sequence !== timerSequence) return;

        const config = readWebDavAutoUploadConfig();
        if (!config.enabled || !config.webDavConfig) {
          return;
        }

        const intervalMs = config.intervalMinutes * 60_000;
        if (success) {
          nextUploadAt = (readWebDavLastUploadAt(config.webDavConfig) ?? Date.now()) + intervalMs;
        } else {
          const retryDelayMs = Math.min(intervalMs, 5 * 60_000);
          nextUploadAt = Date.now() + retryDelayMs;
        }
        armTimer();
      },
      Math.min(remainingMs, maxTimeoutDelayMs),
    );
  }

  function schedule() {
    clearTimer();
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return;

    nextUploadAt = computeNextUploadAt(config);
    armTimer();
  }

  async function runAutoUpload(expectedSequence?: number): Promise<boolean> {
    if (uploading) return false;
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return false;

    const requestConfig = { ...config.webDavConfig };
    const requestTarget = webDavSyncTarget(requestConfig);
    const startSequence = expectedSequence ?? timerSequence;

    uploading = true;
    try {
      const secretsStatus = await webdavSyncSecretsStatus();
      const selection = readWebDavBackupSelection();
      const includeSecrets = (selection?.includeSecrets ?? secretsStatus.enabled) && secretsStatus.enabled && secretsStatus.hasSavedPassphrase;
      const summary = await webdavSyncUpload(requestConfig, settingsStore.editorSettings, undefined, includeSecrets, selection);

      const currentConfig = readWebDavAutoUploadConfig();
      const isStillCurrent = Boolean(startSequence === timerSequence && currentConfig.enabled && currentConfig.webDavConfig && webDavSyncTarget(currentConfig.webDavConfig) === requestTarget);

      recordWebDavSyncSuccess(requestConfig);
      writeWebDavLastUploadAt(requestConfig, Date.now(), false);
      appendDebugLog("info", "[DBX][webdav:auto-upload:success]", {
        bytes: summary.bytes,
        remotePath: summary.remotePath,
        exportedAt: summary.exportedAt,
      });
      return isStillCurrent;
    } catch (error) {
      appendDebugLog("error", "[DBX][webdav:auto-upload:error]", error);
      return false;
    } finally {
      uploading = false;
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key && !WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS.includes(event.key as (typeof WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS)[number])) return;
    schedule();
  }

  onMounted(() => {
    schedule();
    window.addEventListener("storage", onStorage);
    window.addEventListener("dbx:webdav-auto-upload-config-changed", schedule);
  });

  onUnmounted(() => {
    clearTimer();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("dbx:webdav-auto-upload-config-changed", schedule);
  });

  return {
    scheduleWebDavAutoUpload: schedule,
    runWebDavAutoUpload: runAutoUpload,
  };
}
