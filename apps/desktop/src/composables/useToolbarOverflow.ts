import { nextTick, onUnmounted, ref, watch, type Ref, type WatchSource } from "vue";
import { resolveNextEditorToolbarTier, type EditorToolbarTier } from "@/lib/tabs/editorToolbarLayout";

/**
 * Measured progressive condensation for single-row toolbars — the same
 * mechanism as the SQL editor toolbar (resolveNextEditorToolbarTier): while
 * the row's content overflows its available width the tier steps up (moving
 * controls into an overflow menu); it only steps back down when there is real
 * slack AND the pane has grown meaningfully since the last condensation, so a
 * static narrow layout can never oscillate.
 *
 * Measurement contract: the toolbar row must be `overflow-hidden` with
 * non-shrinking (shrink-0) or floored (min-w-*) children, so scrollWidth
 * reliably exceeds clientWidth once nothing can shrink any further. Pure
 * `truncate` children without a floor collapse to zero width before the row
 * ever reports overflow, which would silently disable condensation.
 *
 * @param rootRef the toolbar row element
 * @param revalidateSources reactive sources whose change alters the row's
 *   visible control set (active tab, feature flags, conditional controls);
 *   each change re-measures, because hiding/restoring controls changes the
 *   content extent without resizing the toolbar box.
 */
export function useToolbarOverflow(rootRef: Ref<HTMLElement | null>, revalidateSources: WatchSource[] = []) {
  const tier = ref<EditorToolbarTier>(0);
  // Available width when the current tier was condensed into; anchors the
  // step-down hysteresis so a static narrow layout cannot oscillate.
  const condensedAtWidth = ref(0);
  let resizeObserver: ResizeObserver | undefined;

  function measure() {
    const element = rootRef.value;
    if (!element) {
      return;
    }
    const next = resolveNextEditorToolbarTier({
      tier: tier.value,
      availableWidth: element.clientWidth,
      contentWidth: element.scrollWidth,
      condensedAtWidth: condensedAtWidth.value,
    });
    if (next !== tier.value) {
      if (next > tier.value) {
        condensedAtWidth.value = element.clientWidth;
      }
      tier.value = next;
    }
  }

  // Hiding or restoring controls changes the row content without resizing the
  // toolbar box, so every tier change re-measures until the row settles.
  watch(tier, () => {
    void nextTick(measure);
  });

  if (revalidateSources.length > 0) {
    watch(revalidateSources, () => {
      void nextTick(measure);
    });
  }

  watch(
    rootRef,
    (element) => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      // A freshly attached row (mode switch, tab remount) starts from the full
      // layout and converges from real measurements instead of inheriting a
      // stale tier from whatever was previously measured.
      tier.value = 0;
      condensedAtWidth.value = 0;
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

  return { tier, measure };
}
