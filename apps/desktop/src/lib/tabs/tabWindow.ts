import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { DataGridPendingSnapshotTransfer } from "@/composables/useDataGridEditor";
import type { QueryTab } from "@/types/database";

const DETACHED_TRANSFER_PARAM = "dbxDetachedTransfer";
const TRANSFER_TIMEOUT_MS = 15_000;
const openingWindows = new Map<string, Promise<PreparedTabWindow>>();

interface TransferSignal {
  transferId: string;
}

export interface DetachedTabTransferPayload extends TransferSignal {
  tab: QueryTab;
  activeOutputView: "result" | "summary" | "explain" | "chart";
  selectedSql: string;
  cursorPos: number;
  dataGridSnapshots: DataGridPendingSnapshotTransfer[];
}

interface TransferAcknowledgement extends TransferSignal {
  ok: boolean;
  message?: string;
}

interface EventWaiter<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export interface PreparedTabWindow {
  transfer: (payload: Omit<DetachedTabTransferPayload, "transferId">) => Promise<void>;
  abort: () => Promise<void>;
}

function windowLabel(tabId: string): string {
  return `detached-tab-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function transferEventName(kind: "ready" | "transfer" | "accepted", transferId: string): string {
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

async function prepareTauriTabWindow(tabId: string, title: string): Promise<PreparedTabWindow> {
  const label = windowLabel(tabId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    throw new Error("This tab already has a detached window");
  }

  const transferId = crypto.randomUUID();
  const mainWindow = getCurrentWebviewWindow();
  const readyWaiter = await createEventWaiter<TransferSignal>(mainWindow, transferEventName("ready", transferId), "Detached tab window did not become ready");
  const detached = new WebviewWindow(label, {
    url: detachedUrl(transferId),
    title,
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    resizable: true,
    decorations: false,
    hiddenTitle: true,
    focus: false,
    visible: false,
  });

  try {
    await Promise.all([waitForWindowCreation(detached), readyWaiter.promise]);
    await detached.show();
  } catch (error) {
    readyWaiter.cancel();
    await detached.close().catch(() => {});
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
 * 先等待隐藏子窗口准备完成，再交由调用方迁移标签页所有权，避免窗口创建失败时丢失主窗口标签页。
 */
export async function prepareTabWindow(tabId: string, title: string): Promise<PreparedTabWindow> {
  if (!isTauriRuntime()) throw new Error("Detached tabs are only supported in the desktop app");
  const pending = openingWindows.get(tabId);
  if (pending) return pending;

  const task = prepareTauriTabWindow(tabId, title);
  openingWindows.set(tabId, task);
  try {
    return await task;
  } finally {
    openingWindows.delete(tabId);
  }
}

/**
 * 子窗口只在完成应用基础初始化后发出 ready；接收成功的确认是主窗口移除原标签页的提交点。
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
    await emitTo("main", transferEventName("ready", transferId), { transferId } satisfies TransferSignal);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}
