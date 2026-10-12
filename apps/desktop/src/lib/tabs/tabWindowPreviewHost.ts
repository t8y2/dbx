import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { TAB_DRAG_PREVIEW_HOST_PADDING } from "@/lib/tabs/tabWindowPreview";
import type { TabDragAppearance } from "@/lib/tabs/tabDragAppearance";
export const TAB_DRAG_PREVIEW_WINDOW_PREFIX = "dbx-tab-drag-preview";
export const TAB_DRAG_PREVIEW_WEBVIEW_LABEL = "dbx-tab-drag-preview";
export const TAB_DRAG_PREVIEW_CONTENT_EVENT = "dbx:tab-drag-preview-content";
export const TAB_DRAG_PREVIEW_READY_EVENT = "dbx:tab-drag-preview-ready";
let tabDragPreviewWebviewCreationPending = false;
let tabDragPreviewWebviewShouldBeVisible = false;
let pendingTabDragPreviewContent: { appearance: TabDragAppearance; cursorPhysical: { x: number; y: number } } | null = null;
let stopReadyListener: (() => void) | undefined;
let sentAppearance: TabDragAppearance | undefined;
let previewReady = false;
export type TabDragPreviewContentPayload = TabDragAppearance;

export function tabDragPreviewHostBounds(appearance: TabDragAppearance, cursorPhysical: { x: number; y: number }) {
  // 以源标签的物理像素尺寸和抓取位置为准，同时兼容源窗口 UI 缩放。
  return {
    x: Math.round(cursorPhysical.x - (appearance.grabX + TAB_DRAG_PREVIEW_HOST_PADDING) * appearance.pixelRatio),
    y: Math.round(cursorPhysical.y - (appearance.grabY + TAB_DRAG_PREVIEW_HOST_PADDING) * appearance.pixelRatio),
    width: Math.ceil((appearance.width + TAB_DRAG_PREVIEW_HOST_PADDING * 2) * appearance.pixelRatio),
    height: Math.ceil((appearance.height + TAB_DRAG_PREVIEW_HOST_PADDING * 2) * appearance.pixelRatio),
  };
}

async function updateHost(preview: import("@tauri-apps/api/webviewWindow").WebviewWindow) {
  const pending = pendingTabDragPreviewContent;
  if (!tabDragPreviewWebviewShouldBeVisible || !pending) return;
  const [{ PhysicalPosition, PhysicalSize }, { emitTo }] = await Promise.all([import("@tauri-apps/api/dpi"), import("@tauri-apps/api/event")]);
  if (!tabDragPreviewWebviewShouldBeVisible) return;
  const bounds = tabDragPreviewHostBounds(pending.appearance, pending.cursorPhysical);
  if (sentAppearance !== pending.appearance) await preview.setSize(new PhysicalSize(bounds.width, bounds.height));
  await preview.setPosition(new PhysicalPosition(bounds.x, bounds.y));
  // 展示数据只在首次就绪/快照变化时发送；跟随鼠标时只移动宿主窗口。
  if (tabDragPreviewWebviewShouldBeVisible && previewReady && sentAppearance !== pending.appearance) {
    await emitTo({ kind: "WebviewWindow", label: TAB_DRAG_PREVIEW_WEBVIEW_LABEL }, TAB_DRAG_PREVIEW_CONTENT_EVENT, pending.appearance);
    sentAppearance = pending.appearance;
  }
}

export async function showTabDragPreviewWebview(appearance: TabDragAppearance, cursorPhysical: { x: number; y: number }): Promise<void> {
  if (!isTauriRuntime() || appearance.width <= 0 || appearance.height <= 0) return;
  tabDragPreviewWebviewShouldBeVisible = true;
  pendingTabDragPreviewContent = { appearance, cursorPhysical };
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  if (!tabDragPreviewWebviewShouldBeVisible) return;
  const existing = await WebviewWindow.getByLabel(TAB_DRAG_PREVIEW_WEBVIEW_LABEL);
  if (existing) {
    await updateHost(existing);
    return;
  }
  if (tabDragPreviewWebviewCreationPending) return;
  tabDragPreviewWebviewCreationPending = true;
  previewReady = false;
  sentAppearance = undefined;
  const current = getCurrentWebviewWindow();
  stopReadyListener?.();
  try {
    stopReadyListener = await current.listen<{ label: string }>(TAB_DRAG_PREVIEW_READY_EVENT, ({ payload }) => {
      if (!tabDragPreviewWebviewShouldBeVisible || payload.label !== TAB_DRAG_PREVIEW_WEBVIEW_LABEL) return;
      previewReady = true;
      void WebviewWindow.getByLabel(payload.label)
        .then((preview) => preview && updateHost(preview))
        .catch(() => {});
    });
  } catch (error) {
    tabDragPreviewWebviewCreationPending = false;
    throw error;
  }
  if (!tabDragPreviewWebviewShouldBeVisible) {
    stopReadyListener();
    stopReadyListener = undefined;
    tabDragPreviewWebviewCreationPending = false;
    return;
  }

  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ tabDragPreview: "1" }).toString();
  url.searchParams.set("source", current.label);
  const preview = new WebviewWindow(TAB_DRAG_PREVIEW_WEBVIEW_LABEL, {
    url: url.toString(),
    title: "DBX tab preview",
    width: appearance.width + TAB_DRAG_PREVIEW_HOST_PADDING * 2,
    height: appearance.height + TAB_DRAG_PREVIEW_HOST_PADDING * 2,
    visible: false,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    shadow: false,
  });
  void preview.once("tauri://created", async () => {
    tabDragPreviewWebviewCreationPending = false;
    // 透明鼠标穿透能力在不同平台上的可用性不同，不能因为它失败而让
    // 预览宿主窗口始终保持隐藏。
    await preview.setIgnoreCursorEvents(true).catch(() => undefined);
    await preview.setAlwaysOnTop(true).catch(() => undefined);
    const pending = pendingTabDragPreviewContent;
    if (!tabDragPreviewWebviewShouldBeVisible || !pending) {
      await preview.destroy().catch(() => undefined);
      return;
    }
    await updateHost(preview).catch(() => {});
  });
  void preview.once("tauri://error", () => {
    tabDragPreviewWebviewCreationPending = false;
    stopReadyListener?.();
    stopReadyListener = undefined;
  });
}

export async function hideTabDragPreviewWebview(): Promise<void> {
  if (!isTauriRuntime()) return;
  tabDragPreviewWebviewShouldBeVisible = false;
  pendingTabDragPreviewContent = null;
  sentAppearance = undefined;
  previewReady = false;
  stopReadyListener?.();
  stopReadyListener = undefined;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const preview = await WebviewWindow.getByLabel(TAB_DRAG_PREVIEW_WEBVIEW_LABEL);
  await preview?.destroy();
}
