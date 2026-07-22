import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { useSettingsStore } from "@/stores/settingsStore";
import type { UpdateDownloadSource as SettingsUpdateDownloadSource } from "@/stores/settingsStore";
import type { UpdateDownloadProgress } from "@/lib/backend/tauri";
import { currentLocale } from "@/i18n";
import { shouldBlockAppUpdate } from "@/lib/app/appUpdateTaskGuard";
import { downloadAndInstallUpdateWhenIdle, installDownloadedUpdateWhenIdle } from "@/lib/app/appUpdateInstallFlow";

interface UseAppUpdaterOptions {
  getActiveTaskCount?: () => number;
}

export function shouldOpenUpdateDialog(options: { silent?: boolean }) {
  return options.silent !== true;
}

export function canDownloadAndInstallUpdate(info: api.UpdateInfo | null, isDesktop: boolean) {
  return isDesktop && info?.update_available === true;
}

export function normalizeUpdateDownloadSource(value: unknown): SettingsUpdateDownloadSource {
  // Old persisted AtomGit preferences should retain their mainland mirror behavior.
  if (value === "atomgit") return "cnb";
  return value === "cnb" ? "cnb" : "official";
}

export function tagVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function resolveUpdateReleaseUrl(info: api.UpdateInfo | null, source: unknown, fallbackUrl: string): string {
  const normalizedSource = normalizeUpdateDownloadSource(source);
  if (normalizedSource === "cnb" && info?.latest_version) {
    return `https://cnb.cool/dbxio.com/dbx/-/releases/tag/${tagVersion(info.latest_version)}`;
  }
  return info?.release_url || fallbackUrl;
}

export async function resolveUpdaterProxy(): Promise<string | undefined> {
  if (!isTauriRuntime()) return undefined;
  try {
    const proxy = await api.getSystemProxyUrl();
    return proxy || undefined;
  } catch {
    return undefined;
  }
}

export function useAppUpdater(options: UseAppUpdaterOptions = {}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const settingsStore = useSettingsStore();

  const checkingUpdates = ref(false);
  const updateInfo = ref<api.UpdateInfo | null>(null);
  const updateCheckMessage = ref("");
  const showUpdateDialog = ref(false);
  const isDownloadingUpdate = ref(false);
  const downloadProgress = ref(0);
  const updateDownloaded = ref(false);
  const isInstallingUpdate = ref(false);
  const updateReady = ref(false);
  const activeTaskCount = computed(() => Math.max(0, Math.trunc(options.getActiveTaskCount?.() ?? 0)));
  const hasUpdateAvailable = computed(() => updateInfo.value?.update_available === true);
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
      const info = await api.checkForUpdates(currentLocale(), normalizeUpdateDownloadSource(settingsStore.editorSettings.updateDownloadSource));
      updateInfo.value = info;
      if (info.update_available) {
        if (shouldOpenUpdateDialog({ silent: options.silent })) {
          showUpdateDialog.value = true;
        }
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
    const url = resolveUpdateReleaseUrl(updateInfo.value, settingsStore.editorSettings.updateDownloadSource, latestReleaseUrl);
    openUrl(url);
  }

  function blockUpdateForActiveTasks(): boolean {
    if (!shouldBlockAppUpdate(activeTaskCount.value)) return false;
    toast(t("updates.activeTasksBlockUpdate", { count: activeTaskCount.value }), 5000);
    return true;
  }

  async function downloadAndInstallUpdate() {
    if (!isTauriRuntime() || isDownloadingUpdate.value || isInstallingUpdate.value || updateDownloaded.value || updateReady.value) return;
    if (!canDownloadAndInstallUpdate(updateInfo.value, true)) {
      openLatestRelease();
      return;
    }
    if (blockUpdateForActiveTasks()) return;
    isDownloadingUpdate.value = true;
    downloadProgress.value = 0;
    let unlisten: (() => void) | undefined;
    const latestVersion = updateInfo.value?.latest_version;
    let failureMessageKey = "updates.downloadFailed";
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateDownloadProgress>("update-download-progress", (event) => {
        const total = event.payload.total ?? 0;
        downloadProgress.value = total > 0 ? Math.round((event.payload.downloaded / total) * 100) : 0;
      });
      const result = await downloadAndInstallUpdateWhenIdle({
        getActiveTaskCount: () => activeTaskCount.value,
        download: async () => {
          try {
            await api.downloadUpdate(normalizeUpdateDownloadSource(settingsStore.editorSettings.updateDownloadSource), latestVersion);
            downloadProgress.value = 100;
            updateDownloaded.value = true;
          } finally {
            isDownloadingUpdate.value = false;
          }
        },
        install: async () => {
          failureMessageKey = "updates.installFailed";
          await installPendingUpdate();
        },
      });
      if (result === "blocked" || result === "downloaded") {
        blockUpdateForActiveTasks();
      }
    } catch (e: any) {
      toast(t(failureMessageKey, { error: e?.message || String(e) }), 5000);
    } finally {
      unlisten?.();
      isDownloadingUpdate.value = false;
    }
  }

  async function installPendingUpdate() {
    isInstallingUpdate.value = true;
    try {
      const portableMode = updateInfo.value?.portable_mode === true;
      await api.installDownloadedUpdate();
      updateDownloaded.value = false;
      // The portable helper exits and relaunches DBX after the invoke response is delivered.
      updateReady.value = !portableMode;
    } finally {
      isInstallingUpdate.value = false;
    }
  }

  async function installDownloadedUpdate() {
    if (!isTauriRuntime() || isDownloadingUpdate.value || isInstallingUpdate.value || !updateDownloaded.value) return;
    try {
      const installed = await installDownloadedUpdateWhenIdle({
        getActiveTaskCount: () => activeTaskCount.value,
        install: installPendingUpdate,
      });
      if (!installed) blockUpdateForActiveTasks();
    } catch (e: any) {
      toast(t("updates.installFailed", { error: e?.message || String(e) }), 5000);
    }
  }

  async function restartApp() {
    if (!isTauriRuntime()) return;
    if (blockUpdateForActiveTasks()) return;
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: any) {
      toast(t("updates.restartFailed", { error: e?.message || String(e) }), 5000);
    }
  }

  return {
    checkingUpdates,
    updateInfo,
    updateCheckMessage,
    showUpdateDialog,
    isDownloadingUpdate,
    downloadProgress,
    updateDownloaded,
    isInstallingUpdate,
    updateReady,
    activeTaskCount,
    hasUpdateAvailable,
    latestReleaseUrl,
    openUrl,
    checkUpdates,
    formatUpdateError,
    openLatestRelease,
    downloadAndInstallUpdate,
    installDownloadedUpdate,
    restartApp,
  };
}
