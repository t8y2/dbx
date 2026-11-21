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
const APP_SHELL_MIN_WIDTH_PX = 760;
const APP_SHELL_MIN_HEIGHT_PX = 600;

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

/**
 * 应用外壳（data-app-shell）的最小可用尺寸。
 *
 * webview 缩放是重排式的（pageZoom / ZoomFactor）：倍率越大 CSS 视口越小，
 * 因此 760x600 的最小可用尺寸必须以 *视觉* 像素为基准，换算成 CSS 像素时
 * 除以实际倍率——固定 CSS 下限会在约 窗口高/600 的倍率后超出视口，把应用
 * 底部（如设置页脚按钮）挤出窗口导致无法点击。100% 缩放时输出与 760x600
 * 完全一致，保留 fix(desktop): prevent scaled window clipping 的保护。
 */
export function appShellMinSizeStyleForScale(scale: number): { minWidth: string; minHeight: string } {
  const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    minWidth: `${Math.ceil(APP_SHELL_MIN_WIDTH_PX / normalizedScale)}px`,
    minHeight: `${Math.ceil(APP_SHELL_MIN_HEIGHT_PX / normalizedScale)}px`,
  };
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

export interface LinuxFloatingFrameState {
  isLinux: boolean;
  isDesktop: boolean;
  /** Only the main window is created transparent; detached-tab and plugin windows are opaque. */
  isMainWindow: boolean;
  /** The main window is only transparent when a compositing manager is running. */
  compositing: boolean;
  /** Login/setup pages paint the whole window themselves. */
  showingAuthPage: boolean;
  isMaximized: boolean;
  isFullscreen: boolean;
}

// Compositors draw neither shadow nor rounded corners for undecorated windows, so on Linux
// the transparent main window (see create_linux_main_window) paints its own: a transparent
// margin that carries the shadow, and a rounded shell. Maximized/fullscreen windows must fill
// the screen, so the floating frame is dropped there.
export function shouldDrawLinuxFloatingFrame(state: LinuxFloatingFrameState): boolean {
  return state.isDesktop && state.isLinux && state.isMainWindow && state.compositing && !state.showingAuthPage && !state.isMaximized && !state.isFullscreen;
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
