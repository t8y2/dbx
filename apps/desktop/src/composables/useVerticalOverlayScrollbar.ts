import { computed, onBeforeUnmount, ref, watch, type CSSProperties, type Ref } from "vue";

/**
 * Thin floating overlay scrollbar (track + draggable thumb) for a plain
 * `overflow-y-auto` element, matching the sidebar tree's custom scrollbar
 * look/feel. The native scrollbar should be hidden on the scroller via CSS
 * (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`).
 *
 * `scrollerRef`, `contentRef`, and `trackRef` are declared by the caller
 * (plain `ref<HTMLElement | null>(null)`) and bound via `ref="..."` in its
 * template — mirrors the pattern already used for the sidebar tree's own
 * scrollbar. `contentRef` must be the direct child that wraps everything
 * inside the scroller: because `scrollerRef` itself is `overflow-y-auto`, its
 * own box height is capped by the surrounding flex layout and does NOT change
 * when its content grows (e.g. async-loaded rows/charts) — only `contentRef`,
 * an in-flow element, reports that growth via ResizeObserver.
 */
export function useVerticalOverlayScrollbar(scrollerRef: Ref<HTMLElement | null>, contentRef: Ref<HTMLElement | null>, trackRef: Ref<HTMLElement | null>) {
  const hasOverflow = ref(false);
  const isScrolling = ref(false);
  const isDragging = ref(false);
  const thumbTopPercent = ref(0);
  const thumbHeightPercent = ref(100);

  let scrollerResizeObserver: ResizeObserver | null = null;
  let contentResizeObserver: ResizeObserver | null = null;
  let scrollHideTimer: ReturnType<typeof setTimeout> | null = null;
  let dragOffsetPx = 0;

  function updateMetrics() {
    const el = scrollerRef.value;
    if (!el) {
      hasOverflow.value = false;
      return;
    }
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    hasOverflow.value = maxScrollTop > 1;
    const rawThumbHeight = el.scrollHeight > 0 ? (el.clientHeight / el.scrollHeight) * 100 : 100;
    const thumbHeight = Math.min(100, Math.max(8, rawThumbHeight));
    const thumbTravel = Math.max(0, 100 - thumbHeight);
    thumbHeightPercent.value = thumbHeight;
    thumbTopPercent.value = maxScrollTop > 0 ? (el.scrollTop / maxScrollTop) * thumbTravel : 0;
  }

  function onScroll() {
    updateMetrics();
    isScrolling.value = true;
    if (scrollHideTimer) clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => {
      isScrolling.value = false;
    }, 600);
  }

  function setScrollFromPointer(clientY: number, offsetPx: number) {
    const el = scrollerRef.value;
    const track = trackRef.value;
    if (!el || !track) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScrollTop <= 0) return;
    const trackRect = track.getBoundingClientRect();
    const thumbHeightPx = trackRect.height * (thumbHeightPercent.value / 100);
    const maxThumbTopPx = Math.max(1, trackRect.height - thumbHeightPx);
    const thumbTopPx = Math.min(maxThumbTopPx, Math.max(0, clientY - trackRect.top - offsetPx));
    el.scrollTop = (thumbTopPx / maxThumbTopPx) * maxScrollTop;
    updateMetrics();
  }

  function onPointerMove(event: PointerEvent) {
    if (!isDragging.value) return;
    event.preventDefault();
    setScrollFromPointer(event.clientY, dragOffsetPx);
  }

  function stopDrag() {
    isDragging.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
    document.body.style.userSelect = "";
  }

  function startDrag(offsetPx: number, clientY: number) {
    dragOffsetPx = offsetPx;
    isDragging.value = true;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    setScrollFromPointer(clientY, offsetPx);
  }

  function onTrackPointerDown(event: PointerEvent) {
    if (!hasOverflow.value) return;
    const trackRect = trackRef.value?.getBoundingClientRect();
    if (!trackRect) return;
    const thumbHeightPx = trackRect.height * (thumbHeightPercent.value / 100);
    event.preventDefault();
    startDrag(thumbHeightPx / 2, event.clientY);
  }

  function onThumbPointerDown(event: PointerEvent) {
    const track = trackRef.value;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const thumbTopPx = rect.height * (thumbTopPercent.value / 100);
    event.preventDefault();
    startDrag(event.clientY - rect.top - thumbTopPx, event.clientY);
  }

  watch(
    scrollerRef,
    (el) => {
      scrollerResizeObserver?.disconnect();
      scrollerResizeObserver = null;
      if (el && typeof ResizeObserver !== "undefined") {
        scrollerResizeObserver = new ResizeObserver(updateMetrics);
        scrollerResizeObserver.observe(el);
      }
      updateMetrics();
    },
    { flush: "post", immediate: true },
  );

  watch(
    contentRef,
    (el) => {
      contentResizeObserver?.disconnect();
      contentResizeObserver = null;
      if (el && typeof ResizeObserver !== "undefined") {
        contentResizeObserver = new ResizeObserver(updateMetrics);
        contentResizeObserver.observe(el);
      }
      updateMetrics();
    },
    { flush: "post", immediate: true },
  );

  onBeforeUnmount(() => {
    scrollerResizeObserver?.disconnect();
    contentResizeObserver?.disconnect();
    stopDrag();
    if (scrollHideTimer) clearTimeout(scrollHideTimer);
  });

  const thumbStyle = computed<CSSProperties>(() => ({
    top: `${thumbTopPercent.value}%`,
    height: `${thumbHeightPercent.value}%`,
  }));

  return { hasOverflow, isScrolling, isDragging, thumbStyle, onScroll, onTrackPointerDown, onThumbPointerDown };
}
