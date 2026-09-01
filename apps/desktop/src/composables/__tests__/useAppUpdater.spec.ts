// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppUpdater } from "@/composables/useAppUpdater";

const apiMock = vi.hoisted(() => ({
  cancelUpdateDownload: vi.fn<() => Promise<void>>(),
  downloadUpdate: vi.fn<() => Promise<void>>(),
  installDownloadedUpdate: vi.fn<() => Promise<void>>(),
  checkForUpdates: vi.fn(),
}));
const listenMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));
vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: toastMock }),
}));
const settingsStoreMock = vi.hoisted(() => ({
  editorSettings: { updateDownloadSource: "official", ignoredUpdateVersion: "" },
  updateEditorSettingsAndPersist: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => settingsStoreMock,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let app: App | undefined;
let container: HTMLDivElement | undefined;

function mountUpdater(options: { getActiveTaskCount?: () => number } = {}) {
  container = document.createElement("div");
  document.body.append(container);
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
  app.mount(container);
  updater.updateInfo.value = {
    current_version: "0.5.69",
    latest_version: "0.5.70",
    update_available: true,
    release_name: "DBX v0.5.70",
    release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.70",
    release_notes: "",
  };
  return updater;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsStoreMock.editorSettings.ignoredUpdateVersion = "";
  settingsStoreMock.updateEditorSettingsAndPersist.mockResolvedValue();
  listenMock.mockResolvedValue(vi.fn());
  apiMock.installDownloadedUpdate.mockResolvedValue();
});

afterEach(() => {
  app?.unmount();
  container?.remove();
  app = undefined;
  container = undefined;
});

describe("useAppUpdater download attempts", () => {
  it("waits for cancellation and ignores stale completion from the previous attempt", async () => {
    const firstDownload = deferred<void>();
    const secondDownload = deferred<void>();
    const cancellation = deferred<void>();
    apiMock.downloadUpdate.mockImplementationOnce(() => firstDownload.promise).mockImplementationOnce(() => secondDownload.promise);
    apiMock.cancelUpdateDownload.mockReturnValueOnce(cancellation.promise);

    const updater = mountUpdater();

    const firstAttempt = updater.downloadUpdateInBackground();
    await vi.waitFor(() => expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(1));

    const cancelAttempt = updater.cancelDownload();
    expect(updater.isDownloadingUpdate.value).toBe(false);

    const retryAttempt = updater.downloadUpdateInBackground();
    await Promise.resolve();
    expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.isDownloadingUpdate.value).toBe(true);

    cancellation.resolve();
    await cancelAttempt;
    await vi.waitFor(() => expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(2));

    firstDownload.reject(new Error("Download canceled by user."));
    await firstAttempt;
    expect(updater.isDownloadingUpdate.value).toBe(true);
    // The retry is in flight with no progress event yet, so progress is indeterminate.
    expect(updater.downloadProgress.value).toBeNull();

    secondDownload.resolve();
    await retryAttempt;

    // No active tasks by default, so the successful download auto-installs and lands on
    // "ready to restart" instead of waiting for a manual "Install Now" click.
    expect(apiMock.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(updater.isDownloadingUpdate.value).toBe(false);
    expect(updater.downloadProgress.value).toBe(100);
    expect(updater.updateDownloaded.value).toBe(false);
    expect(updater.updateReady.value).toBe(true);
    expect(toastMock).toHaveBeenLastCalledWith("DBX has been updated. Restart to finish.", 10000, expect.objectContaining({ label: "Exit & Restart", onClick: expect.any(Function) }));
  });

  it("auto-installs once the download finishes while idle, without waiting for a manual click", async () => {
    apiMock.downloadUpdate.mockResolvedValueOnce();
    const updater = mountUpdater();
    updater.showUpdateDialog.value = true;

    const attempt = updater.downloadUpdateInBackground();
    expect(updater.showUpdateDialog.value).toBe(false);
    await attempt;

    expect(apiMock.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(updater.updateDownloaded.value).toBe(false);
    expect(updater.updateReady.value).toBe(true);
    expect(toastMock).toHaveBeenLastCalledWith("DBX has been updated. Restart to finish.", 10000, expect.objectContaining({ label: "Exit & Restart", onClick: expect.any(Function) }));
  });

  it("falls back to a manual Install Now toast when tasks are still active once the download finishes", async () => {
    apiMock.downloadUpdate.mockResolvedValueOnce();
    // Must be a reactive ref, not a plain closure variable — useAppUpdater's activeTaskCount
    // is a computed(), which only invalidates its cache when a tracked reactive source changes.
    const activeTaskCount = ref(2);
    const updater = mountUpdater({ getActiveTaskCount: () => activeTaskCount.value });

    await updater.downloadUpdateInBackground();

    expect(apiMock.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(updater.updateDownloaded.value).toBe(true);
    expect(toastMock).toHaveBeenLastCalledWith("DBX v0.5.70 is ready to install.", 10000, expect.objectContaining({ label: "Install Now", onClick: expect.any(Function) }));

    activeTaskCount.value = 0;
    const [, , action] = toastMock.mock.lastCall!;
    action.onClick();

    await vi.waitFor(() => expect(apiMock.installDownloadedUpdate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(toastMock).toHaveBeenLastCalledWith("DBX has been updated. Restart to finish.", 10000, expect.objectContaining({ label: "Exit & Restart", onClick: expect.any(Function) })));
    expect(updater.updateReady.value).toBe(true);
  });

  it("tracks download progress and stays indeterminate when the backend reports no total", async () => {
    const download = deferred<void>();
    apiMock.downloadUpdate.mockReturnValueOnce(download.promise);
    const updater = mountUpdater();

    const downloadAttempt = updater.downloadUpdateInBackground();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledOnce());
    // No progress event yet — the size is unknown, so progress stays indeterminate.
    expect(updater.downloadProgress.value).toBeNull();

    const onProgress = listenMock.mock.calls[0][1] as (event: { payload: { downloaded: number; total: number | null } }) => void;
    onProgress({ payload: { downloaded: 25, total: 100 } });
    expect(updater.downloadProgress.value).toBe(25);

    // Mirrors may stream chunks without a total; progress must not freeze at a stale percentage.
    onProgress({ payload: { downloaded: 64, total: null } });
    expect(updater.downloadProgress.value).toBeNull();

    download.resolve();
    await downloadAttempt;
    expect(updater.downloadProgress.value).toBe(100);
  });
});

describe("useAppUpdater reopening the dialog from the toolbar", () => {
  it("resurfaces the dialog without re-checking while a download is in progress", async () => {
    const download = deferred<void>();
    apiMock.downloadUpdate.mockReturnValueOnce(download.promise);
    const updater = mountUpdater();

    const downloadAttempt = updater.downloadUpdateInBackground();
    await vi.waitFor(() => expect(updater.isDownloadingUpdate.value).toBe(true));

    await updater.checkUpdates();

    expect(apiMock.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.showUpdateDialog.value).toBe(true);

    download.resolve();
    await downloadAttempt;
  });

  it("resurfaces the dialog without re-checking once the update is downloaded and ready to install", async () => {
    apiMock.downloadUpdate.mockResolvedValueOnce();
    // Busy at download-completion time so the install step stays pending instead of auto-running.
    const updater = mountUpdater({ getActiveTaskCount: () => 1 });

    await updater.downloadUpdateInBackground();
    expect(updater.updateDownloaded.value).toBe(true);
    expect(updater.showUpdateDialog.value).toBe(false);

    await updater.checkUpdates();

    expect(apiMock.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.showUpdateDialog.value).toBe(true);
  });

  it("resurfaces the dialog without re-checking once the update is installed and awaiting restart", async () => {
    apiMock.downloadUpdate.mockResolvedValueOnce();
    const updater = mountUpdater();

    await updater.downloadUpdateInBackground();
    expect(updater.updateReady.value).toBe(true);

    await updater.checkUpdates();

    expect(apiMock.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.showUpdateDialog.value).toBe(true);
  });

  it("still checks the network for a silent background check even mid-download", async () => {
    const download = deferred<void>();
    apiMock.downloadUpdate.mockReturnValueOnce(download.promise);
    apiMock.checkForUpdates.mockResolvedValueOnce({
      current_version: "0.5.69",
      latest_version: "0.5.70",
      update_available: true,
      release_name: "DBX v0.5.70",
      release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.70",
      release_notes: "",
    });
    const updater = mountUpdater();

    const downloadAttempt = updater.downloadUpdateInBackground();
    await vi.waitFor(() => expect(updater.isDownloadingUpdate.value).toBe(true));

    await updater.checkUpdates({ silent: true });

    expect(apiMock.checkForUpdates).toHaveBeenCalledOnce();

    download.resolve();
    await downloadAttempt;
  });
});

describe("useAppUpdater ignore version", () => {
  it("persists the ignored latest version and closes the update dialog", async () => {
    const updater = mountUpdater();
    updater.showUpdateDialog.value = true;

    await updater.ignoreCurrentVersion();

    expect(settingsStoreMock.updateEditorSettingsAndPersist).toHaveBeenCalledWith({ ignoredUpdateVersion: "0.5.70" });
    expect(updater.showUpdateDialog.value).toBe(false);
    expect(toastMock).toHaveBeenCalledWith("Version v0.5.70 ignored. You'll be reminded when the next version releases.", 5000);
  });

  it("keeps the dialog open and allows retry when persistence fails", async () => {
    settingsStoreMock.updateEditorSettingsAndPersist.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce();
    const updater = mountUpdater();
    updater.showUpdateDialog.value = true;

    await updater.ignoreCurrentVersion();

    expect(updater.showUpdateDialog.value).toBe(true);
    expect(updater.isIgnoringUpdate.value).toBe(false);
    expect(toastMock).toHaveBeenLastCalledWith("Failed to save the ignored version: storage unavailable", 5000);

    await updater.ignoreCurrentVersion();

    expect(settingsStoreMock.updateEditorSettingsAndPersist).toHaveBeenCalledTimes(2);
    expect(updater.showUpdateDialog.value).toBe(false);
  });
});
