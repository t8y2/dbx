import { describe, expect, it } from "vitest";
import {
  eventToModifierOnlyShortcut,
  eventToShortcut,
  isEditTableStructureShortcut,
  isExecuteSqlInNewResultTabShortcut,
  isGoToColumnShortcut,
  isGoToFirstPageShortcut,
  isGoToLastPageShortcut,
  isGoToNextPageShortcut,
  isGoToPreviousPageShortcut,
  isToggleZenModeShortcut,
  matchesModifierOnlyShortcut,
  matchesShortcut,
  tabSwitcherDirectionFromShortcut,
} from "@/lib/editor/keyboardShortcuts";
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

  it.each([
    ["¨", "KeyU", "Shift+Alt+U"],
    ["Ò", "KeyL", "Shift+Alt+L"],
  ])("records macOS Option-modified %s by physical letter", (key, code, expected) => {
    expect(eventToShortcut({ key, code, altKey: true, shiftKey: true }, "MacIntel")).toBe(expected);
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

  it("matches the configurable Zen mode shortcut", () => {
    const platformModEvent = isMacShortcutPlatform() ? { key: "F12", metaKey: true, shiftKey: true } : { key: "F12", ctrlKey: true, shiftKey: true };

    expect(isToggleZenModeShortcut(platformModEvent, { toggleZenMode: "Shift+Mod+F12" })).toBe(true);
    expect(isToggleZenModeShortcut({ ...platformModEvent, shiftKey: false }, { toggleZenMode: "Shift+Mod+F12" })).toBe(false);
    expect(isToggleZenModeShortcut(platformModEvent, { toggleZenMode: "" })).toBe(false);
  });

  it("matches legacy plus-key shortcuts saved with plus as a separator", () => {
    expect(matchesShortcut({ key: "+", ctrlKey: true }, "Mod++", "Win32")).toBe(true);
    expect(matchesShortcut({ key: "+", ctrlKey: true, shiftKey: true }, "Shift+Mod++", "Win32")).toBe(true);
  });

  it("matches only the configured go-to-column shortcut", () => {
    expect(isGoToColumnShortcut({ key: "g", ctrlKey: true }, { goToColumn: "Mod+G" }, "Win32")).toBe(true);
    expect(isGoToColumnShortcut({ key: "g", ctrlKey: true, shiftKey: true }, { goToColumn: "Mod+G" }, "Win32")).toBe(false);
    expect(isGoToColumnShortcut({ key: "j", ctrlKey: true }, { goToColumn: "Mod+G" }, "Win32")).toBe(false);
  });

  it("does not match an empty or composing go-to-column shortcut", () => {
    expect(isGoToColumnShortcut({ key: "g", ctrlKey: true })).toBe(false);
    expect(isGoToColumnShortcut({ key: "g", ctrlKey: true }, { goToColumn: "" })).toBe(false);
    expect(isGoToColumnShortcut({ key: "g", ctrlKey: true, isComposing: true }, { goToColumn: "Mod+G" })).toBe(false);
  });

  it("matches the edit-table-structure shortcut on Windows and macOS", () => {
    expect(isEditTableStructureShortcut({ key: "d", ctrlKey: true }, undefined, "Win32")).toBe(true);
    expect(isEditTableStructureShortcut({ key: "d", metaKey: true }, undefined, "MacIntel")).toBe(true);
    expect(isEditTableStructureShortcut({ key: "d", ctrlKey: true }, undefined, "MacIntel")).toBe(false);
  });

  it("honors custom and disabled edit-table-structure shortcuts", () => {
    expect(isEditTableStructureShortcut({ key: "e", ctrlKey: true, shiftKey: true }, { editTableStructure: "Shift+Mod+E" }, "Win32")).toBe(true);
    expect(isEditTableStructureShortcut({ key: "d", ctrlKey: true }, { editTableStructure: "Shift+Mod+E" }, "Win32")).toBe(false);
    expect(isEditTableStructureShortcut({ key: "d", ctrlKey: true }, { editTableStructure: "" }, "Win32")).toBe(false);
    expect(isEditTableStructureShortcut({ key: "d", ctrlKey: true, isComposing: true }, undefined, "Win32")).toBe(false);
  });

  it.each([
    ["goToFirstPage", isGoToFirstPageShortcut, "F1"],
    ["goToPreviousPage", isGoToPreviousPageShortcut, "F2"],
    ["goToNextPage", isGoToNextPageShortcut, "F3"],
    ["goToLastPage", isGoToLastPageShortcut, "F4"],
  ] as const)("matches only the configured pagination shortcut for %s", (actionId, matcher, key) => {
    const shortcuts = { [actionId]: `Alt+${key}` };

    expect(matcher({ key, altKey: true }, shortcuts)).toBe(true);
    expect(matcher({ key }, shortcuts)).toBe(false);
    expect(matcher({ key: "F8", altKey: true }, shortcuts)).toBe(false);
    expect(matcher({ key, altKey: true, isComposing: true }, shortcuts)).toBe(false);
    expect(matcher({ key, altKey: true })).toBe(false);
  });
});

describe("tabSwitcherDirectionFromShortcut", () => {
  it("advances forward on the default Ctrl+Tab", () => {
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab", ctrlKey: true }, { tabSwitcher: "Ctrl+Tab" })).toBe(1);
  });

  it("moves backward when Shift is added to the configured shortcut", () => {
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab", ctrlKey: true, shiftKey: true }, { tabSwitcher: "Ctrl+Tab" })).toBe(-1);
  });

  it("ignores unrelated keys and modifiers", () => {
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab" }, { tabSwitcher: "Ctrl+Tab" })).toBeNull();
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab", ctrlKey: true, altKey: true }, { tabSwitcher: "Ctrl+Tab" })).toBeNull();
    expect(tabSwitcherDirectionFromShortcut({ key: "w", ctrlKey: true }, { tabSwitcher: "Ctrl+Tab" })).toBeNull();
  });

  it("honors a remapped shortcut and does not reverse when it already uses Shift", () => {
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab", ctrlKey: true, shiftKey: true }, { tabSwitcher: "Shift+Ctrl+Tab" })).toBe(1);
    expect(tabSwitcherDirectionFromShortcut({ key: "Tab", ctrlKey: true }, { tabSwitcher: "Shift+Ctrl+Tab" })).toBeNull();
  });
});
