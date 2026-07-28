import { describe, expect, it } from "vitest";
import { macTrafficLightInsetPaddingForScale, macTrafficLightPositionForScale, shouldDrawDesktopWindowFrame, shouldReserveMacTrafficLightInset, shouldShowWindowControls } from "@/composables/useWindowControls";

describe("window controls", () => {
  it("shows custom controls for non-macOS desktop windows", () => {
    expect(shouldShowWindowControls(false, true)).toBe(true);
  });

  it("keeps macOS on native traffic lights", () => {
    expect(shouldShowWindowControls(true, true)).toBe(false);
  });

  it("does not show desktop controls in web runtime", () => {
    expect(shouldShowWindowControls(false, false)).toBe(false);
  });

  it("draws an app frame only for self-decorated non-Windows desktop windows", () => {
    expect(shouldDrawDesktopWindowFrame(false, true, false)).toBe(true);
    expect(shouldDrawDesktopWindowFrame(false, true, true)).toBe(false);
    expect(shouldDrawDesktopWindowFrame(true, true, false)).toBe(false);
    expect(shouldDrawDesktopWindowFrame(false, false, false)).toBe(false);
  });

  it("reserves traffic light inset only for non-fullscreen macOS desktop windows", () => {
    expect(shouldReserveMacTrafficLightInset(true, false, true)).toBe(true);
    expect(shouldReserveMacTrafficLightInset(true, true, true)).toBe(false);
    expect(shouldReserveMacTrafficLightInset(false, false, true)).toBe(false);
    expect(shouldReserveMacTrafficLightInset(true, false, false)).toBe(false);
  });

  it("keeps the macOS traffic light reserve visually stable across UI scales", () => {
    expect(macTrafficLightInsetPaddingForScale(1)).toBe("70px");
    expect(macTrafficLightInsetPaddingForScale(0.9)).toBe("78px");
    expect(macTrafficLightInsetPaddingForScale(1.25)).toBe("56px");
  });

  it("adjusts macOS traffic lights vertically with the UI scale", () => {
    expect(macTrafficLightPositionForScale(1)).toEqual({ x: 16, y: 18 });
    expect(macTrafficLightPositionForScale(0.9)).toEqual({ x: 16, y: 16 });
    expect(macTrafficLightPositionForScale(1.1)).toEqual({ x: 16, y: 20 });
    expect(macTrafficLightPositionForScale(1.25)).toEqual({ x: 16, y: 23 });
  });
});
