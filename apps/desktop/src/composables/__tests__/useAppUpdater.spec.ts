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
const settings = reactive({ updateDownloadSource: "official", ignoredUpdateVersion: "", updateNotificationsEnabled: true });
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
  it("shows no badge until a download finishes, and closing does not cancel", async () => {
    const pending = deferred<typeof cache>();
    mocks.downloadUpdate.mockReturnValue(pending.promise);
    const updater = mount();
    const checking = updater.checkUpdates();
    await flush();
    expect(updater.hasUpdateAvailable.value).toBe(false);
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
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
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
  it("hides ready badge when notifications disabled but preserves manual installation", async () => {
    mocks.getDownloadedUpdate.mockResolvedValue(cache);
    const updater = mount();
    await updater.initialize();
    settings.updateNotificationsEnabled = false;
    await flush();
    expect(updater.hasUpdateAvailable.value).toBe(false);
    expect(updater.updateDownloaded.value).toBe(true);
    expect(mocks.discardDownloadedUpdate).not.toHaveBeenCalled();
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

  it("resumes after notifications are reenabled while cancellation is pending", async () => {
    const pendingDownload = deferred<typeof cache>();
    const pendingCancel = deferred<void>();
    mocks.downloadUpdate.mockReturnValueOnce(pendingDownload.promise);
    mocks.cancelUpdateDownload.mockReturnValue(pendingCancel.promise);
    const updater = mount();
    await updater.initialize();
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1));
    settings.updateNotificationsEnabled = false;
    await nextTick();
    settings.updateNotificationsEnabled = true;
    await nextTick();
    pendingDownload.reject(new Error("cancelled"));
    pendingCancel.resolve();
    await vi.waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(updater.updateDownloaded.value).toBe(true);
  });
});
