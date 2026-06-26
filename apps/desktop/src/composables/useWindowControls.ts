import { ref, onMounted, onUnmounted } from "vue";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isMacOS } from "@/lib/platform";

export function shouldReserveMacTrafficLightInset(isMac: boolean, isFullscreen: boolean, isDesktop = true): boolean {
  return isDesktop && isMac && !isFullscreen;
}

export function shouldShowWindowControls(isMac: boolean, isDesktop = true): boolean {
  return isDesktop && !isMac;
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
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
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
