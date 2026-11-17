import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const CONNECTION_STATE_CHANGED_EVENT = "dbx:connection-state-changed";

export interface SharedConnectionStateChange {
  connectionId: string;
  closedByUser?: boolean;
}

export async function notifyConnectionStateChanged(change: SharedConnectionStateChange): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const [{ emit }, { getCurrentWindow }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/window")]);
    await emit(CONNECTION_STATE_CHANGED_EVENT, { ...change, sourceWindow: getCurrentWindow().label });
  } catch (error) {
    console.warn("[DBX][connection:state-notify]", error);
  }
}

export async function subscribeConnectionStateChanges(refresh: (change: SharedConnectionStateChange) => Promise<void>): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const [{ listen }, { getCurrentWindow }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/window")]);
  const label = getCurrentWindow().label;
  return listen<SharedConnectionStateChange & { sourceWindow: string }>(CONNECTION_STATE_CHANGED_EVENT, ({ payload }) => {
    if (!payload?.connectionId || payload.sourceWindow === label) return;
    void refresh(payload).catch((error) => console.warn("[DBX][connection:state-sync]", error));
  });
}
