import { nextTick, onUnmounted, ref } from "vue";

export function useTableInfoHeaderLayout() {
  const tableInfoHeaderRef = ref<HTMLDivElement>();
  const tableInfoActionLabelsCompact = ref(false);
  let tableInfoHeaderResizeObserver: ResizeObserver | null = null;
  let tableInfoHeaderMutationObserver: MutationObserver | null = null;
  let tableInfoHeaderMeasureFrame: number | null = null;

  function measureTableInfoActionLabels() {
    const header = tableInfoHeaderRef.value;
    if (!header || typeof document === "undefined") {
      tableInfoActionLabelsCompact.value = false;
      return;
    }

    // Measure the expanded layout without changing the visible header. The title's
    // natural width is compared with the space left after all action labels render.
    const expandedHeader = header.cloneNode(true) as HTMLDivElement;
    expandedHeader.classList.remove("table-info-header--compact");
    expandedHeader.style.position = "fixed";
    expandedHeader.style.left = "-100000px";
    expandedHeader.style.top = "0";
    expandedHeader.style.width = `${header.clientWidth}px`;
    expandedHeader.style.visibility = "hidden";
    expandedHeader.style.pointerEvents = "none";
    document.body.append(expandedHeader);
    const title = expandedHeader.querySelector<HTMLElement>(".table-info-title");
    const shouldCompact = !!title && title.scrollWidth > title.clientWidth + 1;
    expandedHeader.remove();

    tableInfoActionLabelsCompact.value = shouldCompact;
  }

  function scheduleTableInfoActionLabelMeasurement() {
    if (tableInfoHeaderMeasureFrame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(tableInfoHeaderMeasureFrame);
      tableInfoHeaderMeasureFrame = null;
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      void nextTick(measureTableInfoActionLabels);
      return;
    }
    tableInfoHeaderMeasureFrame = window.requestAnimationFrame(() => {
      tableInfoHeaderMeasureFrame = null;
      measureTableInfoActionLabels();
    });
  }

  function disconnectTableInfoHeader() {
    tableInfoHeaderResizeObserver?.disconnect();
    tableInfoHeaderResizeObserver = null;
    tableInfoHeaderMutationObserver?.disconnect();
    tableInfoHeaderMutationObserver = null;
    if (tableInfoHeaderMeasureFrame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(tableInfoHeaderMeasureFrame);
      tableInfoHeaderMeasureFrame = null;
    }
    tableInfoActionLabelsCompact.value = false;
  }

  function observeTableInfoHeader() {
    disconnectTableInfoHeader();

    const header = tableInfoHeaderRef.value;
    if (!header) return;
    if (typeof ResizeObserver !== "undefined") {
      tableInfoHeaderResizeObserver = new ResizeObserver(scheduleTableInfoActionLabelMeasurement);
      tableInfoHeaderResizeObserver.observe(header);
    }
    if (typeof MutationObserver !== "undefined") {
      tableInfoHeaderMutationObserver = new MutationObserver(scheduleTableInfoActionLabelMeasurement);
      tableInfoHeaderMutationObserver.observe(header, { childList: true, characterData: true, subtree: true });
    }
    scheduleTableInfoActionLabelMeasurement();
  }

  onUnmounted(disconnectTableInfoHeader);

  return {
    tableInfoHeaderRef,
    tableInfoActionLabelsCompact,
    observeTableInfoHeader,
    disconnectTableInfoHeader,
  };
}
