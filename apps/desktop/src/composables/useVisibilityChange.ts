import { onMounted, onUnmounted } from "vue";
import { refreshConnections } from "@/lib/api";
import { useQueryStore } from "@/stores/queryStore";

let hiddenAt: number | null = null;

function handleVisibilityChange() {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else {
    const wasHidden = hiddenAt;
    hiddenAt = null;
    if (wasHidden && Date.now() - wasHidden > 30_000) {
      refreshConnections().catch(() => {});
      const queryStore = useQueryStore();
      const stuckTabs = queryStore.tabs.filter((t) => t.isExecuting);
      if (stuckTabs.length > 0) {
        queryStore.notifyConnectionMayBeLost();
      }
    }
  }
}

export function useVisibilityChange() {
  onMounted(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  });

  onUnmounted(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });
}
