import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { webdavSyncSecretsStatus, webdavSyncUpload } from "@/lib/backend/api";
import { readWebDavAutoUploadConfig, readWebDavBackupSelection, WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS } from "@/lib/webdav/webdavAutoUploadConfig";

export function useWebDavAutoUpload() {
  const settingsStore = useSettingsStore();
  const maxTimeoutDelayMs = 2_147_000_000;
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  let nextUploadAt = 0;
  let uploading = false;

  function clearTimer() {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  }

  function armTimer() {
    const remainingMs = Math.max(0, nextUploadAt - Date.now());
    timer = window.setTimeout(
      () => {
        if (Date.now() < nextUploadAt) {
          armTimer();
          return;
        }

        void runAutoUpload();
        const config = readWebDavAutoUploadConfig();
        if (!config.enabled || !config.webDavConfig) {
          clearTimer();
          return;
        }
        nextUploadAt = Date.now() + config.intervalMinutes * 60_000;
        armTimer();
      },
      Math.min(remainingMs, maxTimeoutDelayMs),
    );
  }

  function schedule() {
    clearTimer();
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return;

    nextUploadAt = Date.now() + config.intervalMinutes * 60_000;
    armTimer();
  }

  async function runAutoUpload() {
    if (uploading) return;
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return;

    uploading = true;
    try {
      const secretsStatus = await webdavSyncSecretsStatus();
      const selection = readWebDavBackupSelection();
      const includeSecrets = (selection?.includeSecrets ?? secretsStatus.enabled) && secretsStatus.enabled && secretsStatus.hasSavedPassphrase;
      const summary = await webdavSyncUpload(config.webDavConfig, settingsStore.editorSettings, undefined, includeSecrets, selection);
      appendDebugLog("info", "[DBX][webdav:auto-upload:success]", {
        bytes: summary.bytes,
        remotePath: summary.remotePath,
        exportedAt: summary.exportedAt,
      });
    } catch (error) {
      appendDebugLog("error", "[DBX][webdav:auto-upload:error]", error);
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
