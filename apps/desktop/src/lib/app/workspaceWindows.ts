import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { OpenTabsStatePayload } from "@/lib/app/openTabsPersistence";
import { notifyTabWindowsChanged } from "@/lib/tabs/tabWindowTransfer";

const PREFIX = `workspace-window:${import.meta.env.DEV ? "development:" : ""}`;

export interface WorkspaceWindowSnapshot {
  kind: "workspace-window";
  key: string;
  windowLabel: string;
  payload: OpenTabsStatePayload;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  maximized?: boolean;
}

export async function listWorkspaceWindows(): Promise<WorkspaceWindowSnapshot[]> {
  if (!isTauriRuntime()) return [];
  const records = await invoke<unknown[]>("list_detached_tab_handoffs");
  return records.filter((record): record is WorkspaceWindowSnapshot => {
    if (!record || typeof record !== "object") return false;
    const value = record as Partial<WorkspaceWindowSnapshot>;
    return value.kind === "workspace-window" && value.key === `${PREFIX}${value.windowLabel}` && Array.isArray(value.payload?.tabs);
  });
}

export async function loadWorkspaceWindow(): Promise<OpenTabsStatePayload | null> {
  const label = getCurrentWindow().label;
  const record = await invoke<WorkspaceWindowSnapshot | null>("load_detached_tab_handoff", { tabId: `${PREFIX}${label}` });
  return record?.kind === "workspace-window" ? record.payload : null;
}

export async function saveWorkspaceWindow(payload: OpenTabsStatePayload): Promise<void> {
  const window = getCurrentWindow();
  const snapshot: WorkspaceWindowSnapshot = { kind: "workspace-window", key: `${PREFIX}${window.label}`, windowLabel: window.label, payload };
  try {
    const [position, size, scale, maximized] = await Promise.all([window.outerPosition(), window.innerSize(), window.scaleFactor(), window.isMaximized()]);
    snapshot.position = { x: position.x / scale, y: position.y / scale };
    snapshot.size = { width: size.width / scale, height: size.height / scale };
    snapshot.maximized = maximized;
  } catch {
    // Editor contents remain durable even if a window manager cannot report geometry.
  }
  // Reuse the backend's locked SQLite handoff map; workspace records have their
  // own discriminator and cannot be mistaken for legacy single-tab handoffs.
  await invoke("save_detached_tab_handoff", { tabId: snapshot.key, handoff: snapshot });
}

export async function restoreWorkspaceWindows(): Promise<void> {
  if (!isTauriRuntime() || getCurrentWindow().label !== "main") return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  for (const snapshot of await listWorkspaceWindows()) {
    if (!snapshot.windowLabel.startsWith("dbx-tab-") || snapshot.windowLabel.startsWith("dbx-tab-drag-preview") || !snapshot.payload.tabs.length) continue;
    if (await WebviewWindow.getByLabel(snapshot.windowLabel)) continue;
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ dbxWorkspaceWindow: snapshot.windowLabel }).toString();
    url.hash = "";
    const child = new WebviewWindow(snapshot.windowLabel, {
      url: url.toString(),
      title: "DBX",
      width: snapshot.size?.width ?? 1200,
      height: snapshot.size?.height ?? 800,
      minWidth: 760,
      minHeight: 600,
      decorations: !navigator.userAgent.toLowerCase().includes("windows"),
      titleBarStyle: "overlay",
      hiddenTitle: true,
      ...snapshot.position,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Window restore timed out: ${snapshot.windowLabel}`)), 10_000);
      void child.once("tauri://created", () => {
        clearTimeout(timeout);
        void notifyTabWindowsChanged(snapshot.windowLabel).catch(() => {});
        if (snapshot.maximized) void child.maximize().catch(() => {});
        resolve();
      });
      void child.once("tauri://error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Window restore failed: ${snapshot.windowLabel}: ${String(error.payload)}`));
      });
    });
  }
}
