// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import UpdateDialog from "@/components/layout/UpdateDialog.vue";

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

const mountedApps: App[] = [];

interface DialogState {
  open: boolean;
  portableMode: boolean;
  manualUpdateOnly: boolean;
  isDownloadingUpdate: boolean;
  downloadProgress: number | null;
  updateDownloaded: boolean;
  isInstallingUpdate: boolean;
  updateReady: boolean;
  isIgnoringUpdate: boolean;
}

async function flushDialog() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountDialog(activeTaskCount: number, initialState: Partial<DialogState> = {}, installDownloaded = vi.fn(async () => {})) {
  const state = reactive<DialogState>({
    open: true,
    portableMode: false,
    manualUpdateOnly: false,
    isDownloadingUpdate: false,
    downloadProgress: 0,
    updateDownloaded: false,
    isInstallingUpdate: false,
    updateReady: false,
    isIgnoringUpdate: false,
    ...initialState,
  });
  const downloadInBackground = vi.fn();
  const cancelDownload = vi.fn();
  const ignoreVersion = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        async function handleInstallDownloaded() {
          state.isInstallingUpdate = true;
          try {
            await installDownloaded();
            state.updateDownloaded = false;
            state.updateReady = true;
          } catch {
            // The real updater reports the error but retains the downloaded package for retry.
          } finally {
            state.isInstallingUpdate = false;
          }
        }

        return () =>
          h(UpdateDialog, {
            open: state.open,
            "onUpdate:open": (value: boolean) => {
              state.open = value;
            },
            updateInfo: {
              current_version: "0.5.60",
              latest_version: "0.5.61",
              update_available: true,
              portable_mode: state.portableMode,
              manual_update_only: state.manualUpdateOnly,
              release_name: "DBX v0.5.61",
              release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.61",
              release_notes: "",
            },
            updateCheckMessage: "",
            isDownloadingUpdate: state.isDownloadingUpdate,
            downloadProgress: state.downloadProgress,
            updateDownloaded: state.updateDownloaded,
            isInstallingUpdate: state.isInstallingUpdate,
            updateReady: state.updateReady,
            isIgnoringUpdate: state.isIgnoringUpdate,
            activeTaskCount,
            "onDownload-in-background": downloadInBackground,
            "onCancel-download": cancelDownload,
            "onInstall-downloaded": handleInstallDownloaded,
            "onIgnore-version": ignoreVersion,
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushDialog();

  return { state, downloadInBackground, cancelDownload, installDownloaded, ignoreVersion };
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

function downloadButton(): HTMLButtonElement | undefined {
  return buttonWithText("Download in Background");
}

function cancelDownloadButton(): HTMLButtonElement | undefined {
  return buttonWithText("Cancel Download");
}

function installDownloadedButton(): HTMLButtonElement | undefined {
  return buttonWithText("Exit & Update");
}

async function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await flushDialog();
}

async function clickOutside() {
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  await flushDialog();
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("UpdateDialog active task guard", () => {
  it("shows the task warning but still allows starting a background download while work is running", async () => {
    await mountDialog(2);

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("2");
    expect(downloadButton()?.disabled).toBe(false);
  });

  it("allows installation after all tasks finish", async () => {
    await mountDialog(0);

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(downloadButton()?.disabled).toBe(false);
  });

  it("offers automatic installation for portable builds", async () => {
    await mountDialog(0, { portableMode: true });

    expect(document.body.textContent).toContain("portable ZIP");
    expect(downloadButton()?.disabled).toBe(false);
  });

  it("routes Windows 7 builds to the dedicated installer", async () => {
    await mountDialog(0, { manualUpdateOnly: true });

    expect(document.body.textContent).toContain("WebView2 109 offline installer");
    expect(downloadButton()).toBeUndefined();
    expect(buttonWithText("Open Release")).toBeDefined();
  });

  it("prevents Windows 7 portable builds from installing the regular x64 portable update", async () => {
    await mountDialog(0, { portableMode: true, manualUpdateOnly: true });

    expect(document.body.textContent).toContain("WebView2 109 offline installer");
    expect(document.body.textContent).not.toContain("signed portable ZIP");
    expect(downloadButton()).toBeUndefined();
    expect(buttonWithText("Open Release")).toBeDefined();
  });

  it("retains the downloaded update and enables installation only after tasks finish", async () => {
    await mountDialog(1, { updateDownloaded: true, downloadProgress: 100 });

    expect(downloadButton()).toBeUndefined();
    expect(installDownloadedButton()?.disabled).toBe(true);

    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    await mountDialog(0, { updateDownloaded: true, downloadProgress: 100 });

    expect(installDownloadedButton()?.disabled).toBe(false);
  });
});

describe("UpdateDialog download progress", () => {
  it("keeps the downloading button at a fixed width as progress changes", async () => {
    const { state } = await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: 9 });

    expect(buttonWithText("Downloading 9%")?.classList.contains("w-52")).toBe(true);

    state.downloadProgress = 100;
    await flushDialog();

    expect(buttonWithText("Downloading 100%")?.classList.contains("w-52")).toBe(true);
  });

  it("falls back to 0% while the download size is unknown", async () => {
    await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: null });

    expect(buttonWithText("Downloading 0%")).toBeDefined();
  });
});

