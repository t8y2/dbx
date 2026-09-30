import { injectDialogRootContext } from "reka-ui";
import { watch, type Ref } from "vue";

/**
 * Keeps a dialog layer painted above every dialog that was opened before it.
 *
 * `DialogPortal` only teleports its children, it does not gate them on the open state,
 * so the `fixed inset-0 z-50` wrapper lands in the target as soon as the dialog
 * *component* mounts. Because all dialog layers share the same z-index, the browser
 * paints them in mount order. A dialog mounted earlier therefore covered one that opens
 * later: Reka UI's dismissable-layer stack still handed pointer events to the later
 * dialog, so that dialog stayed invisible while the earlier one became unclickable.
 *
 * Re-appending the wrapper when its dialog opens makes paint order follow open order
 * instead of mount order. The element stays mounted on close, so enter/leave animations
 * are unchanged.
 */
export function useDialogLayerOrder(positioner: Ref<HTMLElement | null>) {
  const rootContext = injectDialogRootContext();

  function raiseLayer() {
    const element = positioner.value;
    const parent = element?.parentNode;
    if (!element || !parent || parent.lastElementChild === element) return;
    // The overlay is the sibling right in front of the wrapper; move both so a later
    // dialog's backdrop still covers the earlier dialog instead of slipping under it.
    const overlay = element.previousElementSibling;
    if (overlay?.getAttribute("data-slot") === "dialog-overlay") parent.appendChild(overlay);
    parent.appendChild(element);
  }

  watch(
    () => rootContext?.open.value ?? false,
    (isOpen) => {
      if (isOpen) raiseLayer();
    },
    { flush: "post" },
  );
}
