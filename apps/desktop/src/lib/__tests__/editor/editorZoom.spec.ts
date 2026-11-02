import { describe, expect, it } from "vitest";
import { clampEditorFontSize, createEditorWheelZoomController, createEditorWheelZoomGestureGuard, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";

function wheelEvent(timeStamp: number, modifier = false) {
  return { timeStamp, metaKey: modifier, ctrlKey: false };
}

function pinchWheel(timeStamp: number, deltaY: number, modifier = true) {
  return { timeStamp, metaKey: false, ctrlKey: modifier, deltaX: 0, deltaY, deltaMode: 0 };
}

describe("createEditorWheelZoomGestureGuard", () => {
  it("ignores a modifier pressed during an existing scroll gesture", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    expect(guard.accepts(wheelEvent(140, true))).toBe(false);
    expect(guard.accepts(wheelEvent(200, true))).toBe(false);
  });

  it("accepts a wheel gesture that starts with a modifier", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100, true))).toBe(true);
    expect(guard.accepts(wheelEvent(140, true))).toBe(true);
  });

  it("starts a new zoom gesture after the wheel stream becomes idle", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    expect(guard.accepts(wheelEvent(281, true))).toBe(true);
  });

  it("starts a new gesture when browser timestamps reset", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(500))).toBe(false);
    expect(guard.accepts(wheelEvent(10, true))).toBe(true);
  });

  it("can be reset between editor sessions", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    guard.reset();
    expect(guard.accepts(wheelEvent(120, true))).toBe(true);
  });

  it("accepts a pinch that follows a short non-modified prefix", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(pinchWheel(100, -1.25, false))).toBe(false);
    expect(guard.accepts(pinchWheel(140, -1.5, true))).toBe(true);
    expect(guard.accepts(pinchWheel(156, -1.25, true))).toBe(true);
  });

  it("does not treat ctrl during an established scroll as a pinch", () => {
    const guard = createEditorWheelZoomGestureGuard();

    for (let index = 0; index < 6; index += 1) {
      expect(guard.accepts(pinchWheel(100 + index * 16, -20.5, false))).toBe(false);
    }
    expect(guard.accepts(pinchWheel(196, -1.25, true))).toBe(false);
  });

  it("does not promote an integer wheel delta that appears during a short scroll", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts({ timeStamp: 0, ctrlKey: false, metaKey: false, deltaX: 0, deltaY: -4, deltaMode: 0 })).toBe(false);
    expect(guard.accepts({ timeStamp: 20, ctrlKey: true, metaKey: false, deltaX: 0, deltaY: -4, deltaMode: 0 })).toBe(false);
  });
});

describe("createEditorWheelZoomController", () => {
  it("limits a mouse notch to a five percent scale change", () => {
    const zoom = createEditorWheelZoomController();
    const event = { timeStamp: 10, ctrlKey: true, metaKey: false, deltaX: 0, deltaY: 120, deltaMode: 0 };

    expect(zoom.nextFontSize(16, event)).toBe(15.24);
  });

  it.each([
    [-100, 0],
    [-120, 0],
    [-1000, 0],
    [-3, 1],
    [-1, 2],
  ])("bounds wheel delta %s in mode %s to the same percentage step", (deltaY, deltaMode) => {
    const zoom = createEditorWheelZoomController();
    expect(zoom.nextFontSize(16, { ...pinchWheel(10, deltaY), deltaMode })).toBe(16.8);
  });

  it.each(["ctrlKey", "metaKey"] as const)("does not mistake a physical %s with fractional wheel delta for a pinch", (modifier) => {
    const zoom = createEditorWheelZoomController();
    zoom.recordModifiers({ ctrlKey: modifier === "ctrlKey", metaKey: modifier === "metaKey" });
    expect(zoom.nextFontSize(16, { ...pinchWheel(10, -100.5), ctrlKey: modifier === "ctrlKey", metaKey: modifier === "metaKey" })).toBe(16.8);
  });

  it("does not promote a fractional plain scroll when Control is pressed mid-gesture", () => {
    const zoom = createEditorWheelZoomController();
    expect(zoom.nextFontSize(16, pinchWheel(10, -10.5, false))).toBeNull();
    zoom.recordModifiers({ ctrlKey: true, metaKey: false });
    expect(zoom.nextFontSize(16, pinchWheel(30, -10.5))).toBeNull();
    expect(zoom.nextFontSize(16, pinchWheel(211, -100.5))).toBe(16.8);
  });

  it("restores pinch scaling after the physical modifier is released or the window loses focus", () => {
    const zoom = createEditorWheelZoomController();
    zoom.recordModifiers({ ctrlKey: true, metaKey: false });
    zoom.recordModifiers({ ctrlKey: false, metaKey: false });
    expect(zoom.nextFontSize(11, pinchWheel(1, -100 * Math.log(2)))).toBe(22);
    zoom.recordModifiers({ ctrlKey: true, metaKey: false });
    zoom.reset();
    expect(zoom.nextFontSize(11, pinchWheel(2, -100 * Math.log(2)))).toBe(22);
  });

  it("reverses wheel steps without rounding drift and preserves the font limits", () => {
    const zoom = createEditorWheelZoomController();
    expect(zoom.nextFontSize(16, pinchWheel(10, -120))).toBe(16.8);
    expect(zoom.nextFontSize(16.8, pinchWheel(20, 120))).toBe(16);
    zoom.rebase();
    expect(zoom.nextFontSize(24, pinchWheel(30, -120))).toBe(24);
    zoom.rebase();
    expect(zoom.nextFontSize(10, pinchWheel(40, 120))).toBe(10);
  });

  it("maps a trackpad pinch through Chromium's exp(-deltaY / 100) scale", () => {
    const zoom = createEditorWheelZoomController();
    const deltaY = -100 * Math.log(2);

    expect(zoom.nextFontSize(11, pinchWheel(1, deltaY))).toBe(clampEditorFontSize(22));
  });

  it("accumulates pinch frames that are smaller than the displayed precision", () => {
    const zoom = createEditorWheelZoomController();
    let size = 14;

    for (let index = 0; index < 40; index += 1) {
      const next = zoom.nextFontSize(size, pinchWheel(index * 10, -0.02));
      expect(next).not.toBeNull();
      size = next ?? size;
    }

    expect(size).toBe(clampEditorFontSize(14 * Math.exp(0.8 / 100)));
  });

  it("holds trailing wheel inertia after a native pinch gesture ends", () => {
    const zoom = createEditorWheelZoomController();

    expect(zoom.nextFontSize(14, pinchWheel(100, -1.5))).toBeGreaterThan(14);
    zoom.holdScrollGesture(200);
    expect(zoom.nextFontSize(14, pinchWheel(250, -1.5))).toBeNull();
    expect(zoom.nextFontSize(14, pinchWheel(431, -1.5))).toBeGreaterThan(14);
  });
});

describe("fontSizeFromWheelDelta", () => {
  it("keeps small pixel movements gradual and ignores zero vertical delta", () => {
    expect(fontSizeFromWheelDelta(16, 0)).toBe(16);
    expect(fontSizeFromWheelDelta(16, -10)).toBeGreaterThan(16);
    expect(fontSizeFromWheelDelta(16, -10)).toBeLessThan(16.1);
  });
});
