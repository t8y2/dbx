import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { s3CredentialsStatus, s3SyncUpload } from "@/lib/backend/api";
import { readS3AutoUploadConfig, S3_AUTO_UPLOAD_STORAGE_KEYS } from "@/lib/s3/s3AutoUploadConfig";

export function useS3AutoUpload() {
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
    const config = readS3AutoUploadConfig();
    if (!config.enabled || !config.s3Config) return;
    timer = window.setInterval(() => void runAutoUpload(), config.intervalMinutes * 60_000);
  }

  async function runAutoUpload() {
    if (uploading) return;
    const config = readS3AutoUploadConfig();
    if (!config.enabled || !config.s3Config) return;

    uploading = true;
    try {
      const status = await s3CredentialsStatus(config.s3Config);
      if (!status.hasSavedCredentials) {
        appendDebugLog("error", "[DBX][s3:auto-upload:error]", "Saved S3 credentials are required for auto upload.");
        return;
      }
      const summary = await s3SyncUpload(config.s3Config, settingsStore.editorSettings);
      appendDebugLog("info", "[DBX][s3:auto-upload:success]", {
        bytes: summary.bytes,
        bucket: summary.bucket,
        objectKey: summary.objectKey,
        exportedAt: summary.exportedAt,
      });
    } catch (error) {
      appendDebugLog("error", "[DBX][s3:auto-upload:error]", error);
    } finally {
      uploading = false;
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key && !S3_AUTO_UPLOAD_STORAGE_KEYS.includes(event.key as (typeof S3_AUTO_UPLOAD_STORAGE_KEYS)[number])) return;
    schedule();
  }

  onMounted(() => {
    schedule();
    window.addEventListener("storage", onStorage);
    window.addEventListener("dbx:s3-auto-upload-config-changed", schedule);
  });

  onUnmounted(() => {
    clearTimer();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("dbx:s3-auto-upload-config-changed", schedule);
  });

  return {
    scheduleS3AutoUpload: schedule,
    runS3AutoUpload: runAutoUpload,
  };
}
