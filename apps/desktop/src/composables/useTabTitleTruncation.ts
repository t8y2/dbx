import { onUnmounted, ref, watch, type Ref } from "vue";
import { deferUntilPanelResizeEnd } from "@/lib/app/panelResizeState";

/**
 * A tab's label is ellipsized in two independent halves: the base title and its
 * suffix. Either one clipping means the user is not seeing the whole tab.
 */
const TITLE_SELECTOR = "[data-tab-title-base], [data-tab-title-suffix]";
/** Content wider than its box by ±1px is sub-pixel rounding, not ellipsis. */
const CLIP_TOLERANCE_PX = 1;

/**
 * Tracks whether the tab strip ellipsizes any of the titles it shows.
 *
 * `.tab-group-entry` is capped at `var(--tab-max-width, 100%)`, so tabs narrow
 * themselves down to the strip and clip their labels instead of overflowing it.
 * The scroll box then reports scrollWidth === clientWidth and the overflow check
 * in useTabScroll can never see those tabs — yet they are exactly what the user
 * reads as "not all tabs fit". The strip's dropdown arrow therefore has to
 * follow the clipping as well as the overflow, or a strip whose titles are all
 * ellipsized offers no way to reach them.
 *
 * Measurement contract: nothing the arrow controls may change the widths read
 * here. The arrow is an absolutely positioned sibling of the strip and the
 * strip's right-hand reservation in appTabBar.css is constant, so toggling it is
 * invisible to these measurements. A reservation derived from the arrow's own
 * visibility would turn this into the feedback loop that flipped it every frame.
 *
 * @param stripRef the strip element holding the titles (its scroll container)
 */
export function useTabTitleTruncation(stripRef: Ref<HTMLElement | null>) {
  const hasTruncatedTabTitle = ref(false);
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  let updateFrame = 0;

  function measure() {
    const strip = stripRef.value;
    if (!strip) {
      hasTruncatedTabTitle.value = false;
      return;
    }
    // clientWidth/scrollWidth reads force a synchronous relayout of the whole
    // document; skip them while a divider drag is in flight and read once when
    // the drag ends.
    if (deferUntilPanelResizeEnd(measure)) return;
    hasTruncatedTabTitle.value = Array.from(strip.querySelectorAll<HTMLElement>(TITLE_SELECTOR)).some((title) => title.scrollWidth - title.clientWidth > CLIP_TOLERANCE_PX);
  }

  function scheduleMeasure() {
    if (updateFrame) return;
    const update = () => {
      updateFrame = 0;
      measure();
    };
    if (typeof requestAnimationFrame === "function") {
      updateFrame = requestAnimationFrame(update);
    } else {
      window.setTimeout(update, 0);
    }
  }

  // A pill that is already capped keeps its width when its label grows, so the
  // strip's own box never reports a rename, a dirty marker or an extra tab;
  // those move the pill's box. Watch every pill as well, and re-arm on DOM
  // changes, which is what actually adds and removes pills.
  function observePills() {
    const strip = stripRef.value;
    if (!strip || !resizeObserver) return;
    for (const pill of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) resizeObserver.observe(pill);
  }

  watch(
    stripRef,
    (strip) => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = undefined;
      mutationObserver = undefined;
      if (!strip) {
        hasTruncatedTabTitle.value = false;
        return;
      }
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleMeasure);
        resizeObserver.observe(strip);
        observePills();
      }
      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(() => {
          observePills();
          scheduleMeasure();
        });
        mutationObserver.observe(strip, { childList: true, characterData: true, subtree: true });
      }
      // The previous reading is kept until this one lands: on a strip remount
      // (layout switch, pane rebuild) the tabs and their clipping are usually
      // unchanged, and clearing the flag first would blink the arrow off.
      scheduleMeasure();
    },
    // `immediate` covers a caller that hands over an already-attached strip; a
    // null first reading is free and the watcher still runs on the real change.
    { flush: "post", immediate: true },
  );

  onUnmounted(() => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = undefined;
    mutationObserver = undefined;
    if (updateFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(updateFrame);
    updateFrame = 0;
  });

  return { hasTruncatedTabTitle, measureTabTitleTruncation: measure };
}
