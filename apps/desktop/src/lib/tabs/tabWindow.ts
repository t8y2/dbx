import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { DataGridPendingSnapshotTransfer } from "@/composables/useDataGridEditor";
import { DETACHED_TAB_WINDOW_HEIGHT, DETACHED_TAB_WINDOW_WIDTH, detachedTabWindowLogicalPosition, type TabWindowClientPlacement } from "@/lib/tabs/tabWindowPlacement";
import { restoreOpenTabsPayload, serializeOpenTabs, type SavedOpenTab } from "@/lib/app/openTabsPersistence";
import type { QueryTab } from "@/types/database";

const DETACHED_TRANSFER_PARAM = "dbxDetachedTransfer";
const TRANSFER_TIMEOUT_MS = 15_000;
const APP_CLOSE_CHECK_TIMEOUT_MS = 2_000;
const DETACHED_WINDOW_CLEANUP_TIMEOUT_MS = 3_000;
const APP_CLOSE_CHECK_EVENT = "dbx-detached-tab-app-close-check";
const APP_CLOSE_STATUS_EVENT = "dbx-detached-tab-app-close-status";
const MAIN_WINDOW_ACTION_EVENT = "dbx-detached-tab-main-window-action";
const PERSISTENCE_UPDATE_EVENT = "dbx-detached-tab-persistence-update";
const PERSISTENCE_ACK_TIMEOUT_MS = 5_000;
const DETACHED_RECOVERY_STORAGE_PREFIX = "dbx-detached-tab-recovery:";
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

interface TransferPrepared extends TransferSignal {
  ok: boolean;
  message?: string;
}

interface TransferDecision extends TransferSignal {
  decision: "commit" | "abort";
}

interface DetachedTabPersistenceUpdate {
  requestId: string;
  windowLabel: string;
  tab: SavedOpenTab | null;
}

interface DetachedTabPersistenceAcknowledgement {
  requestId: string;
  ok: boolean;
  message?: string;
}

interface DetachedTabRecoveryState extends Omit<DetachedTabTransferPayload, "tab"> {
  tab: SavedOpenTab;
}

interface DetachedAppCloseCheck {
  requestId: string;
  prompt?: boolean;
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
  windowLabel: string;
  transfer: (
    payload: Omit<DetachedTabTransferPayload, "transferId">,
    options?: {
      onPrepared?: () => Promise<void>;
    },
  ) => Promise<{ commitAcknowledged: boolean }>;
  abort: () => Promise<void>;
}

export interface PrepareTabWindowOptions {
  placement?: TabWindowClientPlacement;
  onWindowShown?: () => void;
}

