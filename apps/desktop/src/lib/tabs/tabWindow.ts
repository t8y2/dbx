import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { DataGridPendingSnapshotTransfer } from "@/composables/useDataGridEditor";
import { DETACHED_TAB_WINDOW_HEIGHT, DETACHED_TAB_WINDOW_WIDTH, detachedTabWindowLogicalPosition, type TabWindowClientPlacement } from "@/lib/tabs/tabWindowPlacement";
import type { QueryTab } from "@/types/database";

const DETACHED_TRANSFER_PARAM = "dbxDetachedTransfer";
const TRANSFER_TIMEOUT_MS = 15_000;
const APP_CLOSE_CHECK_TIMEOUT_MS = 2_000;
const DETACHED_WINDOW_CLEANUP_TIMEOUT_MS = 3_000;
const APP_CLOSE_CHECK_EVENT = "dbx-detached-tab-app-close-check";
const APP_CLOSE_STATUS_EVENT = "dbx-detached-tab-app-close-status";
const MAIN_WINDOW_ACTION_EVENT = "dbx-detached-tab-main-window-action";
const openingWindows = new Map<string, Promise<PreparedTabWindow>>();

interface TransferSignal {
  transferId: string;
}

export interface DetachedTabTransferPayload extends TransferSignal {
  tab: QueryTab;
  activeOutputView: "result" | "summary" | "explain" | "chart";
  selectedSql: string;
  cursorPos: number;
  explainMode: "explain" | "autotrace";
  blockDangerousRedisCommands: boolean;
  dataGridSnapshots: DataGridPendingSnapshotTransfer[];
}

interface TransferAcknowledgement extends TransferSignal {
  ok: boolean;
  message?: string;
}

interface DetachedAppCloseCheck {
  requestId: string;
}

interface DetachedAppCloseStatus extends DetachedAppCloseCheck {
  windowLabel: string;
  dirty: boolean;
}

export interface DetachedAppCloseCheckResult {
  dirtyWindowLabels: string[];
  unresponsiveWindowLabels: string[];
}

export type DetachedTabMainWindowAction = { type: "fix-with-ai"; errorMessage: string } | { type: "new-query" } | { type: "open-settings"; initialTab?: string; initialSection?: string } | { type: "send-selection-to-ai"; sql: string };

interface EventWaiter<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export interface PreparedTabWindow {
  transfer: (payload: Omit<DetachedTabTransferPayload, "transferId">) => Promise<void>;
  abort: () => Promise<void>;
}

export type DetachedWindowCleanupOutcome = { status: "completed" } | { status: "failed"; error: unknown } | { status: "timed-out"; timeoutMs: number };

export async function destroyDetachedWindowAfterCleanup(target: Pick<WebviewWindow, "destroy">, cleanup: () => Promise<void>, timeoutMs = DETACHED_WINDOW_CLEANUP_TIMEOUT_MS): Promise<DetachedWindowCleanupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanupOutcome: Promise<DetachedWindowCleanupOutcome> = Promise.resolve()
    .then(cleanup)
    .then(() => ({ status: "completed" }) as const)
    .catch((error: unknown) => ({ status: "failed", error }));
  const timeoutOutcome = new Promise<DetachedWindowCleanupOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out", timeoutMs }), Math.max(0, timeoutMs));
  });

  try {
    return await Promise.race([cleanupOutcome, timeoutOutcome]);
  } finally {
    if (timer) clearTimeout(timer);
    // close() emits CloseRequested again; destroy() guarantees that a hidden WebView is released.
    await target.destroy();
  }
}

