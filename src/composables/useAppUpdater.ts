import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/api";

export function useAppUpdater() {
  const { t } = useI18n();
  const { toast } = useToast();

  const checkingUpdates = ref(false);
  const updateInfo = ref<api.UpdateInfo | null>(null);
  const updateCheckMessage = ref("");
  const showUpdateDialog = ref(false);
  const isDownloadingUpdate = ref(false);
  const downloadProgress = ref(0);
  const updateReady = ref(false);
  const latestReleaseUrl = "https://github.com/t8y2/dbx/releases/latest";

  function openUrl(url: string) {
    if (isTauriRuntime()) {
      import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
    } else {
      window.open(url, "_blank");
    }
  }

  async function checkUpdates(options: { silent?: boolean } = {}) {
    if (checkingUpdates.value) return;
    checkingUpdates.value = true;
    updateCheckMessage.value = "";
    try {
      const info = await api.checkForUpdates();
      updateInfo.value = info;
      if (info.update_available) {
        showUpdateDialog.value = true;
      } else if (!options.silent) {
        updateCheckMessage.value = t("updates.upToDate", { version: info.current_version });
        showUpdateDialog.value = true;
      }
    } catch (e: any) {
      if (!options.silent) {
        updateCheckMessage.value = formatUpdateError(String(e));
        showUpdateDialog.value = true;
      }
    } finally {
      checkingUpdates.value = false;
    }
  }

  function formatUpdateError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("403") || lower.includes("rate limit")) {
      return t("updates.rateLimited");
    }
    return t("updates.failed", { error: message });
  }

  function openLatestRelease() {
    const url = updateInfo.value?.release_url || latestReleaseUrl;
    openUrl(url);
  }

  async function downloadAndInstallUpdate() {
    if (!isTauriRuntime() || isDownloadingUpdate.value) return;
    isDownloadingUpdate.value = true;
    downloadProgress.value = 0;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;
      let totalBytes = 0;
      let downloadedBytes = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          downloadProgress.value = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        } else if (event.event === "Finished") {
          downloadProgress.value = 100;
        }
      });
      updateReady.value = true;
    } catch (e: any) {
      toast(t("updates.downloadFailed", { error: e?.message || String(e) }), 5000);
    } finally {
      isDownloadingUpdate.value = false;
    }
  }

  async function restartApp() {
    if (!isTauriRuntime()) return;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }

  return {
    checkingUpdates,
    updateInfo,
    updateCheckMessage,
    showUpdateDialog,
    isDownloadingUpdate,
    downloadProgress,
    updateReady,
    latestReleaseUrl,
    openUrl,
    checkUpdates,
    formatUpdateError,
    openLatestRelease,
    downloadAndInstallUpdate,
    restartApp,
  };
}
