import { computed, ref, watch, onScopeDispose } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { useSettingsStore } from "@/stores/settingsStore";
import type { UpdateDownloadSource as SettingsUpdateDownloadSource } from "@/stores/settingsStore";
import type { UpdateDownloadProgress } from "@/lib/backend/tauri";
import { currentLocale } from "@/i18n";
import { shouldBlockAppUpdate } from "@/lib/app/appUpdateTaskGuard";

interface UseAppUpdaterOptions {
  getActiveTaskCount?: () => number;
  prepareForUpdate?: () => Promise<() => void>;
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
  if (normalizedSource === "cnb") return "https://cnb.cool/dbxio.com/dbx/-/releases";
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
  const settingsStore = useSettingsStore();
  type Phase = "idle" | "checking" | "downloading" | "ready" | "preparing" | "installing" | "restart";
  const phase = ref<Phase>("idle");
  const downloaded = ref<api.DownloadedUpdate | null>(null);
  const updateInfo = ref<api.UpdateInfo | null>(null);
  const updateCheckMessage = ref("");
  const updateCheckFailed = ref(false);
  const showUpdateDialog = ref(false);
  const downloadProgress = ref<number | null>(null);
  const isIgnoringUpdate = ref(false);
  const checkingUpdates = computed(() => phase.value === "checking");
  const isDownloadingUpdate = computed(() => phase.value === "downloading");
  const updateDownloaded = computed(() => downloaded.value !== null);
  const isPreparingUpdate = computed(() => phase.value === "preparing");
  const isInstallingUpdate = computed(() => phase.value === "installing" || isPreparingUpdate.value);
  const updateReady = computed(() => phase.value === "restart");
  const activeTaskCount = computed(() => Math.max(0, Math.trunc(options.getActiveTaskCount?.() ?? 0)));
  const notificationsEnabled = computed(() => settingsStore.editorSettings.updateNotificationsEnabled !== false);
  const hasUpdateAvailable = computed(
    () => notificationsEnabled.value && (updateDownloaded.value || updateReady.value || (updateInfo.value?.update_available === true && (!isTauriRuntime() || updateInfo.value.manual_update_only))) && !isUpdateIgnored(updateInfo.value, settingsStore.editorSettings.ignoredUpdateVersion),
  );
  const latestReleaseUrl = "https://github.com/t8y2/dbx/releases/latest";
  let generation = 0;
  let activeDownload: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;
  let cancelOperation: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hourlyTimer: ReturnType<typeof setInterval> | undefined;
  let retries = 0;
  let initialized = false;
  let disposed = false;
  let versionRecheckPending = false;
  let updatePreparationRelease: (() => void) | undefined;

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  function fail(error: unknown) {
    updateCheckFailed.value = true;
    updateCheckMessage.value = formatUpdateError(error instanceof Error ? error.message : String(error));
  }
  function clearError() {
    updateCheckFailed.value = false;
    updateCheckMessage.value = "";
  }
  function scheduleRetry() {
    clearRetry();
    if (!initialized || disposed || !notificationsEnabled.value || retries >= 3) return;
    const delay = [60_000, 300_000, 900_000][retries++];
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void checkUpdates({ silent: true });
    }, delay);
  }
  function setDownloaded(cache: api.DownloadedUpdate) {
    downloaded.value = cache;
    updateInfo.value = {
      current_version: updateInfo.value?.current_version ?? "",
      latest_version: cache.version,
      update_available: true,
      portable_mode: cache.portable_mode,
      manual_update_only: false,
      release_name: tagVersion(cache.version),
      release_url: cache.release_url,
      release_notes: cache.release_notes,
    };
    phase.value = "ready";
    downloadProgress.value = 100;
    retries = 0;
    clearRetry();
    clearError();
  }
  function openUrl(url: string) {
    if (isTauriRuntime()) void import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
    else window.open(url, "_blank", "noopener,noreferrer");
  }
  function openLatestRelease() {
    openUrl(resolveUpdateReleaseUrl(updateInfo.value, settingsStore.editorSettings.updateDownloadSource, latestReleaseUrl));
  }
  function formatUpdateError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("cancel")) return t("updates.downloadCanceled");
    if (lower.includes("403") || lower.includes("rate limit")) return t("updates.rateLimited");
    if (["stalled", "timeout", "all available mirrors", "error sending request", "failed to download"].some((part) => lower.includes(part))) return t("updates.networkOrMirrorFailed");
    return t("updates.downloadFailed", { error: message });
  }
  async function checkUpdates(checkOptions: { silent?: boolean } = {}) {
    if (disposed || isIgnoringUpdate.value) return;
    if (!checkOptions.silent) showUpdateDialog.value = true;
    if (phase.value !== "idle" || downloaded.value || (checkOptions.silent && !notificationsEnabled.value)) return;
    clearRetry();
    const token = ++generation;
    phase.value = "checking";
    clearError();
    try {
      const info = await api.checkForUpdates(currentLocale(), normalizeUpdateDownloadSource(settingsStore.editorSettings.updateDownloadSource));
      if (token !== generation || disposed) return;
      updateInfo.value = info;
      phase.value = "idle";
      if (!info.update_available) updateCheckMessage.value = t("updates.upToDate", { version: info.current_version });
      if (canDownloadAndInstallUpdate(info, isTauriRuntime()) && !isUpdateIgnored(info, settingsStore.editorSettings.ignoredUpdateVersion)) {
        await downloadUpdateInBackground();
      }
    } catch (error) {
      if (token !== generation || disposed) return;
      phase.value = "idle";
      fail(error);
      scheduleRetry();
    }
  }
  async function downloadUpdateInBackground() {
    if (disposed || isIgnoringUpdate.value || phase.value !== "idle" || downloaded.value || !canDownloadAndInstallUpdate(updateInfo.value, isTauriRuntime())) return;
    const version = updateInfo.value!.latest_version;
    const token = ++generation;
    const attemptId = crypto.randomUUID();
    phase.value = "downloading";
    downloadProgress.value = null;
    clearError();
    clearRetry();
    const run = async () => {
      let unlisten: (() => void) | undefined;
      try {
        await cancellation;
        if (token !== generation || disposed) return;
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<UpdateDownloadProgress>("update-download-progress", ({ payload }) => {
          if (token !== generation || payload.attempt_id !== attemptId || payload.version !== version) return;
          downloadProgress.value = payload.total && payload.total > 0 ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100)) : null;
        });
        if (token !== generation || disposed) return;
        const cache = await api.downloadUpdate(normalizeUpdateDownloadSource(settingsStore.editorSettings.updateDownloadSource), version, attemptId, updateInfo.value?.release_notes);
        if (token !== generation || disposed) return;
        if (cache.version !== version) throw new Error("Downloaded update version changed; check for updates again.");
        setDownloaded(cache);
      } catch (error) {
        if (token !== generation || disposed) return;
        phase.value = "idle";
        fail(error);
        if ((String(error).includes("VERSION_CHANGED") || String(error).toLowerCase().includes("version changed")) && !versionRecheckPending) {
          versionRecheckPending = true;
          setTimeout(() => {
            void checkUpdates({ silent: true }).finally(() => {
              versionRecheckPending = false;
            });
          });
        } else scheduleRetry();
      } finally {
        unlisten?.();
      }
    };
    activeDownload = run();
    await activeDownload;
    activeDownload = undefined;
  }
  function cancelDownload(): Promise<void> {
    if (cancelOperation) return cancelOperation;
    cancelOperation = cancelDownloadImpl().finally(() => {
      cancelOperation = undefined;
    });
    return cancelOperation;
  }
  async function cancelDownloadImpl() {
    clearRetry();
    generation++;
    const running = activeDownload;
    if (phase.value === "checking") phase.value = "idle";
    if (!running) return;
    const pending = api.cancelUpdateDownload();
    cancellation = pending;
    try {
      await pending;
      await running;
      if (!disposed) {
        const cache = await api.getDownloadedUpdate();
        if (cache && !isUpdateIgnored({ latest_version: cache.version } as api.UpdateInfo, settingsStore.editorSettings.ignoredUpdateVersion)) setDownloaded(cache);
      }
    } finally {
      if (cancellation === pending) cancellation = undefined;
      if (phase.value === "downloading") phase.value = "idle";
    }
  }
  async function changeUpdateDownloadSource(source: SettingsUpdateDownloadSource) {
    if (isIgnoringUpdate.value || isInstallingUpdate.value) return;
    try {
      await settingsStore.updateEditorSettingsAndPersist({ updateDownloadSource: source });
      if (downloaded.value || updateReady.value || isInstallingUpdate.value) return;
      await cancelDownload();
      retries = 0;
      await checkUpdates();
    } catch (error) {
      fail(error);
    }
  }
  async function ignoreCurrentVersion() {
    const version = updateInfo.value?.latest_version;
    if (!version || isIgnoringUpdate.value || isInstallingUpdate.value || updateReady.value) return;
    isIgnoringUpdate.value = true;
    try {
      await cancelDownload();
      await settingsStore.updateEditorSettingsAndPersist({ ignoredUpdateVersion: version });
      const cache = downloaded.value;
      downloaded.value = null;
      phase.value = "idle";
      if (cache) await api.discardDownloadedUpdate(cache.cache_id);
      showUpdateDialog.value = false;
    } catch (error) {
      fail(error);
    } finally {
      isIgnoringUpdate.value = false;
    }
  }
  async function performInstall(restartOnly: boolean) {
    if (!isTauriRuntime() || isInstallingUpdate.value || isIgnoringUpdate.value || (!restartOnly && !downloaded.value)) return;
    const cache = downloaded.value;
    let release: (() => void) | undefined;
    phase.value = "preparing";
    clearError();
    let installed = restartOnly;
    let failed = false;
    try {
      release = await options.prepareForUpdate?.();
      updatePreparationRelease = release;
      if (shouldBlockAppUpdate(activeTaskCount.value)) throw new Error(t("updates.activeTasksBlockUpdate", { count: activeTaskCount.value }));
      phase.value = "installing";
      if (!restartOnly && cache) {
        await api.installDownloadedUpdate(cache.cache_id, cache.version);
        installed = true;
        downloaded.value = null;
      }
      // Windows installers and the portable helper own process replacement/relaunch.
      if (!cache?.portable_mode && !navigator.userAgent.includes("Windows")) {
        phase.value = "restart";
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (error) {
      failed = true;
      phase.value = installed ? "restart" : "ready";
      updateCheckFailed.value = true;
      updateCheckMessage.value = t(installed ? "updates.restartFailed" : "updates.installFailed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      // Successful handoff must keep every window frozen until the process exits.
      if (failed) {
        release?.();
        updatePreparationRelease = undefined;
      }
      if (!installed && cache) {
        try {
          const restored = await api.getDownloadedUpdate();
          if (!restored || restored.cache_id !== cache.cache_id) {
            downloaded.value = null;
            phase.value = "idle";
          }
        } catch {
          /* Keep the original installation error available for retry. */
        }
      }
    }
  }
  async function installDownloadedUpdate() {
    await performInstall(false);
  }
  async function restartApp() {
    if (updateReady.value) await performInstall(true);
  }
  async function initialize() {
    if (initialized || disposed) return;
    initialized = true;
    if (isTauriRuntime()) {
      phase.value = "checking";
      try {
        const cache = await api.getDownloadedUpdate();
        if (disposed) return;
        if (cache) {
          const ignored = isUpdateIgnored({ latest_version: cache.version } as api.UpdateInfo, settingsStore.editorSettings.ignoredUpdateVersion);
          if (ignored) await api.discardDownloadedUpdate(cache.cache_id);
          else {
            setDownloaded(cache);
            updateInfo.value!.current_version = await api.getAppVersion();
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        if (phase.value === "checking") phase.value = "idle";
      }
    }
    if (disposed) return;
    hourlyTimer = setInterval(() => {
      if (!retryTimer) {
        retries = 0;
        void checkUpdates({ silent: true });
      }
    }, 3_600_000);
    void checkUpdates({ silent: true });
  }
  const stopSettingsWatch = watch(notificationsEnabled, (enabled) => {
    if (!initialized || disposed) return;
    const settle = enabled ? (cancelOperation ?? Promise.resolve()) : cancelDownload();
    void settle
      .then(() => {
        if (notificationsEnabled.value && !disposed) void checkUpdates({ silent: true });
      })
      .catch(fail);
  });
  function dispose() {
    disposed = true;
    clearRetry();
    clearInterval(hourlyTimer);
    stopSettingsWatch();
    updatePreparationRelease?.();
    updatePreparationRelease = undefined;
    void cancelDownload().catch(() => {});
  }
  onScopeDispose(dispose);
  return {
    phase,
    checkingUpdates,
    updateInfo,
    updateCheckMessage,
    updateCheckFailed,
    showUpdateDialog,
    isDownloadingUpdate,
    downloadProgress,
    updateDownloaded,
    isInstallingUpdate,
    isPreparingUpdate,
    updateReady,
    isIgnoringUpdate,
    activeTaskCount,
    hasUpdateAvailable,
    latestReleaseUrl,
    openUrl,
    checkUpdates,
    formatUpdateError,
    openLatestRelease,
    changeUpdateDownloadSource,
    ignoreCurrentVersion,
    downloadUpdateInBackground,
    cancelDownload,
    installDownloadedUpdate,
    restartApp,
    initialize,
    dispose,
  };
}
