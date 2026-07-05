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
});
