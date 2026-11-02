// @vitest-environment happy-dom

import { createApp, h, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorLayout } from "../useQueryEditorLayout";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";
import { uiTuning } from "@/lib/app/uiTuning";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  endPanelResize();
  vi.restoreAllMocks();
});

function mountLayout(width = 800, height = 600) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
  const host = document.createElement("div");
  Object.defineProperties(host, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
  document.body.append(host);
  const root = ref<HTMLDivElement>();
  const app = createApp({
    setup() {
      useQueryEditorLayout(root);
      return () => h("div", { ref: root });
    },
  });
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      app.unmount();
      host.remove();
      mounted = false;
    }
  };
  cleanups.push(unmount);
  const step = () => {
    const [frame, callback] = frames.entries().next().value!;
    frames.delete(frame);
    callback(0);
  };
  return {
    root: root.value!,
    frames,
    request,
    cancel,
    step,
    unmount,
    resize: (nextWidth: number) => {
      width = nextWidth;
    },
  };
}

describe("QueryEditor resize layout extraction", () => {
  it("pins synchronously, throttles frame updates and releases on pointer-up", () => {
    const { root, frames, step, resize } = mountLayout();
    beginPanelResize();
    expect(root.style.width).toBe("800px");
    expect(root.style.height).toBe("600px");
    resize(900);
    for (let frame = 1; frame < uiTuning.value.panelResizeTrackEveryFrames; frame++) step();
    expect(root.style.width).toBe("800px");
    step();
    expect(root.style.width).toBe("900px");
    endPanelResize();
    expect(root.style.width).toBe("");
    expect(root.style.height).toBe("");
    expect(root.style.maxWidth).toBe("");
    expect(root.style.minHeight).toBe("");
    expect(frames.size).toBe(0);
  });

  it("does not schedule frames for an invisible editor", () => {
    const { root, request } = mountLayout(0, 0);
    beginPanelResize();
    expect(request).not.toHaveBeenCalled();
    expect(root.style.width).toBe("");
  });

  it("cancels the active frame and watcher when unmounted mid-drag", () => {
    const { unmount, frames, cancel, request } = mountLayout();
    beginPanelResize();
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    endPanelResize();
    beginPanelResize();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