export interface ReceiveDetachedTabOptions {
  initialization?: Promise<void>;
  onCommitted?: () => void | Promise<void>;
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

function transferEventName(kind: "visual-ready" | "transfer-ready" | "transfer" | "prepared" | "decision" | "committed", transferId: string): string {
  return `dbx-detached-tab-${kind}-${transferId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function persistenceAcknowledgementEventName(requestId: string): string {
  return `dbx-detached-tab-persistence-ack-${requestId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
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

function detachedRecoveryStorageKey(transferId: string): string {
  return `${DETACHED_RECOVERY_STORAGE_PREFIX}${transferId}`;
}

function saveDetachedRecoveryState(payload: DetachedTabTransferPayload): void {
  if (typeof sessionStorage === "undefined") return;
  const tab = serializeOpenTabs([payload.tab])[0];
  if (!tab) return;
  try {
    sessionStorage.setItem(
      detachedRecoveryStorageKey(payload.transferId),
      JSON.stringify({
        ...payload,
        tab,
      } satisfies DetachedTabRecoveryState),
    );
  } catch {
    // Recovery is best-effort and must never block ownership transfer.
  }
}

function updateDetachedRecoveryTab(transferId: string, tab: SavedOpenTab | null): void {
  if (typeof sessionStorage === "undefined") return;
  const key = detachedRecoveryStorageKey(transferId);
  try {
    if (!tab) {
      sessionStorage.removeItem(key);
      return;
    }
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const state = JSON.parse(raw) as DetachedTabRecoveryState;
    sessionStorage.setItem(key, JSON.stringify({ ...state, tab } satisfies DetachedTabRecoveryState));
  } catch {
    // Keep runtime persistence independent from optional reload recovery.
  }
}

function loadDetachedRecoveryState(transferId: string): DetachedTabTransferPayload | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(detachedRecoveryStorageKey(transferId));
    if (!raw) return null;
    const state = JSON.parse(raw) as DetachedTabRecoveryState;
    if (state.transferId !== transferId || !state.tab) return null;
    const restored = restoreOpenTabsPayload({
      tabs: [state.tab],
      activeTabId: state.tab.id,
    });
    const tab = restored.tabs[0];
    if (!tab) return null;
    return {
      ...state,
      tab,
    };
  } catch {
    return null;
  }
}

export function isDetachedTabWindow(): boolean {
  return isTauriRuntime() && !!detachedTransferId();
}

async function createEventWaiter<T>(target: WebviewWindow, eventName: string, timeoutMessage: string, timeoutMs = TRANSFER_TIMEOUT_MS): Promise<EventWaiter<T>> {
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
  timer = setTimeout(() => finish(undefined, new Error(timeoutMessage)), timeoutMs);
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

async function prepareTauriTabWindow(tabId: string, title: string, options: PrepareTabWindowOptions): Promise<PreparedTabWindow> {
  const { placement, onWindowShown } = options;
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
  const [visualReadyWaiter, transferReadyWaiter] = await Promise.all([
    createEventWaiter<TransferSignal>(mainWindow, transferEventName("visual-ready", transferId), "Detached tab window shell did not become ready"),
    createEventWaiter<TransferSignal>(mainWindow, transferEventName("transfer-ready", transferId), "Detached tab window did not become ready for transfer"),
  ]);
  // Destruction can cancel these waiters before their sequential awaits begin.
  void visualReadyWaiter.promise.catch(() => {});
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
    visualReadyWaiter.cancel();
    transferReadyWaiter.cancel();
  });

  try {
    // Swap the retained drag preview for a renderable shell instead of exposing the WebView's blank first frame.
    await Promise.all([waitForWindowCreation(detached), visualReadyWaiter.promise]);
    await detached.show();
    try {
      onWindowShown?.();
    } catch {
      // Preview cleanup is best-effort and must not invalidate a successfully shown window.
    }
    // Keep ownership in the main window until the child can receive the transfer.
    await transferReadyWaiter.promise;
  } catch (error) {
    visualReadyWaiter.cancel();
    transferReadyWaiter.cancel();
    await detached.destroy().catch(() => {});
    throw error;
  }

  let completed = false;
  return {
    windowLabel: label,
    async transfer(payload: Omit<DetachedTabTransferPayload, "transferId">, transferOptions = {}) {
      if (completed) throw new Error("Detached tab transfer already completed");
      const [preparedWaiter, committedWaiter] = await Promise.all([
        createEventWaiter<TransferPrepared>(mainWindow, transferEventName("prepared", transferId), "Detached tab window did not prepare the tab"),
        createEventWaiter<TransferSignal>(mainWindow, transferEventName("committed", transferId), "Detached tab window did not confirm the ownership commit"),
      ]);
      // Either waiter may be cancelled before its sequential await begins.
      void preparedWaiter.promise.catch(() => {});
      void committedWaiter.promise.catch(() => {});
      try {
        await emitTo(label, transferEventName("transfer", transferId), { transferId, ...payload } satisfies DetachedTabTransferPayload);
        const prepared = await preparedWaiter.promise;
        if (!prepared.ok) throw new Error(prepared.message || "Detached tab window rejected the tab");
        // Persist the target owner before publishing the irreversible commit.
        // Failures before this point can still restore the source tab safely.
        await transferOptions.onPrepared?.();
      } catch (error) {
        preparedWaiter.cancel();
        committedWaiter.cancel();
        await emitTo(label, transferEventName("decision", transferId), {
          transferId,
          decision: "abort",
        } satisfies TransferDecision).catch(() => {});
        throw error;
      }

      // The source window is authoritative once its durable ownership update
      // succeeds. A missing final acknowledgement must never restore a second
      // live owner; the persisted tab is recovered on the next startup.
      completed = true;
      let commitAcknowledged = false;
      try {
        await emitTo(label, transferEventName("decision", transferId), {
          transferId,
          decision: "commit",
        } satisfies TransferDecision);
        await committedWaiter.promise;
        commitAcknowledged = true;
      } catch (error) {
        console.warn("[DBX][detached-tab:commit-ack:error]", { transferId, windowLabel: label, error });
      } finally {
        committedWaiter.cancel();
      }
      await detached.setFocus().catch(() => {});
      return { commitAcknowledged };
    },
    async abort() {
      if (completed) return;
      await emitTo(label, transferEventName("decision", transferId), {
        transferId,
        decision: "abort",
      } satisfies TransferDecision).catch(() => {});
      // destroy() bypasses CloseRequested so a provisional child cannot release
      // sessions that the restored source tab still owns.
      await detached.destroy().catch(() => {});
    },
  };
}

