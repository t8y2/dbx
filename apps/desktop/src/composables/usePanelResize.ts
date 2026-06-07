import { ref, type Ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/safeStorage";

export function usePanelResize() {
  const sidebarWidth = ref(Number(safeLocalStorageGet("dbx-sidebar-width")) || 260);
  const aiPanelWidth = ref(Number(safeLocalStorageGet("dbx-ai-panel-width")) || 360);
  const historyWidth = ref(Number(safeLocalStorageGet("dbx-history-width")) || 288);

  function startPanelResize(widthRef: Ref<number>, storageKey: string, direction: "left" | "right") {
    return (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.value;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        widthRef.value = Math.max(180, Math.min(800, startWidth + (direction === "right" ? delta : -delta)));
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        safeLocalStorageSet(storageKey, String(widthRef.value));
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };
  }

  const startSidebarResize = startPanelResize(sidebarWidth, "dbx-sidebar-width", "right");
  const startAiPanelResize = startPanelResize(aiPanelWidth, "dbx-ai-panel-width", "left");
  const startHistoryResize = startPanelResize(historyWidth, "dbx-history-width", "left");

  return {
    sidebarWidth,
    aiPanelWidth,
    historyWidth,
    startSidebarResize,
    startAiPanelResize,
    startHistoryResize,
  };
}
