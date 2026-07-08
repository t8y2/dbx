import { describe, expect, it } from "vitest";
import { formatShortcutDisplay, shortcutDisplayKeys } from "@/lib/editor/shortcutDisplay";

describe("shortcut display", () => {
  it("uses readable modifier labels on Windows", () => {
    expect(shortcutDisplayKeys("Shift+Alt+U", "Win32")).toEqual(["Shift", "Alt", "U"]);
  });

  it("uses readable modifier labels on Linux", () => {
    expect(shortcutDisplayKeys("Ctrl+Alt+Delete", "Linux x86_64")).toEqual(["Ctrl", "Alt", "Del"]);
  });

  it("uses Apple platform glyphs on macOS", () => {
    expect(shortcutDisplayKeys("Mod+Alt+Enter", "MacIntel")).toEqual(["⌘", "⌥", "↵"]);
  });

  it("formats shortcut pills with platform separators", () => {
    expect(formatShortcutDisplay("Shift+Alt+ArrowUp", "Win32")).toBe("Shift + Alt + ↑");
    expect(formatShortcutDisplay("Shift+Alt+ArrowUp", "MacIntel")).toBe("⇧ ⌥ ↑");
    expect(formatShortcutDisplay("Mod+Delete", "MacIntel")).toBe("⌘ ⌦");
  });

  it("orders Ctrl before Shift on Windows", () => {
    expect(formatShortcutDisplay("Shift+Mod+F", "Win32")).toBe("Ctrl + Shift + F");
    expect(formatShortcutDisplay("Shift+Mod+K", "Win32")).toBe("Ctrl + Shift + K");
    expect(formatShortcutDisplay("Shift+Mod+Z", "Win32")).toBe("Ctrl + Shift + Z");
  });

  it("keeps macOS modifier order and glyphs", () => {
    expect(formatShortcutDisplay("Shift+Mod+F", "MacIntel")).toBe("⇧ ⌘ F");
  });

  it("displays canonical and legacy plus-key shortcuts", () => {
    expect(formatShortcutDisplay("Mod+Plus", "Win32")).toBe("Ctrl + +");
    expect(formatShortcutDisplay("Shift+Mod++", "Win32")).toBe("Ctrl + Shift + +");
  });

  it("displays multi-stroke shortcuts", () => {
    expect(formatShortcutDisplay("Ctrl+K Ctrl+C", "Win32")).toBe("Ctrl + K, Ctrl + C");
  });
});
