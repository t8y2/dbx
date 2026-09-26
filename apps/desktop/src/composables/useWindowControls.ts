import { ref, onMounted, onUnmounted } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";
import * as api from "@/lib/backend/api";
import { raiseDetachedWindowsAboveMain, WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, type WindowAlwaysOnTopChangedPayload } from "@/lib/app/windowAlwaysOnTop";

const MIN_UI_SCALE = 0.75;
const MAX_UI_SCALE = 2;
export const MAC_TRAFFIC_LIGHT_X = 16;
export const MAC_TRAFFIC_LIGHT_BASE_Y = 18;
const MAC_TRAFFIC_LIGHT_SCALE_DELTA_Y = 20;
const MAC_TRAFFIC_LIGHT_RESERVED_INSET = 70;

function normalizeTrafficLightUiScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, scale)) : 1;
}

export function macTrafficLightPositionForScale(scale: number): { x: number; y: number } {
  const normalizedScale = normalizeTrafficLightUiScale(scale);
  return {
    x: MAC_TRAFFIC_LIGHT_X,
    y: Math.round(MAC_TRAFFIC_LIGHT_BASE_Y + (normalizedScale - 1) * MAC_TRAFFIC_LIGHT_SCALE_DELTA_Y),
  };
}

export function macTrafficLightInsetPaddingForScale(scale: number): string {
  const normalizedScale = normalizeTrafficLightUiScale(scale);
  return `${Math.ceil(MAC_TRAFFIC_LIGHT_RESERVED_INSET / normalizedScale)}px`;
}

export function shouldReserveMacTrafficLightInset(isMac: boolean, isFullscreen: boolean, isDesktop = true): boolean {
  return isDesktop && isMac && !isFullscreen;
}

export function shouldShowWindowControls(isMac: boolean, isDesktop = true): boolean {
  return isDesktop && !isMac;
}

export function shouldDrawDesktopWindowFrame(isMac: boolean, isDesktop = true, isWindows = false): boolean {
  // Windows frameless+shadow windows already get a DWM 1px border on all sides.
  // An extra CSS top hairline stacks on that edge and no longer matches left/right/bottom.
  return isDesktop && !isMac && !isWindows;
}

export function useWindowControls() {
  const isMaximized = ref(false);
  const isFullscreen = ref(false);
  const isAlwaysOnTop = ref(false);
  const isMac = isMacOS();
  const isDesktop = isTauriRuntime();
  const showControls = shouldShowWindowControls(isMac, isDesktop);

  let unlistenResize: (() => void) | null = null;
  let unlistenFocus: (() => void) | null = null;
  let unlistenAlwaysOnTop: (() => void) | null = null;

  async function updateWindowState() {
    if (!isDesktop) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    const [maximized, fullscreen, alwaysOnTop] = await Promise.all([currentWindow.isMaximized(), currentWindow.isFullscreen(), currentWindow.isAlwaysOnTop()]);
    isMaximized.value = maximized;
    isFullscreen.value = fullscreen;
    isAlwaysOnTop.value = alwaysOnTop;
  }

  async function refreshAlwaysOnTopState() {
    if (!isDesktop) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    isAlwaysOnTop.value = await getCurrentWindow().isAlwaysOnTop();
  }

  async function minimize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }

  async function toggleMaximize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
    setTimeout(updateWindowState, 50);
  }

  async function toggleAlwaysOnTop() {
    if (!isDesktop) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    const next = !isAlwaysOnTop.value;
    await currentWindow.setAlwaysOnTop(next);
    isAlwaysOnTop.value = await currentWindow.isAlwaysOnTop();
    if (next && currentWindow.label === "main") {
      await raiseDetachedWindowsAboveMain();
    }
  }

  async function close() {
    if (!isDesktop) return;
    await api.requestAppClose();
  }

  onMounted(async () => {
    if (!isDesktop) return;
    await updateWindowState();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    const windowLabel = currentWindow.label;
    unlistenResize = await currentWindow.onResized(() => {
      void updateWindowState();
    });
    unlistenFocus = await currentWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) void refreshAlwaysOnTopState();
    });
    const { listen } = await import("@tauri-apps/api/event");
    unlistenAlwaysOnTop = await listen<WindowAlwaysOnTopChangedPayload>(WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || payload.windowLabel !== windowLabel || typeof payload.alwaysOnTop !== "boolean") return;
      isAlwaysOnTop.value = payload.alwaysOnTop;
    });
  });

  onUnmounted(() => {
    unlistenResize?.();
    unlistenFocus?.();
    unlistenAlwaysOnTop?.();
  });

  return {
    isMac,
    isDesktop,
    showControls,
    isMaximized,
    isFullscreen,
    isAlwaysOnTop,
    minimize,
    toggleMaximize,
    toggleAlwaysOnTop,
    close,
  };
}
