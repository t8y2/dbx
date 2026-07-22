import { ref, onMounted, onUnmounted } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";
import * as api from "@/lib/backend/api";

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
  const isMac = isMacOS();
  const isDesktop = isTauriRuntime();
  const showControls = shouldShowWindowControls(isMac, isDesktop);

  let unlisten: (() => void) | null = null;

  async function updateWindowState() {
    if (!isDesktop) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    const [maximized, fullscreen] = await Promise.all([currentWindow.isMaximized(), currentWindow.isFullscreen()]);
    isMaximized.value = maximized;
    isFullscreen.value = fullscreen;
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

  async function close() {
    if (!isDesktop) return;
    await api.requestAppClose();
  }

  onMounted(async () => {
    if (!isDesktop) return;
    await updateWindowState();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const unlistenFn = await getCurrentWindow().onResized(() => {
      void updateWindowState();
    });
    unlisten = unlistenFn;
  });

  onUnmounted(() => {
    unlisten?.();
  });

  return {
    isMac,
    isDesktop,
    showControls,
    isMaximized,
    isFullscreen,
    minimize,
    toggleMaximize,
    close,
  };
}
