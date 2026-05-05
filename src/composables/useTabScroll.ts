import { ref, type Ref } from "vue";

export function useTabScroll(tabsContainerRef: Ref<HTMLElement | null>) {
  const canScrollLeft = ref(false);
  const canScrollRight = ref(false);

  function updateScrollButtons() {
    const el = tabsContainerRef.value;
    if (!el) {
      canScrollLeft.value = false;
      canScrollRight.value = false;
      return;
    }
    canScrollLeft.value = el.scrollLeft > 0;
    canScrollRight.value = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  }

  function scrollTabs(direction: "left" | "right") {
    const el = tabsContainerRef.value;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.8;
    el.scrollBy({ left: direction === "left" ? -scrollAmount : scrollAmount, behavior: "smooth" });
  }

  return { canScrollLeft, canScrollRight, updateScrollButtons, scrollTabs };
}
