const SQL_HOVER_SCROLLBAR_MIN_THUMB_WIDTH = 36;

export function sqlHoverScrollbarMetrics(clientWidth: number, scrollWidth: number, scrollLeft: number, trackWidth: number) {
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  const thumbWidth = maxScroll > 0 ? Math.max(SQL_HOVER_SCROLLBAR_MIN_THUMB_WIDTH, trackWidth * (clientWidth / scrollWidth)) : trackWidth;
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const thumbLeft = maxScroll > 0 ? (Math.min(Math.max(scrollLeft, 0), maxScroll) / maxScroll) * maxThumbLeft : 0;
  return { maxScroll, maxThumbLeft, thumbLeft, thumbWidth };
}

export interface SqlHoverLayoutController {
  /** Called after the tooltip dom is added to the document. */
  mount(): void;
  /** Called when the tooltip is removed or the editor is destroyed. */
  destroy(): void;
}

function appendSqlHoverHorizontalScrollbar(root: HTMLElement, sqlContent: HTMLElement): SqlHoverLayoutController {
  const track = document.createElement("div");
  track.dataset.sqlStructureHoverScrollbar = "true";
  track.hidden = true;

  const thumb = document.createElement("div");
  thumb.dataset.sqlStructureHoverScrollbarThumb = "true";
  track.appendChild(thumb);
  root.appendChild(track);

  let dragOffset = 0;
  let dragging = false;
  let resizeObserver: ResizeObserver | null = null;

  const update = () => {
    const metrics = sqlHoverScrollbarMetrics(sqlContent.clientWidth, sqlContent.scrollWidth, sqlContent.scrollLeft, track.clientWidth);
    track.hidden = metrics.maxScroll <= 1;
    thumb.style.width = `${metrics.thumbWidth}px`;
    thumb.style.transform = `translateX(${metrics.thumbLeft}px)`;
  };

  const scrollFromPointer = (clientX: number) => {
    const trackRect = track.getBoundingClientRect();
    const metrics = sqlHoverScrollbarMetrics(sqlContent.clientWidth, sqlContent.scrollWidth, sqlContent.scrollLeft, trackRect.width);
    if (metrics.maxScroll <= 0 || metrics.maxThumbLeft <= 0) return;
    const thumbLeft = Math.min(Math.max(clientX - trackRect.left - dragOffset, 0), metrics.maxThumbLeft);
    sqlContent.scrollLeft = (thumbLeft / metrics.maxThumbLeft) * metrics.maxScroll;
    update();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const thumbRect = thumb.getBoundingClientRect();
    dragOffset = event.target === thumb ? event.clientX - thumbRect.left : thumbRect.width / 2;
    dragging = true;
    track.setPointerCapture(event.pointerId);
    scrollFromPointer(event.clientX);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    scrollFromPointer(event.clientX);
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: WheelEvent) => {
    const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!horizontalDelta) return;
    const maxScroll = Math.max(0, sqlContent.scrollWidth - sqlContent.clientWidth);
    const nextScrollLeft = Math.min(Math.max(sqlContent.scrollLeft + horizontalDelta, 0), maxScroll);
    if (nextScrollLeft === sqlContent.scrollLeft) return;
    event.preventDefault();
    sqlContent.scrollLeft = nextScrollLeft;
    update();
  };

  // 事件监听在构建时绑定即可，元素未挂载也不影响；ResizeObserver 必须等
  // dom 进入文档后才能拿到正确尺寸，故放到 mount() 里启动。
  sqlContent.addEventListener("scroll", update, { passive: true });
  sqlContent.addEventListener("wheel", handleWheel, { passive: false });
  track.addEventListener("pointerdown", handlePointerDown);
  track.addEventListener("pointermove", handlePointerMove);
  track.addEventListener("pointerup", handlePointerUp);
  track.addEventListener("pointercancel", handlePointerUp);

  return {
    mount() {
      update();
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(sqlContent);
      resizeObserver.observe(track);
    },
    destroy() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      sqlContent.removeEventListener("scroll", update);
      sqlContent.removeEventListener("wheel", handleWheel);
      track.removeEventListener("pointerdown", handlePointerDown);
      track.removeEventListener("pointermove", handlePointerMove);
      track.removeEventListener("pointerup", handlePointerUp);
      track.removeEventListener("pointercancel", handlePointerUp);
    },
  };
}

/** Keep table-DDL hovers readable without allowing one long line to size the tooltip. */
export function constrainSqlHoverLayout(root: HTMLElement, sqlContent: HTMLElement): SqlHoverLayoutController {
  root.dataset.sqlStructureHover = "true";
  root.style.boxSizing = "border-box";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.maxHeight = "calc(50vh - 12px)";
  root.style.maxWidth = "900px";
  root.style.overflow = "hidden";
  root.style.width = "80vw";

  sqlContent.dataset.sqlStructureHoverContent = "true";
  sqlContent.style.flex = "0 1 auto";
  sqlContent.style.maxHeight = "480px";
  sqlContent.style.maxWidth = "100%";
  sqlContent.style.minHeight = "0";
  sqlContent.style.overflowX = "hidden";
  sqlContent.style.overflowY = "auto";
  sqlContent.style.overscrollBehavior = "contain";
  sqlContent.style.scrollbarGutter = "stable";

  return appendSqlHoverHorizontalScrollbar(root, sqlContent);
}
