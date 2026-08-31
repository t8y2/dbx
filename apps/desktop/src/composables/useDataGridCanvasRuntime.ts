import { getCurrentScope, onScopeDispose } from "vue";
import type { CanvasDevicePixelSize } from "@/lib/dataGrid/canvasDataGridRenderer";

export interface DataGridAnimationFrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(frameId: number): void;
}

export interface DataGridCanvasRuntimeOptions {
  draw(): void;
  syncViewport(entries?: readonly ResizeObserverEntry[]): void;
  getViewport(): Element | null;
  getSurface?: () => Element | null;
  refreshPixelRatio?: () => void;
  frameDriver?: DataGridAnimationFrameDriver;
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver | null;
  startPaused?: boolean;
}

export interface DataGridCanvasRuntime {
  readonly active: boolean;
  readonly disposed: boolean;
  scheduleDraw(): void;
  drawNow(): void;
  schedulePixelRatioRefresh(): void;
  observeViewport(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

export function dataGridCanvasDevicePixelSize(entry: ResizeObserverEntry): CanvasDevicePixelSize | null {
  const boxes = entry.devicePixelContentBoxSize;
  const box = Array.isArray(boxes) ? boxes[0] : (boxes as unknown as ResizeObserverSize | undefined);
  if (!box || !Number.isFinite(box.inlineSize) || !Number.isFinite(box.blockSize) || box.inlineSize <= 0 || box.blockSize <= 0) return null;
  return {
    cssWidth: entry.contentRect.width,
    cssHeight: entry.contentRect.height,
    pixelWidth: Math.round(box.inlineSize),
    pixelHeight: Math.round(box.blockSize),
  };
}

function defaultFrameDriver(): DataGridAnimationFrameDriver {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (frameId) => cancelAnimationFrame(frameId),
  };
}

function defaultResizeObserverFactory(callback: ResizeObserverCallback): ResizeObserver | null {
  return typeof ResizeObserver === "undefined" ? null : new ResizeObserver(callback);
}

export function useDataGridCanvasRuntime(options: DataGridCanvasRuntimeOptions): DataGridCanvasRuntime {
  const frameDriver = options.frameDriver ?? defaultFrameDriver();
  const createResizeObserver = options.createResizeObserver ?? defaultResizeObserverFactory;
  let active = !options.startPaused;
  let disposed = false;
  let drawFrame: number | null = null;
  let pixelRatioFrame: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const cancelFrames = () => {
    if (drawFrame !== null) frameDriver.cancel(drawFrame);
    if (pixelRatioFrame !== null) frameDriver.cancel(pixelRatioFrame);
    drawFrame = null;
    pixelRatioFrame = null;
  };

  const runtime: DataGridCanvasRuntime = {
    get active() {
      return active;
    },
    get disposed() {
      return disposed;
    },
    scheduleDraw() {
      if (!active || disposed || drawFrame !== null) return;
      drawFrame = frameDriver.request(() => {
        drawFrame = null;
        if (active && !disposed) options.draw();
      });
    },
    drawNow() {
      if (!active || disposed) return;
      if (drawFrame !== null) frameDriver.cancel(drawFrame);
      drawFrame = null;
      options.draw();
    },
    schedulePixelRatioRefresh() {
      if (!active || disposed || pixelRatioFrame !== null || !options.refreshPixelRatio) return;
      pixelRatioFrame = frameDriver.request(() => {
        pixelRatioFrame = null;
        if (active && !disposed) options.refreshPixelRatio?.();
      });
    },
    observeViewport() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (!active || disposed) return;
      options.syncViewport();
      const viewport = options.getViewport();
      if (!viewport) return;
      resizeObserver = createResizeObserver((entries) => {
        if (active && !disposed) options.syncViewport(entries);
      });
      resizeObserver?.observe(viewport);
      const surface = options.getSurface?.();
      if (resizeObserver && surface && surface !== viewport) {
        try {
          resizeObserver.observe(surface, { box: "device-pixel-content-box" });
        } catch {
          resizeObserver.observe(surface);
        }
      }
    },
    pause() {
      active = false;
      resizeObserver?.disconnect();
      resizeObserver = null;
      cancelFrames();
    },
    resume() {
      if (disposed) return;
      active = true;
      runtime.observeViewport();
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
