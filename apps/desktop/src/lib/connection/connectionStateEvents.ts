import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ConnectionConfig, PluginEvent } from "@/types/database";

/** Invalidation only: recipients confirm state with the read-only backend API. */
export const CONNECTION_STATE_CHANGED_EVENT = "dbx:connection-state-changed";

export interface ConnectionStateChangedEvent {
  sourceWindowLabel: string;
  configurationChanged: boolean;
}

/** Shared by main and detached windows; plugin events can outlive their session. */
export async function subscribePluginConnectionStateChanges(getConnection: (id: string) => ConnectionConfig | undefined, refreshConnections: () => Promise<void>): Promise<UnlistenFn> {
  return listen<unknown>("dbx-plugin-event", async ({ payload }) => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as Partial<PluginEvent>;
    if (event.method !== "ssh/session/state" || typeof event.pluginId !== "string" || !event.params || typeof event.params !== "object") return;
    const params = event.params as { connectionId?: unknown; state?: unknown };
    if (typeof params.connectionId !== "string" || !params.connectionId.trim() || (params.state !== "connected" && params.state !== "disconnected")) return;
    const connection = getConnection(params.connectionId);
    if (!connection || connection.db_type !== "plugin" || connection.plugin_id !== event.pluginId) return;
    try {
      // Confirm the current backend state instead of letting a delayed event
      // mark a successfully reconnected session offline. This never connects.
      await refreshConnections();
    } catch (error) {
      console.warn("[DBX] plugin connection state refresh failed:", error);
    }
  });
}
