import { describe, expect, it } from "vitest";
import { eventToModifierOnlyShortcut, eventToShortcut, isExecuteSqlInNewResultTabShortcut, matchesModifierOnlyShortcut, matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { formatShortcutDisplay, isMacShortcutPlatform } from "@/lib/editor/shortcutDisplay";

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
    expect(eventToShortcut({ key: "+", ctrlKey: true }, "Win32")).toBe("Mod+Plus");
    expect(eventToShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Win32")).toBe("Shift+Mod+Plus");
  });

  it("keeps Control distinct from Command when recording macOS shortcuts", () => {
    const controlShortcut = eventToShortcut({ key: "b", ctrlKey: true }, "MacIntel");

    expect(controlShortcut).toBe("Ctrl+B");
    expect(formatShortcutDisplay(controlShortcut!, "MacIntel")).toBe("⌃ B");
    expect(matchesShortcut({ key: "b", ctrlKey: true }, controlShortcut!, "MacIntel")).toBe(true);
    expect(matchesShortcut({ key: "b", metaKey: true }, controlShortcut!, "MacIntel")).toBe(false);
    expect(eventToShortcut({ key: "b", metaKey: true }, "MacIntel")).toBe("Mod+B");
    expect(matchesShortcut({ key: "b", metaKey: true }, "Mod+B", "MacIntel")).toBe(true);
    expect(matchesShortcut({ key: "b", ctrlKey: true }, "Mod+B", "MacIntel")).toBe(false);
    expect(matchesShortcut({ key: "b", ctrlKey: true, metaKey: true }, "Mod+B", "MacIntel")).toBe(false);
  });

  it("preserves non-macOS Mod recording compatibility", () => {
    expect(eventToShortcut({ key: "b", ctrlKey: true }, "Win32")).toBe("Mod+B");
    expect(eventToShortcut({ key: "b", metaKey: true }, "Win32")).toBe("Mod+B");
    expect(matchesShortcut({ key: "b", ctrlKey: true }, "Mod+B", "Win32")).toBe(true);
    expect(matchesShortcut({ key: "b", metaKey: true }, "Mod+B", "Win32")).toBe(true);
  });

  it("preserves combined platform modifiers", () => {
    const combinedShortcut = eventToShortcut({ key: "b", ctrlKey: true, metaKey: true, shiftKey: true, altKey: true }, "MacIntel");

    expect(combinedShortcut).toBe("Shift+Ctrl+Mod+Alt+B");
    expect(matchesShortcut({ key: "b", ctrlKey: true, metaKey: true, shiftKey: true, altKey: true }, combinedShortcut!, "MacIntel")).toBe(true);
    expect(matchesShortcut({ key: "b", ctrlKey: true, shiftKey: true, altKey: true }, combinedShortcut!, "MacIntel")).toBe(false);
    expect(matchesShortcut({ key: "b", metaKey: true, shiftKey: true, altKey: true }, combinedShortcut!, "MacIntel")).toBe(false);

    const nonMacCombinedShortcut = eventToShortcut({ key: "b", ctrlKey: true, metaKey: true, shiftKey: true, altKey: true }, "Win32");
    expect(nonMacCombinedShortcut).toBe("Shift+Mod+Meta+Alt+B");
    expect(matchesShortcut({ key: "b", ctrlKey: true, metaKey: true, shiftKey: true, altKey: true }, nonMacCombinedShortcut!, "Win32")).toBe(true);
    expect(matchesShortcut({ key: "b", ctrlKey: true, shiftKey: true, altKey: true }, nonMacCombinedShortcut!, "Win32")).toBe(false);
    expect(matchesShortcut({ key: "b", metaKey: true, shiftKey: true, altKey: true }, nonMacCombinedShortcut!, "Win32")).toBe(false);
  });

  it("matches canonical plus-key shortcuts", () => {
    expect(matchesShortcut({ key: "+", ctrlKey: true }, "Mod+Plus", "Win32")).toBe(true);
    expect(matchesShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Shift+Mod+Plus", "Win32")).toBe(true);
  });

  it("matches the configurable execute-in-new-result-tab shortcut", () => {
    const isMac = isMacShortcutPlatform();
    const platformModEvent = isMac ? { key: "\\", metaKey: true } : { key: "\\", ctrlKey: true };

    expect(isExecuteSqlInNewResultTabShortcut(platformModEvent, { executeSqlInNewResultTab: "Mod+\\" })).toBe(true);
    expect(isExecuteSqlInNewResultTabShortcut({ ...platformModEvent, shiftKey: true }, { executeSqlInNewResultTab: "Mod+\\" })).toBe(false);
    expect(isExecuteSqlInNewResultTabShortcut({ key: "\\", ctrlKey: true }, { executeSqlInNewResultTab: "Mod+\\" })).toBe(!isMac);
    expect(isExecuteSqlInNewResultTabShortcut({ key: "\\", metaKey: true }, { executeSqlInNewResultTab: "Mod+\\" })).toBe(true);
  });

  it("matches legacy plus-key shortcuts saved with plus as a separator", () => {
    expect(matchesShortcut({ key: "+", ctrlKey: true }, "Mod++", "Win32")).toBe(true);
    expect(matchesShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Shift+Mod++", "Win32")).toBe(true);
  });
});
