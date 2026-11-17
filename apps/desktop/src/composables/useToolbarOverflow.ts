import { nextTick, onUnmounted, ref, watch, type Ref, type WatchSource } from "vue";
import { deferUntilPanelResizeEnd } from "@/lib/app/panelResizeState";
import { EDITOR_TOOLBAR_MAX_TIER, resolveNextEditorToolbarTier, type EditorToolbarTier } from "@/lib/tabs/editorToolbarLayout";

/**
 * Measured progressive condensation for single-row toolbars — the same
 * mechanism as the SQL editor toolbar (resolveNextEditorToolbarTier): while
 * the row's content overflows its available width the tier steps up (moving
 * controls into an overflow menu); it only steps back down when the pane has
 * grown meaningfully since the last condensation AND the recorded requirement
 * of the restored tier fits with slack, so a static narrow layout can never
 * oscillate.
 *
 * Measurement contract: the toolbar row must be `overflow-hidden` with
 * non-shrinking (shrink-0) or floored (min-w-*) children, so scrollWidth
 * reliably exceeds clientWidth once nothing can shrink any further. Pure
 * `truncate` children without a floor collapse to zero width before the row
 * ever reports overflow, which would silently disable condensation. The
 * converse is why step-down needs recorded measurements: once the condensed
 * content fits, scrollWidth collapses back to clientWidth and the row can
 * never report slack by itself, so each tier's requirement is captured while
 * that tier's layout is still rendered and handed to
 * resolveNextEditorToolbarTier as expandedTierRequiredWidths.
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
  // Requirement of each tier captured right before it condensed into the next
  // one (same bookkeeping as EditorToolbar). Without these a condensed row
  // could never step back down: scrollWidth equals clientWidth once the
  // condensed content fits, so no measurable slack ever shows up.
  const expandedTierRequiredWidths: Partial<Record<EditorToolbarTier, number>> = {};
  let resizeObserver: ResizeObserver | undefined;

  function forgetExpandedTierMeasurements() {
    for (let candidate = 0; candidate <= EDITOR_TOOLBAR_MAX_TIER; candidate += 1) {
      delete expandedTierRequiredWidths[candidate as EditorToolbarTier];
    }
  }

  function measure() {
    const element = rootRef.value;
    if (!element) {
      return;
    }
    // clientWidth/scrollWidth reads force a document-wide synchronous relayout
    // on every resize notification; skip them during divider drags and take a
    // single measurement when the drag ends.
    if (deferUntilPanelResizeEnd(measure)) return;
    const next = resolveNextEditorToolbarTier({
      tier: tier.value,
      availableWidth: element.clientWidth,
      contentWidth: element.scrollWidth,
      condensedAtWidth: condensedAtWidth.value,
      expandedTierRequiredWidths,
    });
    if (next !== tier.value) {
      if (next > tier.value) {
        // Record the requirement of the tier being left while its layout is
        // still the rendered one; after the tier change re-renders, the row
        // reports the condensed extent and the information would be lost.
        expandedTierRequiredWidths[tier.value] = Math.max(expandedTierRequiredWidths[tier.value] ?? 0, element.scrollWidth);
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
      // The control set changed, so recorded requirements and the hysteresis
      // anchor describe a layout that no longer exists; converge again from
      // the full layout, like a freshly attached row.
      condensedAtWidth.value = 0;
      forgetExpandedTierMeasurements();
      if (tier.value !== 0) tier.value = 0;
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
      forgetExpandedTierMeasurements();
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
