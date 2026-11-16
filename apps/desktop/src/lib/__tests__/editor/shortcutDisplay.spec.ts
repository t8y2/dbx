import { describe, expect, it } from "vitest";
import { formatShortcutDisplay, formatShortcutTooltip, normalizeShortcutSearch, shortcutDisplayKeys } from "@/lib/editor/shortcutDisplay";

describe("shortcut display", () => {
  it("shows the default mouse modifier as Option on macOS and Alt elsewhere", () => {
    expect(formatShortcutDisplay("Alt", "MacIntel")).toBe("⌥");
    expect(formatShortcutDisplay("Alt", "Win32")).toBe("Alt");
  });

  it("uses readable modifier labels on Windows", () => {
    expect(shortcutDisplayKeys("Shift+Alt+U", "Win32")).toEqual(["Shift", "Alt", "U"]);
  });

  it("uses readable modifier labels on Linux", () => {
    expect(shortcutDisplayKeys("Ctrl+Alt+Delete", "Linux x86_64")).toEqual(["Ctrl", "Alt", "Del"]);
  });

  it("uses Apple platform glyphs on macOS", () => {
    expect(shortcutDisplayKeys("Mod+Alt+Enter", "MacIntel")).toEqual(["⌘", "⌥", "↵"]);
  });

  it("formats the close other tabs shortcut by platform", () => {
    expect(formatShortcutDisplay("Alt+Mod+W", "MacIntel")).toBe("⌥ ⌘ W");
    expect(formatShortcutDisplay("Shift+Alt+W", "Win32")).toBe("Shift + Alt + W");
  });

  it("formats the close tab shortcut by platform", () => {
    expect(formatShortcutDisplay("Mod+W", "MacIntel")).toBe("⌘ W");
    expect(formatShortcutDisplay("Mod+W", "Win32")).toBe("Ctrl + W");
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

  it("formats button tooltips with shortcut hints", () => {
    expect(formatShortcutTooltip("Execute", "Mod+Enter", "Win32")).toBe("Execute (Ctrl + ↵)");
    expect(formatShortcutTooltip("Execute", "Mod+Enter", "MacIntel")).toBe("Execute (⌘ ↵)");
    expect(formatShortcutTooltip("Format SQL", "Shift+Mod+F", "Win32")).toBe("Format SQL (Ctrl + Shift + F)");
    expect(formatShortcutTooltip("New Query", "")).toBe("New Query");
    expect(formatShortcutTooltip("New Query", undefined)).toBe("New Query");
    expect(formatShortcutTooltip("New Query", "   ")).toBe("New Query");
  });
});

// #11632: the shortcut search must not care how the user spaces the separators.
describe("shortcut search normalization", () => {
  it("folds separator spaces and case on the Windows pill form", () => {
    const displayed = formatShortcutDisplay("Mod+T", "Win32");
    expect(displayed).toBe("Ctrl + T");
    expect(normalizeShortcutSearch("Ctrl+T")).toBe(normalizeShortcutSearch(displayed));
    expect(normalizeShortcutSearch("ctrl+t")).toBe(normalizeShortcutSearch(displayed));
    expect(normalizeShortcutSearch("  CTRL  +  T  ")).toBe(normalizeShortcutSearch(displayed));
  });

  it("folds the space-separated macOS pill form, which has no + at all", () => {
    const displayed = formatShortcutDisplay("Mod+T", "MacIntel");
    expect(displayed).toBe("⌘ T");
    expect(normalizeShortcutSearch("⌘T")).toBe(normalizeShortcutSearch(displayed));
    expect(normalizeShortcutSearch("⌘ T")).toBe(normalizeShortcutSearch(displayed));
  });

  it("normalizes the full-width plus and spaces a CJK IME produces", () => {
    expect(normalizeShortcutSearch("Ctrl＋T")).toBe("ctrl+t");
    expect(normalizeShortcutSearch("Ctrl　+　T")).toBe("ctrl+t");
  });

  it("keeps the plus key distinguishable from its separators", () => {
    expect(normalizeShortcutSearch(formatShortcutDisplay("Mod+Plus", "Win32"))).toBe("ctrl++");
    expect(normalizeShortcutSearch("Ctrl++")).toBe("ctrl++");
  });

  it("keeps words separated, which is why it must stay off the label fields", () => {
    // The call-site guard lives in the component spec ("…however the user spaces
    // or cases the separators"), where a two-word label must still match.
    expect(normalizeShortcutSearch("New Query")).toBe("newquery");
  });

  it("folds full-width letters, for CJK IME full-width mode", () => {
    expect(normalizeShortcutSearch("ｃｔｒｌ＋ｔ")).toBe("ctrl+t");
    expect(normalizeShortcutSearch("ＣＴＲＬ＋Ｔ")).toBe("ctrl+t");
  });
});
