import { getCurrentScope, onScopeDispose, type Ref } from "vue";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";

/**
 * Vertical counterpart of `usePanelResize` for the global bottom dock, which
 * grows upward from the window's bottom edge (height delta = negated clientY
 * delta). Same contract as the horizontal original: pointer capture on the
 * handle, rAF-coalesced direct style writes while dragging, reactive commit on
 * release, and the global measurement freeze for heavy subtrees.
 *
 * Pointer capture is not an optimization here: the dock body is plugin
 * iframes, and without capture those iframes swallow pointermove/pointerup —
 * the height freezes mid-drag and a release over an iframe leaks the
 * listeners, letting later buttonless moves ghost-drive the dock.
 */
export interface DockResizeOptions {
  /** Reactive dock height in px; committed on drag end. */
  dockHeight: Ref<number>;
  minHeight: number;
  /** Fraction of the window height the dock may occupy. Keep this identical to the maximize height so maximizing never shrinks a dragged dock. */
  maxHeightRatio?: number;
  /** The dock root element, read for the seamless start height and written during the drag. */
  dockElement: () => HTMLElement | null;
}

export function useDockResize({ dockHeight, minHeight, maxHeightRatio = 0.8, dockElement }: DockResizeOptions) {
  const maxHeight = () => Math.max(minHeight, Math.floor(window.innerHeight * maxHeightRatio));
  let rafId: number | null = null;
  let finish: (() => void) | null = null;

  function startResize(event: PointerEvent) {
    if (event.button !== 0 || finish) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement | null;
    handle?.setPointerCapture(event.pointerId);
    beginPanelResize();
    const overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "row-resize",
      userSelect: "none",
      touchAction: "none",
    });
    document.body.append(overlay);

    const rendered = dockElement()?.getBoundingClientRect().height ?? 0;
    const startHeight = Math.min(maxHeight(), Math.max(minHeight, rendered > 0 ? rendered : dockHeight.value));
    const startY = event.clientY;
    const root = dockElement();
    let currentHeight = startHeight;

    const applyHeight = () => {
      root?.style.setProperty("height", `${currentHeight}px`);
      rafId = null;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        // The press was lost without a matching pointerup (gesture/iframe
        // edge): release instead of ghost-resizing on buttonless moves.
        finishResize();
        return;
      }
      const next = startHeight - (moveEvent.clientY - startY);
      currentHeight = Math.max(minHeight, Math.min(maxHeight(), next));
      // happy-dom unit tests assert styles synchronously (no frame advance),
      // so apply immediately under the test mode instead of via rAF.
      if (import.meta.env.MODE === "test") {
        applyHeight();
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(applyHeight);
    };

    const finishResize = () => {
      if (!finish) return;
      finish = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      root?.style.setProperty("height", `${currentHeight}px`);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", finishResize);
      if (handle?.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      endPanelResize();
      overlay.remove();
      dockHeight.value = currentHeight;
    };
    finish = finishResize;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", finishResize, { once: true });
  }

  // A dock unmounted mid-drag must not leave the window listeners behind.
  if (getCurrentScope()) onScopeDispose(() => finish?.());

  return { startResize };
}
