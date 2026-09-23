import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const DETACHED_WINDOW_LABEL_PREFIX = "detached-tab-";

export const WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT = "dbx:window-always-on-top-changed";
export const ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT = "dbx:always-on-top-toolbar-visibility-changed";

export async function emitAlwaysOnTopToolbarVisibilityChanged(visible: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, visible);
  } catch (error) {
    console.error("[DBX][window:always-on-top-toolbar-visibility-event]", error);
  }
}

export type WindowAlwaysOnTopChangedPayload = {
  windowLabel: string;
  alwaysOnTop: boolean;
};

export async function emitWindowAlwaysOnTopChanged(windowLabel: string, alwaysOnTop: boolean): Promise<void> {
  if (!isTauriRuntime() || !windowLabel) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    const payload: WindowAlwaysOnTopChangedPayload = { windowLabel, alwaysOnTop };
    await emit(WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, payload);
  } catch (error) {
    console.error("[DBX][window:always-on-top-event]", windowLabel, error);
  }
}

/** Keep detached windows in the same always-on-top band and above the main host. */
export async function raiseDetachedWindowsAboveMain(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  const windows = await getAllWebviewWindows();
  for (const win of windows) {
    if (!win.label.startsWith(DETACHED_WINDOW_LABEL_PREFIX)) continue;
    try {
      await win.setAlwaysOnTop(true);
      await emitWindowAlwaysOnTopChanged(win.label, true);
      await win.show();
      await win.setFocus();
    } catch (error) {
      console.error("[DBX][window:raise-detached]", win.label, error);
    }
  }
}

type DetachedAlwaysOnTopTarget = {
  label?: string;
  setAlwaysOnTop: (value: boolean) => Promise<void>;
};

/** If the main window is pinned, pin this detached window so it stays visible above the host. */
export async function pinDetachedWindowIfMainPinned(detached: DetachedAlwaysOnTopTarget): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const main = await WebviewWindow.getByLabel("main");
  if (!main) return;
  try {
    if (await main.isAlwaysOnTop()) {
      await detached.setAlwaysOnTop(true);
      if (detached.label) {
        await emitWindowAlwaysOnTopChanged(detached.label, true);
      }
    }
  } catch (error) {
    console.error("[DBX][window:pin-detached-from-main]", error);
  }
}
