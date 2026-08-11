// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppUpdater } from "@/composables/useAppUpdater";

const apiMock = vi.hoisted(() => ({
  cancelUpdateDownload: vi.fn<() => Promise<void>>(),
  downloadUpdate: vi.fn<() => Promise<void>>(),
  installDownloadedUpdate: vi.fn<() => Promise<void>>(),
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

    let updater!: ReturnType<typeof useAppUpdater>;
    container = document.createElement("div");
    document.body.append(container);
    app = createApp(
      defineComponent({
        setup() {
          updater = useAppUpdater();
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

    const firstAttempt = updater.downloadAndInstallUpdate();
    await vi.waitFor(() => expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(1));

    const cancelAttempt = updater.cancelDownload();
    expect(updater.isDownloadingUpdate.value).toBe(false);

    const retryAttempt = updater.downloadAndInstallUpdate();
    await Promise.resolve();
    expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.isDownloadingUpdate.value).toBe(true);

    cancellation.resolve();
    await cancelAttempt;
    await vi.waitFor(() => expect(apiMock.downloadUpdate).toHaveBeenCalledTimes(2));

    firstDownload.reject(new Error("Download canceled by user."));
    await firstAttempt;
    expect(updater.isDownloadingUpdate.value).toBe(true);
    expect(updater.downloadProgress.value).toBe(0);

    secondDownload.resolve();
    await retryAttempt;

    expect(apiMock.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(updater.isDownloadingUpdate.value).toBe(false);
    expect(updater.updateReady.value).toBe(true);
  });
});

describe("useAppUpdater ignore version", () => {
  it("persists the ignored latest version and closes the update dialog", async () => {
    let updater!: ReturnType<typeof useAppUpdater>;
    container = document.createElement("div");
    document.body.append(container);
    app = createApp(
      defineComponent({
        setup() {
          updater = useAppUpdater();
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
    updater.showUpdateDialog.value = true;

    await updater.ignoreCurrentVersion();

    expect(settingsStoreMock.updateEditorSettingsAndPersist).toHaveBeenCalledWith({ ignoredUpdateVersion: "0.5.70" });
    expect(updater.showUpdateDialog.value).toBe(false);
    expect(toastMock).toHaveBeenCalledWith("Version v0.5.70 ignored. You'll be reminded when the next version releases.", 5000);
  });

  it("keeps the dialog open and allows retry when persistence fails", async () => {
    settingsStoreMock.updateEditorSettingsAndPersist.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce();
    let updater!: ReturnType<typeof useAppUpdater>;
    container = document.createElement("div");
    document.body.append(container);
    app = createApp(
      defineComponent({
        setup() {
          updater = useAppUpdater();
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
