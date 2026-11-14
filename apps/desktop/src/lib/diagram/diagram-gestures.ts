import { diagramViewportAtZoom, normalizeDiagramWheelDelta, zoomFromGestureScale, zoomFromWheelDelta } from "./diagramZoom";

type Viewport = { x: number; y: number; zoom: number };
type GestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

/** Chromium pinch uses Ctrl-wheel; WebKit also sends native gesture events. */
export function createDiagramGestureHandlers(options: { getPane: () => HTMLElement | null; getViewport: () => Viewport; setViewport: (viewport: Viewport) => void }) {
  let gesture: { viewport: Viewport; pointer: { x: number; y: number } } | null = null;

  function paneFor(event: Event) {
    if (event.target instanceof Element && event.target.closest(".nowheel")) return null;
    return options.getPane();
  }

  function consume(event: Event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function pointerFor(event: GestureEvent, pane: HTMLElement) {
    const bounds = pane.getBoundingClientRect();
    return { x: Number.isFinite(event.clientX) ? event.clientX! - bounds.left : bounds.width / 2, y: Number.isFinite(event.clientY) ? event.clientY! - bounds.top : bounds.height / 2 };
  }

  return {
    wheel(event: WheelEvent) {
      const pane = paneFor(event);
      if (!pane || !event.ctrlKey) return;
      // Some WebViews send both event families for one pinch.
      if (gesture) {
        consume(event);
        return;
      }
      const delta = normalizeDiagramWheelDelta(event.deltaY, event.deltaMode, pane.getBoundingClientRect().height);
      if (delta === 0 || !Number.isFinite(delta)) return;
      consume(event);
      const viewport = options.getViewport();
      options.setViewport(diagramViewportAtZoom(viewport, pointerFor(event, pane), zoomFromWheelDelta(viewport.zoom, delta)));
    },
    gestureStart(event: GestureEvent) {
      const pane = paneFor(event);
      if (!pane) return;
      consume(event);
      gesture = { viewport: { ...options.getViewport() }, pointer: pointerFor(event, pane) };
    },
    gestureChange(event: GestureEvent) {
      const pane = paneFor(event);
      if (!pane || !gesture || typeof event.scale !== "number" || !Number.isFinite(event.scale) || event.scale <= 0) return;
      consume(event);
      const pointer = pointerFor(event, pane);
      const next = diagramViewportAtZoom(gesture.viewport, gesture.pointer, zoomFromGestureScale(gesture.viewport.zoom, event.scale));
      options.setViewport({ x: next.x + pointer.x - gesture.pointer.x, y: next.y + pointer.y - gesture.pointer.y, zoom: next.zoom });
    },
    gestureEnd(event: Event) {
      if (gesture) consume(event);
      gesture = null;
    },
    reset() {
      gesture = null;
    },
  };
}
