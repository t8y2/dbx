import { onBeforeUnmount, ref, watch, type Ref } from "vue";

export function useTabScroll(tabsContainerRef: Ref<HTMLElement | null>) {
  const hasTabOverflow = ref(false);
  const scrollThumbLeftPercent = ref(0);
  const scrollThumbWidthPercent = ref(100);
  const isScrollbarDragging = ref(false);
  let resizeObserver: ResizeObserver | null = null;
  let updateFrame = 0;
  let dragState: {
    trackRect: DOMRect;
    thumbOffsetPx: number;
  } | null = null;

  function updateScrollButtons() {
    const el = tabsContainerRef.value;
    if (!el) {
      hasTabOverflow.value = false;
      scrollThumbLeftPercent.value = 0;
      scrollThumbWidthPercent.value = 100;
      return;
    }
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    hasTabOverflow.value = maxScrollLeft > 1;
    const rawThumbWidth = el.scrollWidth > 0 ? (el.clientWidth / el.scrollWidth) * 100 : 100;
    const thumbWidth = Math.min(100, Math.max(8, rawThumbWidth));
    const thumbTravel = Math.max(0, 100 - thumbWidth);
    scrollThumbWidthPercent.value = thumbWidth;
    scrollThumbLeftPercent.value = maxScrollLeft > 0 ? (el.scrollLeft / maxScrollLeft) * thumbTravel : 0;
  }

  function scheduleScrollButtonUpdate() {
    if (updateFrame) return;
    const update = () => {
      updateFrame = 0;
      updateScrollButtons();
    };
    if (typeof requestAnimationFrame === "function") {
      updateFrame = requestAnimationFrame(update);
    } else {
      window.setTimeout(update, 0);
    }
  }

  function onTabsWheel(event: WheelEvent) {
    const el = tabsContainerRef.value;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 1) return;

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;

    const previousScrollLeft = el.scrollLeft;
    el.scrollLeft = Math.min(maxScrollLeft, Math.max(0, previousScrollLeft + delta));
    if (el.scrollLeft !== previousScrollLeft) {
      event.preventDefault();
      updateScrollButtons();
    }
  }

  function applyScrollbarDrag(clientX: number) {
    const el = tabsContainerRef.value;
    if (!el || !dragState) return;

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 1) return;

    const thumbWidthPx = dragState.trackRect.width * (scrollThumbWidthPercent.value / 100);
    const maxThumbLeftPx = Math.max(1, dragState.trackRect.width - thumbWidthPx);
    const thumbLeftPx = Math.min(maxThumbLeftPx, Math.max(0, clientX - dragState.trackRect.left - dragState.thumbOffsetPx));
    el.scrollLeft = (thumbLeftPx / maxThumbLeftPx) * maxScrollLeft;
    updateScrollButtons();
  }

  function onScrollbarPointerMove(event: PointerEvent) {
    if (!dragState) return;
    event.preventDefault();
    applyScrollbarDrag(event.clientX);
  }

  function stopScrollbarDrag() {
    if (!dragState) return;
    dragState = null;
    isScrollbarDragging.value = false;
    window.removeEventListener("pointermove", onScrollbarPointerMove, true);
    window.removeEventListener("pointerup", stopScrollbarDrag, true);
    window.removeEventListener("pointercancel", stopScrollbarDrag, true);
    document.body.style.userSelect = "";
  }

  function startScrollbarDrag(event: PointerEvent) {
    const el = tabsContainerRef.value;
    const track = event.currentTarget as HTMLElement | null;
    if (!el || !track || !hasTabOverflow.value) return;

    const trackRect = track.getBoundingClientRect();
    const thumbLeftPx = trackRect.width * (scrollThumbLeftPercent.value / 100);
    const thumbWidthPx = trackRect.width * (scrollThumbWidthPercent.value / 100);
    const pointerX = event.clientX - trackRect.left;
    const pointerInsideThumb = pointerX >= thumbLeftPx && pointerX <= thumbLeftPx + thumbWidthPx;

    dragState = {
      trackRect,
      thumbOffsetPx: pointerInsideThumb ? pointerX - thumbLeftPx : thumbWidthPx / 2,
    };
    isScrollbarDragging.value = true;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onScrollbarPointerMove, true);
    window.addEventListener("pointerup", stopScrollbarDrag, true);
    window.addEventListener("pointercancel", stopScrollbarDrag, true);
    event.preventDefault();
    applyScrollbarDrag(event.clientX);
  }

  watch(
    tabsContainerRef,
    (el) => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (el && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleScrollButtonUpdate);
        resizeObserver.observe(el);
      }
      scheduleScrollButtonUpdate();
    },
    { flush: "post" },
  );

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    stopScrollbarDrag();
    if (updateFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(updateFrame);
    }
  });

  return {
    hasTabOverflow,
    scrollThumbLeftPercent,
    scrollThumbWidthPercent,
    isScrollbarDragging,
    updateScrollButtons,
    onTabsWheel,
    startScrollbarDrag,
  };
}
