import { describe, expect, it } from "vitest";
import { eventToShortcut, matchesShortcut } from "@/lib/editor/keyboardShortcuts";

describe("keyboard shortcut matching", () => {
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
