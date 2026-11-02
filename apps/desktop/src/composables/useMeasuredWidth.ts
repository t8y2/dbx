import { nextTick, onUnmounted, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * Measured border-box width (CSS pixels) of a mirror element.
 *
 * Measuring primitive for widths that char-count arithmetic cannot predict:
 * bind the returned ref to a template ref and it tracks the element's real
 * laid-out width — including font-fallback advances, letter-spacing, and
 * sub-pixel rounding. Motivated by #9144, where the zh-CN shortcut-capture
 * placeholder advanced 15px/char on a machine whose CJK fallback font renders
 * wider than 1em, so a `label.length + 2em` width clipped the last glyph.
 *
 * The width starts at `fallback` so callers render a sane size before the
 * first measurement lands (and in environments without real layout, e.g.
 * happy-dom). Zero-width measurements are ignored: they mean "not laid out
 * yet" (or `display: none` ancestry), never "the text is zero pixels wide",
 * and must not clobber a usable width. `revalidateSources` covers content
 * changes that resize the element without moving it (e.g. a locale swap)
 * for environments where ResizeObserver is unavailable.
 */
export function useMeasuredWidth(targetRef: Ref<HTMLElement | null>, fallback = 0, revalidateSources: WatchSource[] = []): Ref<number> {
  const width = ref(fallback);
  let resizeObserver: ResizeObserver | undefined;

  function measure() {
    const element = targetRef.value;
    if (!element) {
      return;
    }
    const measured = element.getBoundingClientRect().width;
    if (measured > 0) {
      width.value = measured;
    }
  }

  if (revalidateSources.length > 0) {
    watch(revalidateSources, () => {
      void nextTick(measure);
    });
  }

  watch(
    targetRef,
    (element) => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (element && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(element);
      }
      void nextTick(measure);
    },
    { flush: "post" },
  );

  onUnmounted(() => {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
  });

  return width;
}
