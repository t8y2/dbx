import type { SavedOpenTab } from "@/lib/app/openTabsPersistence";
import { serializeOpenTabs } from "@/lib/app/openTabsPersistence";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { uuid } from "@/lib/common/utils";
import { TAB_DRAG_PREVIEW_GRAB_X, TAB_DRAG_PREVIEW_GRAB_Y, TAB_DRAG_PREVIEW_HEIGHT, TAB_DRAG_PREVIEW_HOST_PADDING, TAB_DRAG_PREVIEW_WIDTH } from "@/lib/tabs/tabWindowPreview";
import type { QueryTab } from "@/types/database";

export const TAB_WINDOW_TRANSFER_MIME = "application/x-dbx-tab";
export const TAB_WINDOW_TRANSFER_TEXT_PREFIX = "dbx-tab-transfer:";
export const TAB_WINDOW_TRANSFER_EVENT = "dbx:tab-window-transfer";
export const TAB_WINDOW_DRAG_PREVIEW_EVENT = "dbx:tab-window-drag-preview";
export const TAB_NATIVE_DRAG_PREVIEW_RELEASE_EVENT = "dbx:tab-drag-preview-release";
export const TAB_WINDOW_INFO_REQUEST_EVENT = "dbx:tab-window-info-request";
export const TAB_WINDOW_INFO_RESPONSE_EVENT = "dbx:tab-window-info-response";
export const TAB_DRAG_PREVIEW_WINDOW_PREFIX = "dbx-tab-drag-preview";
export const TAB_DRAG_PREVIEW_WEBVIEW_LABEL = "dbx-tab-drag-preview";
export const TAB_DRAG_PREVIEW_CONTENT_EVENT = "dbx:tab-drag-preview-content";
const DETACHED_TAB_QUERY = "dbxTransfer";
const DETACHED_TAB_WINDOW_SESSION_KEY = "dbx-detached-tab-window";
const TRANSFER_STORAGE_PREFIX = "dbx-tab-window-transfer:";
const ACCEPTED_STORAGE_PREFIX = "dbx-tab-window-transfer-accepted:";
const ACTIVE_TRANSFER_STORAGE_KEY = "dbx-active-tab-window-transfer";
const ACTIVE_TRANSFER_MAX_AGE_MS = 20_000;
let tabDragPreviewWebviewCreationPending = false;
let tabDragPreviewWebviewShouldBeVisible = false;
let pendingTabDragPreviewContent: { title: string; cursorPhysical: { x: number; y: number } } | null = null;
let tabDragPreviewMonitor: { x: number; y: number; width: number; height: number; scaleFactor: number } | null = null;

function isTransferableTabWindowLabel(label: string): boolean {
  return label === "main" || (label.startsWith("dbx-tab-") && !label.startsWith(TAB_DRAG_PREVIEW_WINDOW_PREFIX));
}

export interface TabWindowTransferPayload {
  transferId: string;
  sourceWindowLabel: string;
  tab: SavedOpenTab;
  /** Live state is kept separately from persisted tab state so results and editor context survive a move. */
  liveTab?: QueryTab;
  /** Physical release position used by the destination tab strip to preserve insertion order. */
  dropCursorPhysical?: { x: number; y: number };
}

/** Temporary cursor state broadcast while a tab is being dragged between DBX windows. */
export interface TabWindowDragPreviewPayload {
  transferId: string;
  sourceWindowLabel: string;
  targetWindowLabel?: string;
  title: string;
  cursorPhysical: { x: number; y: number };
  sequence: number;
  visible: boolean;
}

export interface TabDragPreviewContentPayload {
  title: string;
}

export interface TabWindowPlacement {
  /** Desktop logical coordinates expected by Tauri's WebviewWindow options. */
  x: number;
  y: number;
}

/** 供显式标签转移选择的 DBX 窗口。 */
export interface TabWindowTarget {
  label: string;
  title: string;
}

export interface NativeTabDragPreviewRelease {
  transferId: string;
  sourceWindowLabel: string;
  cursorX: number;
  cursorY: number;
  left: number;
  top: number;
}

export interface TabWindowInfoRequest {
  requestId: string;
  sourceWindowLabel: string;
}

export interface TabWindowInfoResponse {
  requestId: string;
  windowLabel: string;
  activeTabTitle: string;
}

function jsonSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function transferStorageKey(transferId: string): string {
  return `${TRANSFER_STORAGE_PREFIX}${transferId}`;
}

function acceptedStorageKey(transferId: string): string {
  return `${ACCEPTED_STORAGE_PREFIX}${transferId}`;
}

function activeTransferStorageValue(transferId: string): string {
  return JSON.stringify({ transferId, startedAt: Date.now() });
}

export function isDetachedTabWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).has(DETACHED_TAB_QUERY)) return true;
  try {
    return window.sessionStorage.getItem(DETACHED_TAB_WINDOW_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function detachedTabTransferToken(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(DETACHED_TAB_QUERY);
}

export function createTabWindowTransfer(tab: QueryTab, sourceWindowLabel: string): TabWindowTransferPayload {
  return {
    transferId: uuid(),
    sourceWindowLabel,
    tab: serializeOpenTabs([tab])[0]!,
    liveTab: JSON.parse(JSON.stringify(tab, jsonSafeReplacer)) as QueryTab,
  };
}

export function encodeTabWindowTransfer(payload: TabWindowTransferPayload): string {
  return JSON.stringify(payload, jsonSafeReplacer);
}

export function encodeTabWindowTransferToken(transferId: string): string {
  return `${TAB_WINDOW_TRANSFER_TEXT_PREFIX}${transferId}`;
}

export function decodeTabWindowTransferToken(value: string | null | undefined): string | null {
  if (!value?.startsWith(TAB_WINDOW_TRANSFER_TEXT_PREFIX)) return null;
  const transferId = value.slice(TAB_WINDOW_TRANSFER_TEXT_PREFIX.length).trim();
  return transferId || null;
}

export function decodeTabWindowTransfer(value: string | null | undefined): TabWindowTransferPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TabWindowTransferPayload>;
    if (!parsed.transferId || !parsed.sourceWindowLabel || !parsed.tab || typeof parsed.tab.id !== "string") return null;
    if (parsed.liveTab !== undefined && (!parsed.liveTab || typeof parsed.liveTab.id !== "string")) return null;
    return parsed as TabWindowTransferPayload;
  } catch {
    return null;
  }
}

export function storeDetachedTabTransfer(payload: TabWindowTransferPayload): void {
  safeLocalStorageSet(transferStorageKey(payload.transferId), encodeTabWindowTransfer(payload));
  // Chromium does not consistently expose drag DataTransfer data to a separate
  // WebView during `dragover`. Publish the active transfer so every DBX window
  // can still recognize the drop before the browser reveals `getData()`.
  safeLocalStorageSet(ACTIVE_TRANSFER_STORAGE_KEY, activeTransferStorageValue(payload.transferId));
}

export function readTabWindowTransfer(transferId: string): TabWindowTransferPayload | null {
  return decodeTabWindowTransfer(safeLocalStorageGet(transferStorageKey(transferId)));
}

export function readActiveTabWindowTransfer(): TabWindowTransferPayload | null {
  const raw = safeLocalStorageGet(ACTIVE_TRANSFER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const active = JSON.parse(raw) as { transferId?: unknown; startedAt?: unknown };
    if (typeof active.transferId !== "string" || typeof active.startedAt !== "number" || Date.now() - active.startedAt > ACTIVE_TRANSFER_MAX_AGE_MS) {
      safeLocalStorageRemove(ACTIVE_TRANSFER_STORAGE_KEY);
      return null;
    }
    const payload = readTabWindowTransfer(active.transferId);
    if (!payload) safeLocalStorageRemove(ACTIVE_TRANSFER_STORAGE_KEY);
    return payload;
  } catch {
    safeLocalStorageRemove(ACTIVE_TRANSFER_STORAGE_KEY);
    return null;
  }
}

export function clearTabWindowTransfer(transferId: string): void {
  safeLocalStorageRemove(transferStorageKey(transferId));
  try {
    const active = JSON.parse(safeLocalStorageGet(ACTIVE_TRANSFER_STORAGE_KEY) ?? "null") as { transferId?: unknown } | null;
    if (active?.transferId === transferId) safeLocalStorageRemove(ACTIVE_TRANSFER_STORAGE_KEY);
  } catch {
    safeLocalStorageRemove(ACTIVE_TRANSFER_STORAGE_KEY);
  }
}

