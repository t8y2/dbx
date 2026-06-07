import { onBeforeUnmount, ref, watch, type Ref } from "vue";

export function useTabScroll(tabsContainerRef: Ref<HTMLElement | null>) {
  const hasTabOverflow = ref(false);
  const canScrollLeft = ref(false);
  const canScrollRight = ref(false);
  let resizeObserver: ResizeObserver | null = null;
  let updateFrame = 0;

  function updateScrollButtons() {
    const el = tabsContainerRef.value;
    if (!el) {
      hasTabOverflow.value = false;
      canScrollLeft.value = false;
      canScrollRight.value = false;
      return;
    }
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    hasTabOverflow.value = maxScrollLeft > 1;
    canScrollLeft.value = el.scrollLeft > 1;
    canScrollRight.value = el.scrollLeft < maxScrollLeft - 1;
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

  function scrollTabs(direction: "left" | "right") {
    const el = tabsContainerRef.value;
    if (!el) return;
    const scrollAmount = Math.max(160, el.clientWidth * 0.65);
    el.scrollBy({ left: direction === "left" ? -scrollAmount : scrollAmount, behavior: "smooth" });
    scheduleScrollButtonUpdate();
    window.setTimeout(updateScrollButtons, 260);
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
    if (updateFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(updateFrame);
    }
  });

  return { hasTabOverflow, canScrollLeft, canScrollRight, updateScrollButtons, scrollTabs, onTabsWheel };
}