/**
 * Waits until the detached window can receive the transfer before ownership
 * leaves the main window, so startup failures cannot lose the original tab.
 */
export async function prepareTabWindow(tabId: string, title: string, options: PrepareTabWindowOptions = {}): Promise<PreparedTabWindow> {
  if (!isTauriRuntime()) throw new Error("Detached tabs are only supported in the desktop app");
  const pending = openingWindows.get(tabId);
  if (pending) return pending;

  const task = prepareTauriTabWindow(tabId, title, options);
  openingWindows.set(tabId, task);
  try {
    return await task;
  } finally {
    openingWindows.delete(tabId);
  }
}

export async function notifyDetachedWindowVisualReady(): Promise<void> {
  const transferId = detachedTransferId();
  if (!transferId || !isTauriRuntime()) throw new Error("Detached tab transfer context is missing");
  await emitTo("main", transferEventName("visual-ready", transferId), { transferId } satisfies TransferSignal);
}

/**
 * The detached window first adopts a provisional, non-interactive tab. The
 * source remains authoritative until it durably records the detached owner and
 * sends an explicit commit decision.
 */
export async function receiveDetachedTab(onReceive: (payload: DetachedTabTransferPayload) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>, options: ReceiveDetachedTabOptions = {}): Promise<UnlistenFn> {
  const transferId = detachedTransferId();
  if (!transferId || !isTauriRuntime()) throw new Error("Detached tab transfer context is missing");

  const currentWindow = getCurrentWebviewWindow();
  let accepting = false;
  let unlistenDecision: UnlistenFn | undefined;
  const unlisten = await currentWindow.listen<DetachedTabTransferPayload>(transferEventName("transfer", transferId), async (event) => {
    if (accepting || event.payload.transferId !== transferId) return;
    accepting = true;
    let rollbackReceive: (() => void | Promise<void>) | undefined;
    let decisionSettled = false;
    const rollbackAndDestroy = async () => {
      if (decisionSettled) return;
      decisionSettled = true;
      unlistenDecision?.();
      await rollbackReceive?.();
      await currentWindow.destroy().catch(() => {});
    };
    try {
      // The listener becomes transfer-ready before core initialization settles.
      // This lets the main window move ownership while adoption still waits for
      // the settings and connection metadata required by the tab runtime.
      await options.initialization;
      rollbackReceive = await onReceive(event.payload);
      unlistenDecision = await currentWindow.listen<TransferDecision>(transferEventName("decision", transferId), async (decisionEvent) => {
        if (decisionSettled || decisionEvent.payload.transferId !== transferId) return;
        if (decisionEvent.payload.decision === "abort") {
          await rollbackAndDestroy();
          return;
        }
        decisionSettled = true;
        unlistenDecision?.();
        // sessionStorage survives a WebView reload during development, allowing
        // the committed child to recover without asking the source to transfer again.
        saveDetachedRecoveryState(event.payload);
        await options.onCommitted?.();
        await emitTo("main", transferEventName("committed", transferId), { transferId } satisfies TransferSignal).catch(() => {});
      });
    } catch (error) {
      await emitTo("main", transferEventName("prepared", transferId), {
        transferId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies TransferPrepared).catch(() => {});
      accepting = false;
      return;
    }

    try {
      await emitTo("main", transferEventName("prepared", transferId), { transferId, ok: true } satisfies TransferPrepared);
    } catch {
      // The source cannot commit an adoption it never observed.
      await rollbackAndDestroy();
    }
  });

  try {
    const recovery = loadDetachedRecoveryState(transferId);
    if (recovery) {
      accepting = true;
      await options.initialization;
      await onReceive(recovery);
      await options.onCommitted?.();
      return () => {
        unlisten();
        unlistenDecision?.();
      };
    }
    await emitTo("main", transferEventName("transfer-ready", transferId), { transferId } satisfies TransferSignal);
    return () => {
      unlisten();
      unlistenDecision?.();
    };
  } catch (error) {
    unlisten();
    unlistenDecision?.();
    throw error;
  }
}

export async function reportDetachedTabPersistence(tab: SavedOpenTab | null): Promise<void> {
  const transferId = detachedTransferId();
  if (!isTauriRuntime() || !transferId) throw new Error("Detached tab transfer context is missing");
  const currentWindow = getCurrentWebviewWindow();
  const requestId = crypto.randomUUID();
  const acknowledgementWaiter = await createEventWaiter<DetachedTabPersistenceAcknowledgement>(currentWindow, persistenceAcknowledgementEventName(requestId), "Main window did not persist detached tab state", PERSISTENCE_ACK_TIMEOUT_MS);
  // emitTo() can fail before the acknowledgement promise is awaited.
  void acknowledgementWaiter.promise.catch(() => {});
  try {
    await emitTo("main", PERSISTENCE_UPDATE_EVENT, {
      requestId,
      windowLabel: currentWindow.label,
      tab,
    } satisfies DetachedTabPersistenceUpdate);
    const acknowledgement = await acknowledgementWaiter.promise;
    if (!acknowledgement.ok) throw new Error(acknowledgement.message || "Main window rejected detached tab persistence");
    updateDetachedRecoveryTab(transferId, tab);
  } catch (error) {
    acknowledgementWaiter.cancel();
    throw error;
  }
}

export async function listenForDetachedTabPersistenceUpdates(onUpdate: (windowLabel: string, tab: SavedOpenTab | null) => void | Promise<void>): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return getCurrentWebviewWindow().listen<DetachedTabPersistenceUpdate>(PERSISTENCE_UPDATE_EVENT, async (event) => {
    const update = event.payload;
    let acknowledgement: DetachedTabPersistenceAcknowledgement;
    try {
      await onUpdate(update.windowLabel, update.tab);
      acknowledgement = { requestId: update.requestId, ok: true };
    } catch (error) {
      acknowledgement = {
        requestId: update.requestId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await emitTo(update.windowLabel, persistenceAcknowledgementEventName(update.requestId), acknowledgement).catch(() => {});
  });
}

export async function listenForDetachedAppCloseChecks(hasDirtyTabs: () => boolean | Promise<boolean>, onDirtyPrompt?: () => void | Promise<void>): Promise<UnlistenFn> {
  if (!isDetachedTabWindow()) throw new Error("Detached tab transfer context is missing");
  const currentWindow = getCurrentWebviewWindow();
  return currentWindow.listen<DetachedAppCloseCheck>(APP_CLOSE_CHECK_EVENT, async (event) => {
    let dirty = true;
    try {
      dirty = await hasDirtyTabs();
    } catch (error) {
      // A failed persistence flush must block app exit rather than being
      // misclassified as an unresponsive child or silently losing tab state.
      console.warn("[DBX][detached-tab:app-close-check:error]", error);
    }
    if (dirty && event.payload.prompt) await onDirtyPrompt?.();
    await emitTo("main", APP_CLOSE_STATUS_EVENT, {
      requestId: event.payload.requestId,
      windowLabel: currentWindow.label,
      dirty,
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

export async function promptDetachedWindowBeforeAppClose(windowLabel: string): Promise<void> {
  await emitTo(windowLabel, APP_CLOSE_CHECK_EVENT, {
    requestId: crypto.randomUUID(),
    prompt: true,
  } satisfies DetachedAppCloseCheck);
}

export async function focusDetachedTabWindow(windowLabel: string): Promise<void> {
  const detachedWindow = await WebviewWindow.getByLabel(windowLabel);
  if (!detachedWindow) return;
  await detachedWindow.show().catch(() => {});
  await detachedWindow.setFocus().catch(() => {});
}
