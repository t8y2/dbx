import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridCanvasRuntime, type DataGridAnimationFrameDriver } from "@/composables/useDataGridCanvasRuntime";
import { useDataGridScrollbars } from "@/composables/useDataGridScrollbars";

function createFrameDriver() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const driver: DataGridAnimationFrameDriver = {
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
  };
  return { driver, callbacks, run: (id: number) => callbacks.get(id)?.(0) };
}

function createObserver() {
  const observe = vi.fn();
  const disconnect = vi.fn();
  return { observer: { observe, disconnect } as unknown as ResizeObserver, observe, disconnect };
}

describe("data grid visual runtimes", () => {
  it("coalesces canvas frames and cancels all resources on dispose", () => {
    const frames = createFrameDriver();
    const resize = createObserver();
    const draw = vi.fn();
    const viewport = { children: [] } as unknown as Element;
    const runtime = useDataGridCanvasRuntime({
      draw,
      syncViewport: vi.fn(),
      getViewport: () => viewport,
      refreshPixelRatio: vi.fn(),
      frameDriver: frames.driver,
      createResizeObserver: () => resize.observer,
    });

    runtime.observeViewport();
    runtime.scheduleDraw();
    runtime.scheduleDraw();
    runtime.schedulePixelRatioRefresh();
    expect(frames.callbacks.size).toBe(2);

    runtime.dispose();
    expect(frames.callbacks.size).toBe(0);
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(draw).not.toHaveBeenCalled();
  });

  it("keeps a large scroll burst within one scheduled draw frame", () => {
    const frames = createFrameDriver();
    const draw = vi.fn();
    const runtime = useDataGridCanvasRuntime({
      draw,
      syncViewport: vi.fn(),
      getViewport: () => ({ children: [] }) as unknown as Element,
      frameDriver: frames.driver,
    });

    for (let index = 0; index < 10_000; index++) runtime.scheduleDraw();

    expect(frames.callbacks.size).toBe(1);
    const frameId = [...frames.callbacks.keys()][0];
    frames.run(frameId);
    expect(draw).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("keeps the latest drag coordinate and disconnects observed scroll content", () => {
    const frames = createFrameDriver();
    const resize = createObserver();
    const horizontalDrag = vi.fn();
    const child = { children: [] } as unknown as Element;
    const scroller = { children: [child] } as unknown as Element;
    const runtime = useDataGridScrollbars({
      update: vi.fn(),
      getScroller: () => scroller,
      applyHorizontalDrag: horizontalDrag,
      applyVerticalDrag: vi.fn(),
      frameDriver: frames.driver,
      createResizeObserver: () => resize.observer,
    });

    runtime.observeScroller();
    runtime.scheduleHorizontalDrag(10);
    runtime.scheduleHorizontalDrag(25);
    runtime.flushHorizontalDrag();

    expect(horizontalDrag).toHaveBeenCalledWith(25);
    expect(resize.observe).toHaveBeenCalledTimes(2);
    runtime.dispose();
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(frames.callbacks.size).toBe(0);
  });

  it("tears down pending canvas work when its Vue scope stops", () => {
    const frames = createFrameDriver();
    const resize = createObserver();
    const draw = vi.fn();
    const syncViewport = vi.fn();
    const scope = effectScope();
    const runtime = scope.run(() =>
      useDataGridCanvasRuntime({
        draw,
        syncViewport,
        getViewport: () => ({ children: [] }) as unknown as Element,
        frameDriver: frames.driver,
        createResizeObserver: () => resize.observer,
      }),
    )!;

    runtime.observeViewport();
    runtime.scheduleDraw();
    const lateDraw = [...frames.callbacks.values()][0];
    scope.stop();

    expect(runtime.disposed).toBe(true);
    expect(runtime.active).toBe(false);
    expect(frames.callbacks.size).toBe(0);
    expect(resize.disconnect).toHaveBeenCalledOnce();
    lateDraw(0);
    expect(draw).not.toHaveBeenCalled();
    expect(syncViewport).toHaveBeenCalledOnce();
  });

  it("does not revive scroll work after disposal", () => {
    const frames = createFrameDriver();
    const resize = createObserver();
    const update = vi.fn();
    const verticalDrag = vi.fn();
    const runtime = useDataGridScrollbars({
      update,
      getScroller: () => ({ children: [] }) as unknown as Element,
      applyHorizontalDrag: vi.fn(),
      applyVerticalDrag: verticalDrag,
      frameDriver: frames.driver,
      createResizeObserver: () => resize.observer,
    });

    runtime.observeScroller();
    runtime.scheduleVerticalDrag(42);
    const lateCallbacks = [...frames.callbacks.values()];
    runtime.dispose();
    runtime.resume();
    runtime.scheduleUpdate();
    runtime.flushVerticalDrag();
    lateCallbacks.forEach((callback) => callback(0));

    expect(runtime.disposed).toBe(true);
    expect(runtime.active).toBe(false);
    expect(frames.callbacks.size).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(verticalDrag).not.toHaveBeenCalled();
  });
});
