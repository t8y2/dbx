// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createModifierDoubleTapShortcutController, isModifierDoubleTapShortcut, matchesModifierDoubleTapShortcut } from "@/lib/editor/modifierDoubleTapShortcut";

function keyEvent(type: "keydown" | "keyup", init: KeyboardEventInit, at: number): KeyboardEvent {
  const event = new KeyboardEvent(type, init);
  Object.defineProperty(event, "timeStamp", { value: at });
  return event;
}

const shiftDown = (at: number, init: KeyboardEventInit = {}) => keyEvent("keydown", { key: "Shift", code: "ShiftLeft", ...init }, at);
const shiftUp = (at: number, init: KeyboardEventInit = {}) => keyEvent("keyup", { key: "Shift", code: "ShiftLeft", ...init }, at);
const altDown = (at: number, init: KeyboardEventInit = {}) => keyEvent("keydown", { key: "Alt", code: "AltLeft", ...init }, at);
const altUp = (at: number, init: KeyboardEventInit = {}) => keyEvent("keyup", { key: "Alt", code: "AltLeft", ...init }, at);

describe("isModifierDoubleTapShortcut", () => {
  it("accepts two identical taps of a known modifier", () => {
    for (const modifier of ["Shift", "Alt", "Ctrl", "Meta", "Mod"]) {
      expect(isModifierDoubleTapShortcut(`${modifier} ${modifier}`)).toBe(true);
    }
  });

  it("rejects non-double-tap shapes", () => {
    expect(isModifierDoubleTapShortcut("Shift")).toBe(false);
    expect(isModifierDoubleTapShortcut("Shift Shift Shift")).toBe(false);
    expect(isModifierDoubleTapShortcut("Shift Alt")).toBe(false);
    expect(isModifierDoubleTapShortcut("Mod+P")).toBe(false);
    expect(isModifierDoubleTapShortcut("")).toBe(false);
  });
});

describe("matchesModifierDoubleTapShortcut", () => {
  it("matches identical modifiers regardless of platform", () => {
    expect(matchesModifierDoubleTapShortcut("Shift Shift", "Shift Shift", "Win32")).toBe(true);
    expect(matchesModifierDoubleTapShortcut("Shift Shift", "Alt Alt", "Win32")).toBe(false);
  });

  it("resolves Mod to Meta on macOS and Ctrl elsewhere", () => {
    expect(matchesModifierDoubleTapShortcut("Mod Mod", "Meta Meta", "MacIntel")).toBe(true);
    expect(matchesModifierDoubleTapShortcut("Mod Mod", "Ctrl Ctrl", "MacIntel")).toBe(false);
    expect(matchesModifierDoubleTapShortcut("Mod Mod", "Ctrl Ctrl", "Win32")).toBe(true);
    expect(matchesModifierDoubleTapShortcut("Mod Mod", "Meta Meta", "Win32")).toBe(false);
  });

  it("never matches a double tap against a chord shortcut", () => {
    expect(matchesModifierDoubleTapShortcut("Mod Mod", "Mod+P", "Win32")).toBe(false);
    expect(matchesModifierDoubleTapShortcut("Alt Alt", "Mod+Alt+F", "MacIntel")).toBe(false);
  });
});

describe("createModifierDoubleTapShortcutController", () => {
  it("completes a double tap within the interval and reports the matched shortcut", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    expect(controller.handleKeydown(shiftDown(100))).toBeUndefined();
    expect(controller.handleKeyup(shiftUp(150))).toBeNull();
    expect(controller.handleKeydown(shiftDown(300))).toBeUndefined();
    expect(controller.handleKeyup(shiftUp(350))).toBe("Shift Shift");
  });

  it("re-anchors when the second tap starts outside the interval", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.handleKeydown(shiftDown(500));
    expect(controller.handleKeyup(shiftUp(550))).toBeNull();
    controller.handleKeydown(shiftDown(700));
    expect(controller.handleKeyup(shiftUp(750))).toBe("Shift Shift");
  });

  it("cancels the pending first tap when a chord key intervenes", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.handleKeydown(keyEvent("keydown", { key: "a", code: "KeyA", shiftKey: true }, 100));
    expect(controller.handleKeyup(keyEvent("keyup", { key: "a", code: "KeyA", shiftKey: true }, 150))).toBeNull();
    controller.handleKeydown(shiftDown(200));
    expect(controller.handleKeyup(shiftUp(250))).toBeNull();
    controller.handleKeydown(shiftDown(400));
    expect(controller.handleKeyup(shiftUp(450))).toBe("Shift Shift");
  });

  it("ignores auto-repeat keydowns", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0, { repeat: true }));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.handleKeydown(shiftDown(100));
    expect(controller.handleKeyup(shiftUp(150))).toBeNull();
    controller.handleKeydown(shiftDown(300));
    expect(controller.handleKeyup(shiftUp(350))).toBe("Shift Shift");
  });

  it("restarts the tap window when the second tap uses a different modifier", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.handleKeydown(altDown(100));
    expect(controller.handleKeyup(altUp(150))).toBeNull();
    controller.handleKeydown(altDown(300));
    expect(controller.handleKeyup(altUp(350))).toBe("Alt Alt");
  });

  it("rejects a keyup that still holds another modifier", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.handleKeydown(shiftDown(200));
    expect(controller.handleKeyup(shiftUp(250, { altKey: true }))).toBeNull();
  });

  it("purges keys whose keyup macOS swallowed during a Cmd chord and keeps recognizing taps", () => {
    const controller = createModifierDoubleTapShortcutController("MacIntel");
    controller.handleKeydown(keyEvent("keydown", { key: "Meta", code: "MetaLeft", metaKey: true }, 0));
    controller.handleKeydown(keyEvent("keydown", { key: "a", code: "KeyA", metaKey: true }, 50));
    expect(controller.handleKeyup(keyEvent("keyup", { key: "Meta", code: "MetaLeft" }, 100))).toBeNull();
    controller.handleKeydown(shiftDown(200));
    expect(controller.handleKeyup(shiftUp(250))).toBeNull();
    controller.handleKeydown(shiftDown(400));
    expect(controller.handleKeyup(shiftUp(450))).toBe("Shift Shift");
  });

  it("reset clears all pending tap and held-key state", () => {
    const controller = createModifierDoubleTapShortcutController("Win32");
    controller.handleKeydown(shiftDown(0));
    expect(controller.handleKeyup(shiftUp(50))).toBeNull();
    controller.reset();
    controller.handleKeydown(shiftDown(200));
    expect(controller.handleKeyup(shiftUp(250))).toBeNull();
    controller.handleKeydown(shiftDown(400));
    expect(controller.handleKeyup(shiftUp(450))).toBe("Shift Shift");
  });
});
