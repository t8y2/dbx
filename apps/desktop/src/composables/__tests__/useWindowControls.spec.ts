import { describe, expect, it } from "vitest";
import { appShellMinSizeStyleForScale, macTrafficLightInsetPaddingForScale, macTrafficLightPositionForScale, shouldDrawDesktopWindowFrame, shouldDrawLinuxFloatingFrame, shouldReserveMacTrafficLightInset, shouldShowWindowControls } from "@/composables/useWindowControls";

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

  it.each([
    ["restored Linux main window with a compositor", {}, true],
    ["maximized window", { isMaximized: true }, false],
    ["fullscreen window", { isFullscreen: true }, false],
    ["non-Linux platform", { isLinux: false }, false],
    ["web runtime", { isDesktop: false }, false],
    ["detached or plugin window (not created transparent)", { isMainWindow: false }, false],
    ["no compositing manager", { compositing: false }, false],
    ["login or setup page", { showingAuthPage: true }, false],
  ])("floating Linux frame: %s", (_name, override, expected) => {
    const base = { isLinux: true, isDesktop: true, isMainWindow: true, compositing: true, showingAuthPage: false, isMaximized: false, isFullscreen: false };
    expect(shouldDrawLinuxFloatingFrame({ ...base, ...override })).toBe(expected);
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

  // 回归（界面缩放 ≥165% 时设置页脚按钮被挤出窗口）：webview 缩放重排后 CSS
  // 视口随倍率缩小，760x600 的下限必须以视觉像素为基准除以倍率换算；100%
  // 缩放时必须与原固定下限完全一致，才能保住 prevent scaled window clipping
  // 的保护。非法倍率回退按 100% 处理。
  it.each([
    [1, { minWidth: "760px", minHeight: "600px" }],
    [0.75, { minWidth: "1014px", minHeight: "800px" }],
    [1.5, { minWidth: "507px", minHeight: "400px" }],
    [1.75, { minWidth: "435px", minHeight: "343px" }],
    [2, { minWidth: "380px", minHeight: "300px" }],
  ])("keeps the app shell floor in visual pixels at UI scale %s", (scale, expected) => {
    expect(appShellMinSizeStyleForScale(scale)).toEqual(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("falls back to the 100%% floor for invalid UI scale %s", (scale) => {
    expect(appShellMinSizeStyleForScale(scale)).toEqual({ minWidth: "760px", minHeight: "600px" });
  });
});