export function consumeDetachedTabTransfer(): TabWindowTransferPayload | null {
  const token = detachedTabTransferToken();
  if (!token) return null;
  // The transfer token is intentionally removed from the URL after startup.
  // Keep the detached-window role for the lifetime of this WebView so it
  // cannot later overwrite the main window's global open-tabs state.
  try {
    window.sessionStorage.setItem(DETACHED_TAB_WINDOW_SESSION_KEY, "1");
  } catch {
    // The URL token remains sufficient for this startup if session storage is unavailable.
  }
  const payload = readTabWindowTransfer(token);
  clearTabWindowTransfer(token);
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.searchParams.delete(DETACHED_TAB_QUERY);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return payload;
}

export function markTabWindowTransferAccepted(transferId: string): void {
  safeLocalStorageSet(acceptedStorageKey(transferId), String(Date.now()));
}

export function consumeTabWindowTransferAccepted(transferId: string): boolean {
  const key = acceptedStorageKey(transferId);
  const accepted = safeLocalStorageGet(key) !== null;
  if (accepted) safeLocalStorageRemove(key);
  return accepted;
}

export async function waitForTabWindowTransferAccepted(transferId: string, timeoutMs = 350): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (consumeTabWindowTransferAccepted(transferId)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return consumeTabWindowTransferAccepted(transferId);
}

/**
 * Finds the DBX window physically below the pointer when a native drag ends.
 * WebView2 does not reliably deliver DOM `drop` events between WebViews, so
 * this source-side hit test is the authoritative cross-window destination.
 */
export async function tabWindowAtCursor(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { cursorPosition, getAllWindows, getCurrentWindow } = await import("@tauri-apps/api/window");
  const cursor = await cursorPosition();
  const sourceWindowLabel = getCurrentWindow().label;
  const windows = await getAllWindows();
  const candidates = await Promise.all(
    windows
      // The native preview follows the cursor, so it would always win this hit
      // test unless it is explicitly excluded from transferable destinations.
      .filter((window) => window.label !== sourceWindowLabel && !window.label.startsWith(TAB_DRAG_PREVIEW_WINDOW_PREFIX))
      .map(async (window) => {
        try {
          const [position, size, focused] = await Promise.all([window.outerPosition(), window.outerSize(), window.isFocused()]);
          const containsCursor = cursor.x >= position.x && cursor.x < position.x + size.width && cursor.y >= position.y && cursor.y < position.y + size.height;
          return containsCursor ? { label: window.label, focused } : null;
        } catch {
          return null;
        }
      }),
  );
  // A drop focuses its target on Windows. Prefer that window if native window
  // rectangles overlap, while preserving deterministic behavior otherwise.
  return candidates.filter((candidate): candidate is { label: string; focused: boolean } => !!candidate).sort((a, b) => Number(b.focused) - Number(a.focused))[0]?.label ?? null;
}

/** Finds the visible DBX tab window containing a physical desktop point. */
export async function tabWindowAtPhysicalPosition(cursorPhysical: { x: number; y: number }): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { getAllWindows } = await import("@tauri-apps/api/window");
  const windows = await getAllWindows();
  const candidates = await Promise.all(
    windows
      .filter((window) => isTransferableTabWindowLabel(window.label))
      .map(async (window) => {
        try {
          const [position, size, focused, visible, minimized] = await Promise.all([window.outerPosition(), window.outerSize(), window.isFocused(), window.isVisible(), window.isMinimized()]);
          const containsCursor = visible && !minimized && cursorPhysical.x >= position.x && cursorPhysical.x < position.x + size.width && cursorPhysical.y >= position.y && cursorPhysical.y < position.y + size.height;
          return containsCursor ? { label: window.label, focused } : null;
        } catch {
          return null;
        }
      }),
  );
  return candidates.filter((candidate): candidate is { label: string; focused: boolean } => !!candidate).sort((a, b) => Number(b.focused) - Number(a.focused))[0]?.label ?? null;
}

/** 列出其他可接收标签转移的 DBX 窗口。 */
export async function listOtherTabWindows(): Promise<TabWindowTarget[]> {
  if (!isTauriRuntime()) return [];
  const { getAllWindows, getCurrentWindow } = await import("@tauri-apps/api/window");
  const sourceWindowLabel = getCurrentWindow().label;
  const windows = await getAllWindows();
  const targets = await Promise.all(
    windows
      .filter((window) => window.label !== sourceWindowLabel && isTransferableTabWindowLabel(window.label))
      .map(async (window) => {
        try {
          return { label: window.label, title: await window.title() };
        } catch {
          return null;
        }
      }),
  );
  return targets.filter((target): target is TabWindowTarget => !!target).sort((left, right) => left.label.localeCompare(right.label));
}

