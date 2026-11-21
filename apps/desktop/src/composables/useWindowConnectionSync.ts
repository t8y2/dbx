import { onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { subscribeConnectionStateChanges } from "@/lib/connection/connectionStateEvents";
import { useConnectionStore } from "@/stores/connectionStore";

export function useWindowConnectionSync() {
  const connections = useConnectionStore();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let stopWatching: WatchStopHandle | undefined;
  onMounted(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cleanup = await subscribeConnectionStateChanges(({ connectionId, closedByUser }) => connections.syncSharedConnectionState(connectionId, closedByUser));
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
      let knownIds = new Set<string>();
      stopWatching = watch(
        () => connections.connections.map((connection) => connection.id),
        (ids) => {
          for (const id of ids) {
            if (!knownIds.has(id)) void connections.syncSharedConnectionState(id);
          }
          knownIds = new Set(ids);
        },
        { immediate: true },
      );
    } catch (error) {
      console.warn("[DBX][connection:state-subscribe]", error);
    }
  });
  onUnmounted(() => {
    disposed = true;
    unlisten?.();
    stopWatching?.();
  });
}