describe("UpdateDialog close protection", () => {
  it("closes without cancelling the background download when the close button is clicked", async () => {
    const { state, cancelDownload } = await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: 42 });

    const closeButton = document.body.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]');
    closeButton?.click();
    await flushDialog();

    expect(cancelDownload).not.toHaveBeenCalled();
    expect(state.open).toBe(false);
  });

  it("closes without cancelling the background download when dismissed by clicking outside", async () => {
    const { state, cancelDownload } = await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: 42 });

    await clickOutside();

    expect(cancelDownload).not.toHaveBeenCalled();
    expect(state.open).toBe(false);
  });

  it("closes without cancelling the background download when dismissed with Escape", async () => {
    const { state, cancelDownload } = await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: 42 });

    await pressEscape();

    expect(cancelDownload).not.toHaveBeenCalled();
    expect(state.open).toBe(false);
  });

  it("cancels the download only when the explicit Cancel Download button is clicked", async () => {
    const { cancelDownload } = await mountDialog(0, { isDownloadingUpdate: true, downloadProgress: 42 });

    cancelDownloadButton()?.click();
    await flushDialog();

    expect(cancelDownload).toHaveBeenCalledOnce();
  });

  it("allows closing while a downloaded update is idle", async () => {
    const { state } = await mountDialog(0, { updateDownloaded: true, downloadProgress: 100 });

    expect(buttonWithText("Cancel")).toBeDefined();
    expect(document.body.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await pressEscape();

    expect(state.open).toBe(false);
  });

  it("prevents closing while installation is in progress", async () => {
    const { state } = await mountDialog(0, { updateDownloaded: true, isInstallingUpdate: true });

    expect(buttonWithText("Cancel")).toBeUndefined();
    expect(document.body.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await pressEscape();

    expect(state.open).toBe(true);
  });

  it("allows closing after installation rejects", async () => {
    let rejectInstall!: (error: Error) => void;
    const installDownloaded = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        }),
    );
    const { state } = await mountDialog(0, { updateDownloaded: true }, installDownloaded);

    installDownloadedButton()?.click();
    await flushDialog();
    await pressEscape();
    expect(state.open).toBe(true);

    rejectInstall(new Error("install failed"));
    await flushDialog();
    expect(buttonWithText("Cancel")).toBeDefined();
    await pressEscape();

    expect(state.open).toBe(false);
  });

  it("retries the retained download after reopening without downloading again", async () => {
    const installDownloaded = vi.fn(async () => {
      throw new Error("install failed");
    });
    const { state, downloadInBackground } = await mountDialog(0, { updateDownloaded: true }, installDownloaded);

    installDownloadedButton()?.click();
    await flushDialog();
    await pressEscape();
    state.open = true;
    await flushDialog();
    installDownloadedButton()?.click();
    await flushDialog();

    expect(installDownloaded).toHaveBeenCalledTimes(2);
    expect(downloadInBackground).not.toHaveBeenCalled();
  });

  it("allows dismissing after a successful install while restart remains available", async () => {
    const installDownloaded = vi.fn(async () => {});
    const { state, downloadInBackground } = await mountDialog(0, { updateDownloaded: true }, installDownloaded);

    installDownloadedButton()?.click();
    await flushDialog();

    expect(state.updateDownloaded).toBe(false);
    expect(state.updateReady).toBe(true);
    expect(buttonWithText("Restart")).toBeDefined();
    expect(buttonWithText("Cancel")).toBeDefined();
    await pressEscape();
    expect(state.open).toBe(false);
    expect(installDownloaded).toHaveBeenCalledOnce();
    expect(downloadInBackground).not.toHaveBeenCalled();
  });
});

describe("UpdateDialog ignore version", () => {
  it("emits ignore-version when the ignore button is clicked", async () => {
    const { ignoreVersion } = await mountDialog(0);

    const ignoreButton = buttonWithText("Ignore this version");
    expect(ignoreButton).toBeDefined();
    ignoreButton?.click();
    await flushDialog();

    expect(ignoreVersion).toHaveBeenCalledOnce();
  });

  it("hides the ignore button once an update has been downloaded", async () => {
    await mountDialog(0, { updateDownloaded: true, downloadProgress: 100 });

    expect(buttonWithText("Ignore this version")).toBeUndefined();
  });

  it("disables the ignore button while the setting is being persisted", async () => {
    await mountDialog(0, { isIgnoringUpdate: true });

    expect(buttonWithText("Ignore this version")?.disabled).toBe(true);
  });
});