export async function sendTabWindowTransfer(targetWindowLabel: string, payload: TabWindowTransferPayload): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo({ kind: "WebviewWindow", label: targetWindowLabel }, TAB_WINDOW_TRANSFER_EVENT, payload);
    return true;
  } catch {
    return false;
  }
}

export async function requestTabWindowInfo(targetWindowLabel: string, payload: TabWindowInfoRequest): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo({ kind: "WebviewWindow", label: targetWindowLabel }, TAB_WINDOW_INFO_REQUEST_EVENT, payload);
    return true;
  } catch {
    return false;
  }
}

export async function sendTabWindowInfoResponse(targetWindowLabel: string, payload: TabWindowInfoResponse): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo({ kind: "WebviewWindow", label: targetWindowLabel }, TAB_WINDOW_INFO_RESPONSE_EVENT, payload);
    return true;
  } catch {
    return false;
  }
}

export async function listenForTabWindowTransfer(handler: (payload: TabWindowTransferPayload) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TabWindowTransferPayload>(TAB_WINDOW_TRANSFER_EVENT, (event) => handler(event.payload));
}

export async function listenForTabWindowInfoRequest(handler: (payload: TabWindowInfoRequest) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TabWindowInfoRequest>(TAB_WINDOW_INFO_REQUEST_EVENT, (event) => handler(event.payload));
}

export async function listenForTabWindowInfoResponse(handler: (payload: TabWindowInfoResponse) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TabWindowInfoResponse>(TAB_WINDOW_INFO_RESPONSE_EVENT, (event) => handler(event.payload));
}

export async function emitTabWindowDragPreview(payload: TabWindowDragPreviewPayload): Promise<void> {
  if (!isTauriRuntime()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(TAB_WINDOW_DRAG_PREVIEW_EVENT, payload);
}

async function tabDragPreviewHostPosition(cursorPhysical: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const cachedMonitor = tabDragPreviewMonitor;
  if (!cachedMonitor || cursorPhysical.x < cachedMonitor.x || cursorPhysical.x >= cachedMonitor.x + cachedMonitor.width || cursorPhysical.y < cachedMonitor.y || cursorPhysical.y >= cachedMonitor.y + cachedMonitor.height) {
    const { monitorFromPoint } = await import("@tauri-apps/api/window");
    const monitor = await monitorFromPoint(cursorPhysical.x, cursorPhysical.y).catch(() => null);
    tabDragPreviewMonitor = monitor
      ? {
          x: monitor.position.x,
          y: monitor.position.y,
          width: monitor.size.width,
          height: monitor.size.height,
          scaleFactor: monitor.scaleFactor,
        }
      : null;
  }
  const scaleFactor = tabDragPreviewMonitor?.scaleFactor ?? 1;
  const horizontalOffset = (TAB_DRAG_PREVIEW_GRAB_X + TAB_DRAG_PREVIEW_HOST_PADDING) * scaleFactor;
  const verticalOffset = (TAB_DRAG_PREVIEW_GRAB_Y + TAB_DRAG_PREVIEW_HOST_PADDING) * scaleFactor;
  return {
    x: Math.round(cursorPhysical.x - horizontalOffset),
    y: Math.round(cursorPhysical.y - verticalOffset),
  };
}

export async function showTabDragPreviewWebview(title: string, cursorPhysical: { x: number; y: number }): Promise<void> {
  if (!isTauriRuntime()) return;
  tabDragPreviewWebviewShouldBeVisible = true;
  pendingTabDragPreviewContent = { title, cursorPhysical };
  const [{ WebviewWindow }, { emitTo }, { PhysicalPosition }] = await Promise.all([import("@tauri-apps/api/webviewWindow"), import("@tauri-apps/api/event"), import("@tauri-apps/api/dpi")]);
  if (!tabDragPreviewWebviewShouldBeVisible) return;
  const existing = await WebviewWindow.getByLabel(TAB_DRAG_PREVIEW_WEBVIEW_LABEL);
  if (existing) {
    const pending = pendingTabDragPreviewContent;
    if (!tabDragPreviewWebviewShouldBeVisible || !pending) return;
    await emitTo({ kind: "WebviewWindow", label: TAB_DRAG_PREVIEW_WEBVIEW_LABEL }, TAB_DRAG_PREVIEW_CONTENT_EVENT, { title: pending.title } satisfies TabDragPreviewContentPayload).catch(() => undefined);
    const position = await tabDragPreviewHostPosition(pending.cursorPhysical);
    if (!tabDragPreviewWebviewShouldBeVisible) return;
    await existing.setPosition(new PhysicalPosition(position.x, position.y)).catch(() => undefined);
    if (tabDragPreviewWebviewShouldBeVisible) await existing.show();
    return;
  }
  if (tabDragPreviewWebviewCreationPending) return;
  tabDragPreviewWebviewCreationPending = true;

  const url = new URL(window.location.href);
  url.searchParams.set("tabDragPreview", "1");
  url.searchParams.set("title", title);
  const preview = new WebviewWindow(TAB_DRAG_PREVIEW_WEBVIEW_LABEL, {
    url: url.toString(),
    title: "DBX tab preview",
    width: TAB_DRAG_PREVIEW_WIDTH + TAB_DRAG_PREVIEW_HOST_PADDING * 2,
    height: TAB_DRAG_PREVIEW_HEIGHT + TAB_DRAG_PREVIEW_HOST_PADDING * 2,
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
      await preview.hide().catch(() => undefined);
      return;
    }
    await emitTo({ kind: "WebviewWindow", label: TAB_DRAG_PREVIEW_WEBVIEW_LABEL }, TAB_DRAG_PREVIEW_CONTENT_EVENT, { title: pending.title } satisfies TabDragPreviewContentPayload).catch(() => undefined);
    const position = await tabDragPreviewHostPosition(pending.cursorPhysical);
    if (!tabDragPreviewWebviewShouldBeVisible) return;
    await preview.setPosition(new PhysicalPosition(position.x, position.y)).catch(() => undefined);
    if (!tabDragPreviewWebviewShouldBeVisible) return;
    await preview.show();
  });
  void preview.once("tauri://error", () => {
    tabDragPreviewWebviewCreationPending = false;
  });
}

