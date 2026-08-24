import { ref, type Ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const PANEL_MIN_WIDTH = 180;
const DEFAULT_PANEL_MAX_WIDTH = 800;
type PanelMaxWidth = number | ((handle: HTMLElement | null) => number);

function availableAiPanelMaxWidth(handle: HTMLElement | null) {
  const panel = handle?.parentElement;
  const flexibleContent = panel?.previousElementSibling as HTMLElement | null;
  if (!panel || !flexibleContent) return DEFAULT_PANEL_MAX_WIDTH;

  const panelRect = panel.getBoundingClientRect();
  const contentRect = flexibleContent.getBoundingClientRect();
  return Math.max(PANEL_MIN_WIDTH, panelRect.width + panelRect.left - contentRect.left);
}

export function usePanelResize() {
  const sidebarWidth = ref(Number(safeLocalStorageGet("dbx-sidebar-width")) || 260);
  const aiPanelWidth = ref(Number(safeLocalStorageGet("dbx-ai-panel-width")) || 360);
  const historyWidth = ref(Number(safeLocalStorageGet("dbx-history-width")) || 288);
  const sqlLibraryWidth = ref(Number(safeLocalStorageGet("dbx-sql-library-width")) || 288);
  const sqlFilePanelWidth = ref(Number(safeLocalStorageGet("dbx-sql-file-panel-width")) || 288);

  function startPanelResize(widthRef: Ref<number>, storageKey: string, direction: "left" | "right", maxWidth: PanelMaxWidth = DEFAULT_PANEL_MAX_WIDTH) {
    return (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const resizeHandle = e.currentTarget as HTMLElement | null;
      const resolvedMaxWidth = typeof maxWidth === "function" ? maxWidth(resizeHandle) : maxWidth;
      const upperBound = Number.isFinite(resolvedMaxWidth) ? Math.max(PANEL_MIN_WIDTH, resolvedMaxWidth) : DEFAULT_PANEL_MAX_WIDTH;
      const renderedWidth = resizeHandle?.parentElement?.getBoundingClientRect().width;
      const requestedStartWidth = typeof renderedWidth === "number" && Number.isFinite(renderedWidth) && renderedWidth > 0 ? renderedWidth : widthRef.value;
      const startWidth = Math.max(PANEL_MIN_WIDTH, Math.min(upperBound, requestedStartWidth));
      widthRef.value = startWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        widthRef.value = Math.max(PANEL_MIN_WIDTH, Math.min(upperBound, startWidth + (direction === "right" ? delta : -delta)));
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
  const startAiPanelResize = startPanelResize(aiPanelWidth, "dbx-ai-panel-width", "left", availableAiPanelMaxWidth);
  const startHistoryResize = startPanelResize(historyWidth, "dbx-history-width", "left");
  const startSqlLibraryResize = startPanelResize(sqlLibraryWidth, "dbx-sql-library-width", "left");
  const startSqlFilePanelResize = startPanelResize(sqlFilePanelWidth, "dbx-sql-file-panel-width", "left");

  return {
    sidebarWidth,
    aiPanelWidth,
    historyWidth,
    sqlLibraryWidth,
    sqlFilePanelWidth,
    startSidebarResize,
    startAiPanelResize,
    startHistoryResize,
    startSqlLibraryResize,
    startSqlFilePanelResize,
  };
}
