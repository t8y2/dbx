import { injectDialogRootContext, useForwardExpose } from "reka-ui";
import { computed, onBeforeUnmount, onUpdated, ref, watch, watchPostEffect, type Ref } from "vue";

const BASE_DIALOG_Z_INDEX = 50;
const DIALOG_TOP_Z_INDEX_VAR = "--dbx-dialog-top-z-index";
const FLOATING_LAYER_Z_INDEX_VAR = "--dbx-floating-layer-z-index";

const activeDialogLayers = new Map<symbol, Ref<number>>();
const topDialogZIndex = ref(BASE_DIALOG_Z_INDEX);

function syncLayerVariables() {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.style.setProperty(DIALOG_TOP_Z_INDEX_VAR, String(topDialogZIndex.value));
  root.style.setProperty(FLOATING_LAYER_Z_INDEX_VAR, String(topDialogZIndex.value + 1));
}

function refreshTopDialogZIndex() {
  let zIndex = BASE_DIALOG_Z_INDEX;
  // Compact in insertion order even while a parent dialog remains open.
  for (const layer of activeDialogLayers.values()) layer.value = ++zIndex;
  topDialogZIndex.value = zIndex;
  syncLayerVariables();
}

function registerDialogLayer(id: symbol, zIndex: Ref<number>) {
  if (activeDialogLayers.has(id)) return;

  activeDialogLayers.set(id, zIndex);
  refreshTopDialogZIndex();
}

function unregisterDialogLayer(id: symbol) {
  if (!activeDialogLayers.delete(id)) return;

  refreshTopDialogZIndex();
}

/** Keep Reka's positioning wrapper in sync with the floating content's layer. */
export function useFloatingLayerOrder() {
  const { forwardRef, currentElement } = useForwardExpose();

  function syncWrapper() {
    const element = currentElement.value;
    const wrapper = element?.hasAttribute("data-reka-popper-content-wrapper") ? element : element?.parentElement;
    if (!wrapper || (!wrapper.hasAttribute("data-reka-popper-content-wrapper") && element.dataset.alignTrigger !== "true")) return;

    // Reka copies the content's computed z-index to the positioning wrapper.
    // Read that value before enabling the important override below, otherwise
    // an existing z-[60]/z-[80] value would be replaced by the live default.
    const contentElement = wrapper === element ? (element.firstElementChild ?? element) : element;
    const contentZIndex = Number.parseInt(getComputedStyle(contentElement).zIndex, 10);
    const wrapperZIndex = Number.parseInt(wrapper.style.zIndex, 10);
    const preservedZIndex = Math.max(Number.isFinite(contentZIndex) ? contentZIndex : 0, Number.isFinite(wrapperZIndex) ? wrapperZIndex : 0);
    wrapper.style.setProperty("--dbx-floating-content-z-index", String(preservedZIndex));
    wrapper.dataset.dbxFloatingLayer = "";
  }

  watchPostEffect(() => {
    void topDialogZIndex.value;
    syncWrapper();
  });
  onUpdated(syncWrapper);

  return { forwardRef };
}

/**
 * Keep the visual order of dialogs aligned with Reka UI's logical layer stack.
 *
 * Reparenting portal nodes changes only their DOM order. Reka UI keeps a
 * separate insertion ordered layer set for pointer-events and outside-click
 * handling, so reparenting can leave the visible top dialog unreachable. A
 * z-index gives each open dialog a new visual layer while its logical layer
 * remains where Reka UI registered it.
 */
export function useDialogLayerOrder() {
  const rootContext = injectDialogRootContext();
  const layerId = Symbol("dialog-layer");
  const zIndex = ref(BASE_DIALOG_Z_INDEX);

  watch(
    () => rootContext?.open.value ?? false,
    (isOpen) => {
      if (isOpen) {
        registerDialogLayer(layerId, zIndex);
      } else {
        unregisterDialogLayer(layerId);
      }
    },
    { flush: "post", immediate: true },
  );

  onBeforeUnmount(() => unregisterDialogLayer(layerId));

  return {
    layerStyle: computed(() => ({ zIndex: String(zIndex.value) })),
  };
}
