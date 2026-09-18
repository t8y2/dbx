// @vitest-environment happy-dom
import { createApp, defineComponent, h, reactive, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppUpdater } from "@/composables/useAppUpdater";
const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  cancelUpdateDownload: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  getDownloadedUpdate: vi.fn(),
  discardDownloadedUpdate: vi.fn(),
  getAppVersion: vi.fn(),
  listen: vi.fn(),
  relaunch: vi.fn(),
  persist: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
const settings = reactive({ updateDownloadSource: "official", ignoredUpdateVersion: "", updateNotificationsEnabled: true, autoDownloadUpdates: true, autoUpdateApp: true });
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: settings, updateEditorSettingsAndPersist: mocks.persist }) }));
const info = { current_version: "1.0.0", latest_version: "1.1.0", update_available: true, portable_mode: false, manual_update_only: false, release_name: "v1.1.0", release_url: "https://example.com", release_notes: "Changes" };
const cache = { cache_id: "cached", version: "1.1.0", portable_mode: false, release_url: "https://example.com", release_notes: "Changes", downloaded_at: 1 };
let app: App;
function mount(options: Parameters<typeof useAppUpdater>[0] = {}) {
  let updater!: ReturnType<typeof useAppUpdater>;
  app = createApp(
    defineComponent({
      setup() {
        updater = useAppUpdater(options);
        return () => h("div");
      },
    }),
  );
  app.use(i18n);
  app.mount(document.createElement("div"));
  return updater;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
}
beforeEach(() => {
  vi.resetAllMocks();
  settings.updateDownloadSource = "official";
  settings.ignoredUpdateVersion = "";
  settings.updateNotificationsEnabled = true;
  settings.autoDownloadUpdates = true;
  settings.autoUpdateApp = true;
  mocks.checkForUpdates.mockResolvedValue(info);
  mocks.downloadUpdate.mockResolvedValue(cache);
  mocks.getDownloadedUpdate.mockResolvedValue(null);
  mocks.getAppVersion.mockResolvedValue("1.0.0");
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.persist.mockImplementation(async (values) => Object.assign(settings, values));
});
afterEach(() => {
  app?.unmount();
  vi.useRealTimers();
});
describe("silent update lifecycle", () => {
  it("checks and shows a badge without downloading when automatic downloads are disabled", async () => {
    settings.autoUpdateApp = false;
    const updater = mount();
    await updater.initialize();
    await flush();
    expect(mocks.checkForUpdates).toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.hasUpdateAvailable.value).toBe(true);
    expect(updater.showUpdateDialog.value).toBe(false);
    await updater.checkUpdates();
    expect(updater.showUpdateDialog.value).toBe(true);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    await updater.downloadUpdateInBackground();
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.updateDownloaded.value).toBe(true);
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
  });
  it("surfaces a newer release instead of a stale package with automatic downloads disabled", async () => {
    settings.autoUpdateApp = false;
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    mocks.checkForUpdates.mockResolvedValue({ ...info, latest_version: "1.2.0", release_name: "v1.2.0" });
    const updater = mount();
    await updater.initialize();
    await flush();
    expect(updater.updateInfo.value?.latest_version).toBe("1.2.0");
    expect(mocks.discardDownloadedUpdate).toHaveBeenCalledWith(cache.cache_id);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.updateDownloaded.value).toBe(false);
    expect(updater.hasUpdateAvailable.value).toBe(true);
    await updater.installDownloadedUpdate();
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
    mocks.downloadUpdate.mockResolvedValue({ ...cache, version: "1.2.0" });
    await updater.downloadUpdateInBackground();
    expect(mocks.downloadUpdate).toHaveBeenCalledWith("official", "1.2.0", expect.any(String), "Changes");
    expect(updater.updateDownloaded.value).toBe(true);
  });
  it("preserves a prepared package with automatic downloads disabled", async () => {
    settings.autoUpdateApp = false;
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const updater = mount();
    await updater.initialize();
    await flush();
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.updateInfo.value?.latest_version).toBe(cache.version);
    expect(updater.hasUpdateAvailable.value).toBe(true);
    await updater.installDownloadedUpdate();
    expect(mocks.installDownloadedUpdate).toHaveBeenCalledWith(cache.cache_id, cache.version);
  });
  it("starts a silent download when the preference is enabled", async () => {
    settings.autoUpdateApp = false;
    const updater = mount();
    await updater.initialize();
    await flush();
    settings.autoUpdateApp = true;
    await vi.waitFor(() => expect(updater.updateDownloaded.value).toBe(true));
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.showUpdateDialog.value).toBe(false);
  });
  it("cancels an automatic download when the preference is disabled", async () => {
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    mocks.cancelUpdateDownload.mockImplementation(async () => pending.reject(new Error("cancelled")));
    const updater = mount();
    const checking = updater.checkUpdates({ silent: true });
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledOnce());
    settings.autoUpdateApp = false;
    await vi.waitFor(() => expect(updater.phase.value).toBe("idle"));
    await checking;
    expect(mocks.cancelUpdateDownload).toHaveBeenCalledOnce();
    expect(updater.hasUpdateAvailable.value).toBe(true);
  });
  it("does not cancel a manually started background download when the preference changes", async () => {
    settings.autoUpdateApp = false;
    const updater = mount();
    await updater.checkUpdates();
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    const downloading = updater.downloadUpdateInBackground();
    await flush();
    settings.autoUpdateApp = true;
    await nextTick();
    settings.autoUpdateApp = false;
    await flush();
    expect(mocks.cancelUpdateDownload).not.toHaveBeenCalled();
    updater.showUpdateDialog.value = false;
    pending.resolve(cache);
    await downloading;
    expect(updater.updateDownloaded.value).toBe(true);
  });
  it("automatically downloads without surfacing or installing, even while idle", async () => {
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    expect(mocks.downloadUpdate).toHaveBeenCalledWith("official", "1.1.0", expect.any(String), "Changes");
    expect(updater.phase.value).toBe("ready");
    expect(updater.hasUpdateAvailable.value).toBe(true);
    expect(updater.showUpdateDialog.value).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("keeps the cloud icon available while downloading, and closing does not cancel", async () => {
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    const updater = mount();
    const checking = updater.checkUpdates();
    await flush();
    expect(updater.hasUpdateAvailable.value).toBe(true);
    updater.showUpdateDialog.value = false;
    pending.resolve(cache);
    await checking;
    expect(updater.updateDownloaded.value).toBe(true);
    expect(mocks.cancelUpdateDownload).not.toHaveBeenCalled();
  });
  it("restores offline and one click saves before installing and restarting without downloading", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const release = vi.fn();
    const prepare = vi.fn(async () => release);
    const updater = mount({ prepareForUpdate: prepare });
    await updater.initialize();
    await updater.installDownloadedUpdate();
    // Only the startup recheck runs (same latest version keeps the cache); installing never needs fresh metadata or a re-download.
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.installDownloadedUpdate).toHaveBeenCalledWith("cached", "1.1.0");
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.installDownloadedUpdate.mock.invocationCallOrder[0]);
    expect(mocks.installDownloadedUpdate.mock.invocationCallOrder[0]).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
    expect(release).not.toHaveBeenCalled();
  });
  it("preparation failure retains the package and repeated clicks cannot bypass preparation", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const pending = deferred<() => void>();
    const updater = mount({ prepareForUpdate: () => pending.promise });
    await updater.checkUpdates({ silent: true });
    const install = updater.installDownloadedUpdate();
    await updater.installDownloadedUpdate();
    pending.reject(new Error("unsaved grid"));
    await install;
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(updater.phase.value).toBe("ready");
    expect(updater.updateCheckMessage.value).toContain("unsaved grid");
  });
  it("blocks installation for active work but never blocks automatic download", async () => {
    const updater = mount({ getActiveTaskCount: () => 2 });
    await updater.checkUpdates({ silent: true });
    expect(updater.updateDownloaded.value).toBe(true);
    await updater.installDownloadedUpdate();
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
  });
  it("retries only restart after relaunch fails", async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.installDownloadedUpdate();
    await updater.restartApp();
    expect(mocks.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  });
  it("persists ignore before deleting a ready cache", async () => {
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.ignoreCurrentVersion();
    expect(mocks.persist).toHaveBeenCalledWith({ ignoredUpdateVersion: "1.1.0" });
    expect(mocks.discardDownloadedUpdate).toHaveBeenCalledWith("cached");
    expect(updater.updateDownloaded.value).toBe(false);
  });
  it("keeps ready cache if ignoring cannot persist", async () => {
    mocks.persist.mockRejectedValue(new Error("disk full"));
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.ignoreCurrentVersion();
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
    expect(updater.updateDownloaded.value).toBe(true);
  });
  it("keeps a ready update available when automatic app updates are disabled", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const updater = mount();
    await updater.initialize();
    settings.autoUpdateApp = false;
    await flush();
    expect(updater.hasUpdateAvailable.value).toBe(true);
    expect(updater.updateDownloaded.value).toBe(true);
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
  });
  it("shows a remote app update without downloading it when automatic app updates are disabled", async () => {
    settings.autoUpdateApp = false;
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    expect(updater.hasUpdateAvailable.value).toBe(true);
    expect(updater.updateDownloaded.value).toBe(false);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });
  it("ignores progress belonging to another version or download attempt", async () => {
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    const updater = mount();
    const checking = updater.checkUpdates({ silent: true });
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    const callback = mocks.listen.mock.calls[0][1];
    const attempt = mocks.downloadUpdate.mock.calls[0][2];
    callback({ payload: { downloaded: 90, total: 100, attempt_id: "old", version: "1.1.0" } });
    expect(updater.downloadProgress.value).toBeNull();
    callback({ payload: { downloaded: 30, total: 100, attempt_id: attempt, version: "1.1.0" } });
    expect(updater.downloadProgress.value).toBe(30);
    pending.resolve(cache);
    await checking;
  });
  it("silently backs off after failed downloads at 1, 5 and 15 minutes", async () => {
    vi.useFakeTimers();
    mocks.downloadUpdate.mockRejectedValue(new Error("network down"));
    const updater = mount();
    await updater.initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [60_000, 300_000, 900_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(mocks.downloadUpdate).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(4);
    expect(updater.showUpdateDialog.value).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("changing source keeps an already prepared package", async () => {
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.changeUpdateDownloadSource("cnb");
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
  });
  it("reconciles a download that commits just before cancellation without installing it", async () => {
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    mocks.cancelUpdateDownload.mockImplementation(async () => {
      pending.resolve(cache);
    });
    const updater = mount();
    const check = updater.checkUpdates({ silent: true });
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalled());
    await updater.cancelDownload();
    await check;
    expect(updater.updateDownloaded.value).toBe(true);
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
  });
  it("does not resurrect a logically ignored package if removing its files fails", async () => {
    mocks.discardDownloadedUpdate.mockRejectedValue(new Error("file busy"));
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.ignoreCurrentVersion();
    expect(settings.ignoredUpdateVersion).toBe("1.1.0");
    expect(updater.updateDownloaded.value).toBe(false);
    expect(updater.hasUpdateAvailable.value).toBe(false);
    expect(updater.updateCheckMessage.value).toContain("file busy");
  });
  it("clears a corrupt installation cache so download can be retried", async () => {
    mocks.installDownloadedUpdate.mockRejectedValue(new Error("signature invalid"));
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await updater.installDownloadedUpdate();
    expect(updater.phase.value).toBe("idle");
    expect(updater.updateDownloaded.value).toBe(false);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("holds the preparation barrier through install and releases it only on failure", async () => {
    const release = vi.fn();
    mocks.installDownloadedUpdate.mockRejectedValue(new Error("installer failed"));
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const updater = mount({ prepareForUpdate: async () => release });
    await updater.checkUpdates({ silent: true });
    await updater.installDownloadedUpdate();
    expect(release).toHaveBeenCalledOnce();
    expect(updater.updateDownloaded.value).toBe(true);
  });
  it("checks fresh metadata immediately once when the downloaded version changes", async () => {
    mocks.downloadUpdate.mockRejectedValueOnce(new Error("Update version changed; check for updates again."));
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.updateDownloaded.value).toBe(true);
  });

  it("cannot install or switch sources while an ignore setting is being persisted", async () => {
    const persist = deferred<void>();
    mocks.persist.mockReturnValue(persist.promise);
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    const ignoring = updater.ignoreCurrentVersion();
    await updater.installDownloadedUpdate();
    await updater.changeUpdateDownloadSource("cnb");
    await updater.checkUpdates({ silent: true });
    await updater.downloadUpdateInBackground();
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    persist.resolve();
    await ignoring;
    expect(updater.updateDownloaded.value).toBe(false);
  });

  it("resumes after automatic app updates are reenabled while cancellation is pending", async () => {
    const pendingDownload = deferred<typeof cache>();
    const pendingCancel = deferred<void>();
    mocks.downloadUpdate.mockReturnValueOnce(pendingDownload.promise);
    mocks.cancelUpdateDownload.mockReturnValue(pendingCancel.promise);
    const updater = mount();
    await updater.initialize();
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1));
    settings.autoUpdateApp = false;
    await nextTick();
    settings.autoUpdateApp = true;
    await nextTick();
    pendingDownload.reject(new Error("cancelled"));
    pendingCancel.resolve();
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(updater.updateDownloaded.value).toBe(true);
  });

  it("replaces a downloaded update when a newer version is released", async () => {
    const newer = { ...info, latest_version: "1.2.0", release_name: "v1.2.0" };
    const replacement = { ...cache, version: "1.2.0" };
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    mocks.checkForUpdates.mockResolvedValue(newer);
    mocks.downloadUpdate.mockResolvedValue(replacement);
    const updater = mount();
    await updater.initialize();
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalled());
    expect(mocks.discardDownloadedUpdate).toHaveBeenCalledWith("cached");
    expect(mocks.downloadUpdate).toHaveBeenCalledWith("official", "1.2.0", expect.any(String), "Changes");
    expect(updater.updateDownloaded.value).toBe(true);
    expect(updater.updateInfo.value?.latest_version).toBe("1.2.0");
    expect(updater.phase.value).toBe("ready");
  });

  it("keeps a downloaded update when the released version is not newer", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    mocks.checkForUpdates.mockResolvedValue({ ...info, latest_version: "1.1.0" });
    const updater = mount();
    await updater.initialize();
    await flush();
    expect(mocks.checkForUpdates).toHaveBeenCalled();
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.phase.value).toBe("ready");
    expect(updater.updateDownloaded.value).toBe(true);
  });

  it("keeps a downloaded update when the remote reports an older version", async () => {
    const updater = mount();
    await updater.checkUpdates({ silent: true });
    expect(updater.updateDownloaded.value).toBe(true);
    mocks.checkForUpdates.mockResolvedValue({ ...info, latest_version: "1.0.5" });
    await updater.checkUpdates({ silent: true });
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.phase.value).toBe("ready");
  });

  it("does not disturb an installation that starts while a recheck is in flight", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const gate = deferred<typeof info>();
    mocks.checkForUpdates.mockReturnValue(gate.promise);
    const release = vi.fn();
    const updater = mount({ prepareForUpdate: async () => release });
    await updater.initialize();
    await updater.installDownloadedUpdate();
    gate.resolve(info);
    await flush();
    expect(updater.phase.value).toBe("restart");
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it("keeps the ready package when discarding a superseded update fails", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    mocks.checkForUpdates.mockResolvedValue({ ...info, latest_version: "1.2.0" });
    mocks.discardDownloadedUpdate.mockRejectedValue(new Error("file busy"));
    const updater = mount();
    await updater.initialize();
    await flush();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.updateDownloaded.value).toBe(true);
    expect(updater.updateCheckMessage.value).toContain("file busy");
  });
});
