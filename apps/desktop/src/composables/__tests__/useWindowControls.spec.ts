import { describe, expect, it } from "vitest";
import { shouldReserveMacTrafficLightInset, shouldShowWindowControls } from "@/composables/useWindowControls";

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

  it("reserves traffic light inset only for non-fullscreen macOS desktop windows", () => {
    expect(shouldReserveMacTrafficLightInset(true, false, true)).toBe(true);
    expect(shouldReserveMacTrafficLightInset(true, true, true)).toBe(false);
    expect(shouldReserveMacTrafficLightInset(false, false, true)).toBe(false);
    expect(shouldReserveMacTrafficLightInset(true, false, false)).toBe(false);
  });
});
