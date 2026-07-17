import { describe, expect, it } from "vitest";
import { eventToModifierOnlyShortcut, eventToShortcut, matchesModifierOnlyShortcut, matchesShortcut } from "@/lib/editor/keyboardShortcuts";

describe("keyboard shortcut matching", () => {
  it("records modifier-only mouse shortcut settings", () => {
    expect(eventToModifierOnlyShortcut({ key: "Alt", altKey: true })).toBe("Alt");
    expect(eventToModifierOnlyShortcut({ key: "Shift", shiftKey: true })).toBe("Shift");
    expect(eventToModifierOnlyShortcut({ key: "Control", ctrlKey: true }, "Win32")).toBe("Mod");
    expect(eventToModifierOnlyShortcut({ key: "Meta", metaKey: true }, "Win32")).toBe("Meta");
    expect(eventToModifierOnlyShortcut({ key: "Meta", metaKey: true }, "MacIntel")).toBe("Mod");
    expect(eventToModifierOnlyShortcut({ key: "Control", ctrlKey: true }, "MacIntel")).toBe("Ctrl");
    expect(eventToModifierOnlyShortcut({ key: "A", altKey: true })).toBeNull();
  });

  it("matches a configured mouse modifier exactly", () => {
    expect(matchesModifierOnlyShortcut({ altKey: true }, "Alt")).toBe(true);
    expect(matchesModifierOnlyShortcut({ ctrlKey: true }, "Mod")).toBe(true);
    expect(matchesModifierOnlyShortcut({ metaKey: true }, "Mod")).toBe(true);
    expect(matchesModifierOnlyShortcut({ ctrlKey: true }, "Ctrl")).toBe(true);
    expect(matchesModifierOnlyShortcut({ metaKey: true }, "Meta")).toBe(true);
    expect(matchesModifierOnlyShortcut({ altKey: true, shiftKey: true }, "Alt")).toBe(false);
    expect(matchesModifierOnlyShortcut({ shiftKey: true }, "")).toBe(false);
  });

  it("records the plus key without losing it to the separator", () => {
    expect(eventToShortcut({ key: "+", ctrlKey: true })).toBe("Mod+Plus");
    expect(eventToShortcut({ key: "+", ctrlKey: true, shiftKey: true })).toBe("Shift+Mod+Plus");
  });

  it("matches canonical plus-key shortcuts", () => {
    expect(matchesShortcut({ key: "+", ctrlKey: true }, "Mod+Plus")).toBe(true);
    expect(matchesShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Shift+Mod+Plus")).toBe(true);
  });

  it("matches legacy plus-key shortcuts saved with plus as a separator", () => {
    expect(matchesShortcut({ key: "+", ctrlKey: true }, "Mod++")).toBe(true);
    expect(matchesShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Shift+Mod++")).toBe(true);
  });
});
