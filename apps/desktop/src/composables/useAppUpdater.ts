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
  return isDesktop && info?.update_available === true && info.manual_update_only !== true;
}

interface ParsedUpdateVersion {
  core: [string, string, string];
  prerelease: string[];
}

function normalizeUpdateVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

function parseUpdateVersion(version: string): ParsedUpdateVersion | null {
  const match = normalizeUpdateVersion(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareNumericVersionIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareParsedUpdateVersions(left: ParsedUpdateVersion, right: ParsedUpdateVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericVersionIdentifier(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericVersionIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function isUpdateIgnored(info: api.UpdateInfo | null, ignoredVersion: string | undefined): boolean {
  const latest = info?.latest_version;
  if (!latest || !ignoredVersion) return false;
  const parsedLatest = parseUpdateVersion(latest);
  const parsedIgnored = parseUpdateVersion(ignoredVersion);
  if (!parsedLatest || !parsedIgnored) return normalizeUpdateVersion(latest) === normalizeUpdateVersion(ignoredVersion);
  return compareParsedUpdateVersions(parsedLatest, parsedIgnored) <= 0;
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
  const isIgnoringUpdate = ref(false);
  const activeTaskCount = computed(() => Math.max(0, Math.trunc(options.getActiveTaskCount?.() ?? 0)));
  const hasUpdateAvailable = computed(() => updateInfo.value?.update_available === true && !isUpdateIgnored(updateInfo.value, settingsStore.editorSettings.ignoredUpdateVersion));
  const latestReleaseUrl = "https://github.com/t8y2/dbx/releases/latest";
  let activeDownloadAttempt = 0;
  let pendingCancellation: Promise<void> | undefined;

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
    if (lower.includes("canceled") || lower.includes("cancelled")) {
      return t("updates.downloadCanceled");
    }
    if (lower.includes("403") || lower.includes("rate limit")) {
      return t("updates.rateLimited");
    }
    if (lower.includes("stalled") || lower.includes("timeout") || lower.includes("all available mirrors") || lower.includes("error sending request") || lower.includes("failed to download")) {
      return t("updates.networkOrMirrorFailed");
    }
    return t("updates.downloadFailed", { error: message });
  }

  function openLatestRelease() {
    const url = resolveUpdateReleaseUrl(updateInfo.value, settingsStore.editorSettings.updateDownloadSource, latestReleaseUrl);
    openUrl(url);
  }

  async function ignoreCurrentVersion() {
    const latest = updateInfo.value?.latest_version;
    if (!latest || isIgnoringUpdate.value) return;
    isIgnoringUpdate.value = true;
    try {
      await settingsStore.updateEditorSettingsAndPersist({ ignoredUpdateVersion: latest });
      showUpdateDialog.value = false;
      toast(t("updates.versionIgnored", { version: tagVersion(latest) }), 5000);
    } catch (error) {
      toast(t("updates.ignoreVersionFailed", { error: error instanceof Error ? error.message : String(error) }), 5000);
    } finally {
      isIgnoringUpdate.value = false;
    }
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
    const attempt = ++activeDownloadAttempt;
    isDownloadingUpdate.value = true;
    downloadProgress.value = 0;
    let unlisten: (() => void) | undefined;
    const latestVersion = updateInfo.value?.latest_version;
    try {
      await pendingCancellation;
      if (attempt !== activeDownloadAttempt) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateDownloadProgress>("update-download-progress", (event) => {
        if (attempt !== activeDownloadAttempt) return;
        const total = event.payload.total ?? 0;
        downloadProgress.value = total > 0 ? Math.round((event.payload.downloaded / total) * 100) : 0;
      });
      const result = await downloadAndInstallUpdateWhenIdle({
        getActiveTaskCount: () => activeTaskCount.value,
        download: async () => {
          await api.downloadUpdate(normalizeUpdateDownloadSource(settingsStore.editorSettings.updateDownloadSource), latestVersion);
          if (attempt !== activeDownloadAttempt) throw new Error("Download canceled by user.");
          downloadProgress.value = 100;
          updateDownloaded.value = true;
          isDownloadingUpdate.value = false;
        },
        install: async () => {
          await installPendingUpdate();
        },
      });
      if (result === "blocked" || result === "downloaded") {
        blockUpdateForActiveTasks();
      }
    } catch (e: any) {
      if (attempt !== activeDownloadAttempt) return;
      downloadProgress.value = 0;
      const rawMsg = e?.message || String(e);
      console.error("[DBX update error]", rawMsg);
      const lower = rawMsg.toLowerCase();
      if (lower.includes("canceled") || lower.includes("cancelled")) {
        return;
      }
      toast(formatUpdateError(rawMsg), 5000);
    } finally {
      unlisten?.();
      if (attempt === activeDownloadAttempt) {
        isDownloadingUpdate.value = false;
      }
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

  async function cancelDownload() {
    if (isDownloadingUpdate.value) {
      activeDownloadAttempt += 1;
      isDownloadingUpdate.value = false;
      downloadProgress.value = 0;
      if (isTauriRuntime()) {
        const cancellation = api.cancelUpdateDownload().catch(() => {});
        pendingCancellation = cancellation;
        try {
          await cancellation;
        } finally {
          if (pendingCancellation === cancellation) {
            pendingCancellation = undefined;
          }
        }
      }
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
    isIgnoringUpdate,
    activeTaskCount,
    hasUpdateAvailable,
    latestReleaseUrl,
    openUrl,
    checkUpdates,
    formatUpdateError,
    openLatestRelease,
    ignoreCurrentVersion,
    downloadAndInstallUpdate,
    cancelDownload,
    installDownloadedUpdate,
    restartApp,
  };
}
