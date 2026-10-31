// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createDiagramGestureHandlers } from "../diagram-gestures";

function fixture() {
  const pane = document.createElement("div");
  let viewport = { x: 0, y: 0, zoom: 0.5 };
  const setViewport = vi.fn((next: typeof viewport) => {
    viewport = next;
  });
  const handlers = createDiagramGestureHandlers({ getPane: () => pane, getViewport: () => viewport, setViewport });
  return { handlers, setViewport, getViewport: () => viewport };
}

function gesture(type: string, scale = 1) {
  const event = new MouseEvent(type, { cancelable: true, clientX: 200, clientY: 100 });
  Object.defineProperty(event, "scale", { value: scale });
  return event;
}

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const event = new MouseEvent("wheel", { cancelable: true, ctrlKey, clientX: 200, clientY: 100 });
  Object.defineProperties(event, { deltaY: { value: deltaY }, deltaMode: { value: 0 } });
  return event as WheelEvent;
}

describe("diagram pinch event handling", () => {
  it("accumulates small Chromium pinch events and anchors the cursor", () => {
    const { handlers, getViewport } = fixture();
    for (let i = 0; i < 100; i++) handlers.wheel(wheel(-0.1));
    expect(getViewport().zoom).toBeGreaterThan(0.5);
    expect((200 - getViewport().x) / getViewport().zoom).toBeCloseTo(400);
    for (let i = 0; i < 100; i++) handlers.wheel(wheel(0.1));
    expect(getViewport().zoom).toBeCloseTo(0.5, 12);
  });

  it("handles cumulative native pinch scale without applying duplicate wheel events", () => {
    const { handlers, getViewport, setViewport } = fixture();
    const start = gesture("gesturestart");
    handlers.gestureStart(start);
    expect(start.defaultPrevented).toBe(true);
    handlers.gestureChange(gesture("gesturechange", 1.5));
    expect(getViewport().zoom).toBe(0.75);
    const duplicate = wheel(-100);
    handlers.wheel(duplicate);
    expect(duplicate.defaultPrevented).toBe(true);
    expect(setViewport).toHaveBeenCalledTimes(1);
    handlers.gestureChange(gesture("gesturechange", 2));
    expect(getViewport().zoom).toBe(1);
    handlers.gestureChange(gesture("gesturechange", 0.5));
    expect(getViewport().zoom).toBe(0.25);
    const end = gesture("gestureend");
    handlers.gestureEnd(end);
    expect(end.defaultPrevented).toBe(true);
    handlers.wheel(wheel(-100));
    expect(getViewport().zoom).toBeGreaterThan(0.25);
  });

  it("leaves scrolling alone and clears native pinch state when the pane changes", () => {
    const { handlers, setViewport } = fixture();
    const plain = wheel(50, false);
    handlers.wheel(plain);
    expect(plain.defaultPrevented).toBe(false);
    handlers.gestureStart(gesture("gesturestart"));
    for (const scale of [NaN, Infinity, 0, -1]) handlers.gestureChange(gesture("gesturechange", scale));
    expect(setViewport).not.toHaveBeenCalled();
    handlers.reset();
    handlers.gestureChange(gesture("gesturechange", 2));
    expect(setViewport).not.toHaveBeenCalled();
    handlers.wheel(wheel(-1));
    expect(setViewport).toHaveBeenCalledOnce();
  });
});
