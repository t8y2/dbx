import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { webdavSyncUpload } from "@/lib/backend/api";
import { readWebDavAutoUploadConfig, WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS } from "@/lib/webdav/webdavAutoUploadConfig";

export function useWebDavAutoUpload() {
  const settingsStore = useSettingsStore();
  let timer: ReturnType<typeof window.setInterval> | undefined;
  let uploading = false;

  function clearTimer() {
    if (!timer) return;
    window.clearInterval(timer);
    timer = undefined;
  }

  function schedule() {
    clearTimer();
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return;

    timer = window.setInterval(() => {
      void runAutoUpload();
    }, config.intervalMinutes * 60_000);
  }

  async function runAutoUpload() {
    if (uploading) return;
    const config = readWebDavAutoUploadConfig();
    if (!config.enabled || !config.webDavConfig) return;

    uploading = true;
    try {
      const summary = await webdavSyncUpload(config.webDavConfig, settingsStore.editorSettings);
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
