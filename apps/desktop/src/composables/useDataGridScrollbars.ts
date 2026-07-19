import { getCurrentScope, onScopeDispose } from "vue";
import type { DataGridAnimationFrameDriver } from "./useDataGridCanvasRuntime";

export interface DataGridScrollbarsOptions {
  update(): void;
  getScroller(): Element | null;
  applyHorizontalDrag(clientX: number): void;
  applyVerticalDrag(clientY: number): void;
  frameDriver: DataGridAnimationFrameDriver;
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver | null;
  startPaused?: boolean;
}

export interface DataGridScrollbarsRuntime {
  readonly active: boolean;
  readonly disposed: boolean;
  scheduleUpdate(): void;
  scheduleHorizontalDrag(clientX: number): void;
  scheduleVerticalDrag(clientY: number): void;
  flushHorizontalDrag(): void;
  flushVerticalDrag(): void;
  observeScroller(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

function defaultResizeObserverFactory(callback: ResizeObserverCallback): ResizeObserver | null {
  return typeof ResizeObserver === "undefined" ? null : new ResizeObserver(callback);
}

export function useDataGridScrollbars(options: DataGridScrollbarsOptions): DataGridScrollbarsRuntime {
  const createResizeObserver = options.createResizeObserver ?? defaultResizeObserverFactory;
  let active = !options.startPaused;
  let disposed = false;
  let updateFrame: number | null = null;
  let horizontalFrame: number | null = null;
  let verticalFrame: number | null = null;
  let pendingClientX = 0;
  let pendingClientY = 0;
  let resizeObserver: ResizeObserver | null = null;

  const cancelFrame = (frame: number | null) => {
    if (frame !== null) options.frameDriver.cancel(frame);
  };
  const runtime: DataGridScrollbarsRuntime = {
    get active() {
      return active;
    },
    get disposed() {
      return disposed;
    },
    scheduleUpdate() {
      if (!active || disposed || updateFrame !== null) return;
      updateFrame = options.frameDriver.request(() => {
        updateFrame = null;
        if (active && !disposed) options.update();
      });
    },
    scheduleHorizontalDrag(clientX) {
      pendingClientX = clientX;
      if (!active || disposed || horizontalFrame !== null) return;
      horizontalFrame = options.frameDriver.request(() => {
        horizontalFrame = null;
        if (active && !disposed) options.applyHorizontalDrag(pendingClientX);
      });
    },
    scheduleVerticalDrag(clientY) {
      pendingClientY = clientY;
      if (!active || disposed || verticalFrame !== null) return;
      verticalFrame = options.frameDriver.request(() => {
        verticalFrame = null;
        if (active && !disposed) options.applyVerticalDrag(pendingClientY);
      });
    },
    flushHorizontalDrag() {
      if (!active || disposed || horizontalFrame === null) return;
      options.frameDriver.cancel(horizontalFrame);
      horizontalFrame = null;
      options.applyHorizontalDrag(pendingClientX);
    },
    flushVerticalDrag() {
      if (!active || disposed || verticalFrame === null) return;
      options.frameDriver.cancel(verticalFrame);
      verticalFrame = null;
      options.applyVerticalDrag(pendingClientY);
    },
    observeScroller() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (!active || disposed) return;
      const scroller = options.getScroller();
      if (scroller) {
        resizeObserver = createResizeObserver(runtime.scheduleUpdate);
        resizeObserver?.observe(scroller);
        // Child size changes can alter scrollWidth without resizing the scroller itself.
        for (const child of Array.from(scroller.children)) resizeObserver?.observe(child);
      }
      runtime.scheduleUpdate();
    },
    pause() {
      active = false;
      resizeObserver?.disconnect();
      resizeObserver = null;
      cancelFrame(updateFrame);
      cancelFrame(horizontalFrame);
      cancelFrame(verticalFrame);
      updateFrame = null;
      horizontalFrame = null;
      verticalFrame = null;
    },
    resume() {
      if (disposed) return;
      active = true;
      runtime.observeScroller();
    },
    dispose() {
      if (disposed) return;
      runtime.pause();
      disposed = true;
    },
  };

  if (getCurrentScope()) onScopeDispose(runtime.dispose);
  return runtime;
}