export async function hideTabDragPreviewWebview(): Promise<void> {
  if (!isTauriRuntime()) return;
  tabDragPreviewWebviewShouldBeVisible = false;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const preview = await WebviewWindow.getByLabel(TAB_DRAG_PREVIEW_WEBVIEW_LABEL);
  await preview?.hide();
}

export async function listenForTabWindowDragPreview(handler: (payload: TabWindowDragPreviewPayload) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TabWindowDragPreviewPayload>(TAB_WINDOW_DRAG_PREVIEW_EVENT, (event) => handler(event.payload));
}

export async function listenForNativeTabDragPreviewRelease(handler: (payload: NativeTabDragPreviewRelease) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NativeTabDragPreviewRelease>(TAB_NATIVE_DRAG_PREVIEW_RELEASE_EVENT, (event) => handler(event.payload));
}

export async function currentTabWindowLabel(): Promise<string> {
  if (!isTauriRuntime()) return "web";
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label;
}

export async function createDetachedTabWindow(payload: TabWindowTransferPayload, placement?: TabWindowPlacement): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  storeDetachedTabTransfer(payload);

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const url = new URL(window.location.href);
  url.searchParams.set(DETACHED_TAB_QUERY, payload.transferId);
  const label = `dbx-tab-${payload.transferId}`;
  const child = new WebviewWindow(label, {
    url: url.toString(),
    title: "DBX",
    // Keep the real native window equal to the drag outline dimensions.
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    fullscreen: false,
    decorations: !navigator.userAgent.toLowerCase().includes("windows"),
    titleBarStyle: "overlay",
    hiddenTitle: true,
    ...(placement ? { x: placement.x, y: placement.y } : {}),
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (created: boolean) => {
      if (settled) return;
      settled = true;
      if (!created) clearTabWindowTransfer(payload.transferId);
      resolve(created);
    };
    void child.once("tauri://created", () => {
      console.info(`[WINDOW] child workspace window created: ${label}`);
      settle(true);
    });
    void child.once("tauri://error", () => {
      console.warn(`[WINDOW] child workspace window creation failed: ${label}`);
      settle(false);
    });
    window.setTimeout(() => settle(false), 5000);
  });
}
