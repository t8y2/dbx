import type { SavedOpenTab } from "@/lib/app/openTabsPersistence";
import { serializeOpenTabs } from "@/lib/app/openTabsPersistence";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { uuid } from "@/lib/common/utils";
import type { QueryTab } from "@/types/database";

export const TAB_WINDOW_TRANSFER_MIME = "application/x-dbx-tab";
const DETACHED_TAB_QUERY = "dbxTransfer";
const TRANSFER_STORAGE_PREFIX = "dbx-tab-window-transfer:";
const ACCEPTED_STORAGE_PREFIX = "dbx-tab-window-transfer-accepted:";

export interface TabWindowTransferPayload {
  transferId: string;
  sourceWindowLabel: string;
  tab: SavedOpenTab;
}

function transferStorageKey(transferId: string): string {
  return `${TRANSFER_STORAGE_PREFIX}${transferId}`;
}

function acceptedStorageKey(transferId: string): string {
  return `${ACCEPTED_STORAGE_PREFIX}${transferId}`;
}

export function isDetachedTabWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(DETACHED_TAB_QUERY);
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
  };
}

export function encodeTabWindowTransfer(payload: TabWindowTransferPayload): string {
  return JSON.stringify(payload);
}

export function decodeTabWindowTransfer(value: string | null | undefined): TabWindowTransferPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TabWindowTransferPayload>;
    if (!parsed.transferId || !parsed.sourceWindowLabel || !parsed.tab || typeof parsed.tab.id !== "string") return null;
    return parsed as TabWindowTransferPayload;
  } catch {
    return null;
  }
}

export function storeDetachedTabTransfer(payload: TabWindowTransferPayload): void {
  safeLocalStorageSet(transferStorageKey(payload.transferId), encodeTabWindowTransfer(payload));
}

export function consumeDetachedTabTransfer(): TabWindowTransferPayload | null {
  const token = detachedTabTransferToken();
  if (!token) return null;
  const payload = decodeTabWindowTransfer(safeLocalStorageGet(transferStorageKey(token)));
  safeLocalStorageRemove(transferStorageKey(token));
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

export async function currentTabWindowLabel(): Promise<string> {
  if (!isTauriRuntime()) return "web";
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label;
}

export async function createDetachedTabWindow(payload: TabWindowTransferPayload): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  storeDetachedTabTransfer(payload);

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const url = new URL(window.location.href);
  url.searchParams.set(DETACHED_TAB_QUERY, payload.transferId);
  const label = `dbx-tab-${payload.transferId}`;
  const child = new WebviewWindow(label, {
    url: url.toString(),
    title: "DBX",
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    fullscreen: false,
    decorations: !navigator.userAgent.toLowerCase().includes("windows"),
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (created: boolean) => {
      if (settled) return;
      settled = true;
      if (!created) safeLocalStorageRemove(transferStorageKey(payload.transferId));
      resolve(created);
    };
    void child.once("tauri://created", () => settle(true));
    void child.once("tauri://error", () => settle(false));
    window.setTimeout(() => settle(false), 5000);
  });
}