function windowLabel(tabId: string): string {
  return `detached-tab-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function transferEventName(kind: "shell-ready" | "transfer-ready" | "transfer" | "accepted", transferId: string): string {
  return `dbx-detached-tab-${kind}-${transferId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function detachedUrl(transferId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(DETACHED_TRANSFER_PARAM);
  url.searchParams.set(DETACHED_TRANSFER_PARAM, transferId);
  return url.toString();
}

function detachedTransferId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(DETACHED_TRANSFER_PARAM);
}

export function isDetachedTabWindow(): boolean {
  return isTauriRuntime() && !!detachedTransferId();
}

async function createEventWaiter<T>(target: WebviewWindow, eventName: string, timeoutMessage: string): Promise<EventWaiter<T>> {
  let settled = false;
  let unlisten: UnlistenFn = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise: (payload: T) => void = () => {};
  let rejectPromise: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finish = (payload?: T, error?: Error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unlisten();
    if (error) rejectPromise(error);
    else resolvePromise(payload as T);
  };

  unlisten = await target.listen<T>(eventName, (event) => finish(event.payload));
  timer = setTimeout(() => finish(undefined, new Error(timeoutMessage)), TRANSFER_TIMEOUT_MS);
  return {
    promise,
    cancel: () => finish(undefined, new Error("Detached tab transfer cancelled")),
  };
}

async function waitForWindowCreation(window: WebviewWindow): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    void window.once("tauri://created", () => resolve());
    void window.once("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}

async function prepareTauriTabWindow(tabId: string, title: string, placement?: TabWindowClientPlacement): Promise<PreparedTabWindow> {
  const label = windowLabel(tabId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    throw new Error("This tab already has a detached window");
  }

  const transferId = crypto.randomUUID();
  const mainWindow = getCurrentWebviewWindow();
  let initialPosition: { x: number; y: number } | undefined;
  if (placement) {
    try {
      const [sourceInnerPosition, sourceScaleFactor] = await Promise.all([mainWindow.innerPosition(), mainWindow.scaleFactor()]);
      initialPosition = detachedTabWindowLogicalPosition(sourceInnerPosition, sourceScaleFactor, window.devicePixelRatio, placement);
    } catch {
      // Fall back to the window manager position when source coordinates are unavailable.
    }
  }
  const shellReadyWaiter = await createEventWaiter<TransferSignal>(mainWindow, transferEventName("shell-ready", transferId), "Detached tab window shell did not become ready");
  const transferReadyWaiter = await createEventWaiter<TransferSignal>(mainWindow, transferEventName("transfer-ready", transferId), "Detached tab window did not become ready for transfer");
  // Destruction can cancel this waiter before the sequential transfer-ready await begins.
  void transferReadyWaiter.promise.catch(() => {});
  const detached = new WebviewWindow(label, {
    url: detachedUrl(transferId),
    title,
    width: DETACHED_TAB_WINDOW_WIDTH,
    height: DETACHED_TAB_WINDOW_HEIGHT,
    ...initialPosition,
    minWidth: 760,
    minHeight: 520,
    preventOverflow: true,
    resizable: true,
    decorations: false,
    hiddenTitle: true,
    focus: false,
    visible: false,
  });
  void detached.once("tauri://destroyed", () => {
    shellReadyWaiter.cancel();
    transferReadyWaiter.cancel();
  });

  try {
    // Show the lightweight shell before the full application and tab workspace finish loading.
    await Promise.all([waitForWindowCreation(detached), shellReadyWaiter.promise]);
    await detached.show();
    await transferReadyWaiter.promise;
  } catch (error) {
    shellReadyWaiter.cancel();
    transferReadyWaiter.cancel();
    await detached.destroy().catch(() => {});
    throw error;
  }

  let completed = false;
  return {
    async transfer(payload: Omit<DetachedTabTransferPayload, "transferId">) {
      if (completed) throw new Error("Detached tab transfer already completed");
      const acceptedWaiter = await createEventWaiter<TransferAcknowledgement>(mainWindow, transferEventName("accepted", transferId), "Detached tab window did not accept the tab");
      try {
        await emitTo(label, transferEventName("transfer", transferId), { transferId, ...payload } satisfies DetachedTabTransferPayload);
        const acknowledgement = await acceptedWaiter.promise;
        if (!acknowledgement.ok) throw new Error(acknowledgement.message || "Detached tab window rejected the tab");
        completed = true;
        await detached.setFocus().catch(() => {});
      } catch (error) {
        acceptedWaiter.cancel();
        throw error;
      }
    },
    async abort() {
      if (!completed) await detached.close().catch(() => {});
    },
  };
}

/**
 * Waits until the detached window can receive the transfer before ownership
 * leaves the main window, so startup failures cannot lose the original tab.
 */
export async function prepareTabWindow(tabId: string, title: string, placement?: TabWindowClientPlacement): Promise<PreparedTabWindow> {
  if (!isTauriRuntime()) throw new Error("Detached tabs are only supported in the desktop app");
  const pending = openingWindows.get(tabId);
  if (pending) return pending;

  const task = prepareTauriTabWindow(tabId, title, placement);
  openingWindows.set(tabId, task);
  try {
    return await task;
  } finally {
    openingWindows.delete(tabId);
  }
}

export async function notifyDetachedWindowShellReady(): Promise<void> {
  const transferId = detachedTransferId();
  if (!transferId || !isTauriRuntime()) throw new Error("Detached tab transfer context is missing");
  await emitTo("main", transferEventName("shell-ready", transferId), { transferId } satisfies TransferSignal);
}

/**
 * The detached window becomes transfer-ready only after its listener and core
 * state exist. Acceptance remains the commit point for removing the main tab.
 */
export async function receiveDetachedTab(onReceive: (payload: DetachedTabTransferPayload) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>): Promise<UnlistenFn> {
  const transferId = detachedTransferId();
  if (!transferId || !isTauriRuntime()) throw new Error("Detached tab transfer context is missing");

  const currentWindow = getCurrentWebviewWindow();
  let accepting = false;
  const unlisten = await currentWindow.listen<DetachedTabTransferPayload>(transferEventName("transfer", transferId), async (event) => {
    if (accepting || event.payload.transferId !== transferId) return;
    accepting = true;
    let rollbackReceive: (() => void | Promise<void>) | undefined;
    try {
      rollbackReceive = await onReceive(event.payload);
    } catch (error) {
      await emitTo("main", transferEventName("accepted", transferId), {
        transferId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies TransferAcknowledgement).catch(() => {});
      accepting = false;
      return;
    }

    try {
      await emitTo("main", transferEventName("accepted", transferId), { transferId, ok: true } satisfies TransferAcknowledgement);
    } catch {
      // The main window restores ownership when no acknowledgement arrives.
      // Roll back the child adoption before closing to avoid two live owners.
      await rollbackReceive();
      await currentWindow.close().catch(() => {});
    }
  });

  try {
    await emitTo("main", transferEventName("transfer-ready", transferId), { transferId } satisfies TransferSignal);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}

export async function listenForDetachedAppCloseChecks(hasDirtyTabs: () => boolean): Promise<UnlistenFn> {
  if (!isDetachedTabWindow()) throw new Error("Detached tab transfer context is missing");
  const currentWindow = getCurrentWebviewWindow();
  return currentWindow.listen<DetachedAppCloseCheck>(APP_CLOSE_CHECK_EVENT, async (event) => {
    await emitTo("main", APP_CLOSE_STATUS_EVENT, {
      requestId: event.payload.requestId,
      windowLabel: currentWindow.label,
      dirty: hasDirtyTabs(),
    } satisfies DetachedAppCloseStatus).catch(() => {});
  });
}

export async function requestDetachedTabMainWindowAction(action: DetachedTabMainWindowAction): Promise<void> {
  if (!isDetachedTabWindow()) throw new Error("Detached tab transfer context is missing");
  const mainWindow = await WebviewWindow.getByLabel("main");
  if (!mainWindow) throw new Error("Main window is unavailable");
  await mainWindow.show().catch(() => {});
  await mainWindow.setFocus().catch(() => {});
  await emitTo("main", MAIN_WINDOW_ACTION_EVENT, action);
}

export async function listenForDetachedTabMainWindowActions(onAction: (action: DetachedTabMainWindowAction) => void | Promise<void>): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return getCurrentWebviewWindow().listen<DetachedTabMainWindowAction>(MAIN_WINDOW_ACTION_EVENT, (event) => onAction(event.payload));
}

export async function checkDetachedWindowsBeforeAppClose(): Promise<DetachedAppCloseCheckResult> {
  if (!isTauriRuntime()) return { dirtyWindowLabels: [], unresponsiveWindowLabels: [] };
  const detachedWindows = (await getAllWebviewWindows()).filter((window) => window.label.startsWith("detached-tab-"));
  if (detachedWindows.length === 0) return { dirtyWindowLabels: [], unresponsiveWindowLabels: [] };

  const requestId = crypto.randomUUID();
  const pendingLabels = new Set(detachedWindows.map((window) => window.label));
  const dirtyWindowLabels = new Set<string>();
  const unresponsiveWindowLabels = new Set<string>();
  const mainWindow = getCurrentWebviewWindow();
  let settleStatuses: () => void = () => {};
  const statusesSettled = new Promise<void>((resolve) => {
    settleStatuses = resolve;
  });
  const timer = setTimeout(settleStatuses, APP_CLOSE_CHECK_TIMEOUT_MS);
  const unlisten = await mainWindow.listen<DetachedAppCloseStatus>(APP_CLOSE_STATUS_EVENT, (event) => {
    if (event.payload.requestId !== requestId || !pendingLabels.has(event.payload.windowLabel)) return;
    pendingLabels.delete(event.payload.windowLabel);
    if (event.payload.dirty) dirtyWindowLabels.add(event.payload.windowLabel);
    if (pendingLabels.size === 0) settleStatuses();
  });

  await Promise.all(
    detachedWindows.map(async (window) => {
      try {
        await emitTo(window.label, APP_CLOSE_CHECK_EVENT, { requestId } satisfies DetachedAppCloseCheck);
      } catch {
        unresponsiveWindowLabels.add(window.label);
        pendingLabels.delete(window.label);
      }
    }),
  );
  if (pendingLabels.size > 0) await statusesSettled;
  clearTimeout(timer);
  unlisten();
  pendingLabels.forEach((label) => unresponsiveWindowLabels.add(label));

  return {
    dirtyWindowLabels: [...dirtyWindowLabels],
    unresponsiveWindowLabels: [...unresponsiveWindowLabels],
  };
}

export async function focusDetachedTabWindow(windowLabel: string): Promise<void> {
  const detachedWindow = await WebviewWindow.getByLabel(windowLabel);
  if (!detachedWindow) return;
  await detachedWindow.show().catch(() => {});
  await detachedWindow.setFocus().catch(() => {});
}
