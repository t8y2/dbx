import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS, SHORTCUT_DEFINITIONS, findShortcutConflict, formatShortcut, normalizeShortcutSettings, shortcutToCodeMirrorKey, type ShortcutActionId } from "@/lib/editor/shortcutRegistry";

describe("shortcutRegistry editor actions", () => {
  const formatterEditorActionIds: ShortcutActionId[] = [
    "formatSql",
    "toggleLineComment",
    "indentMore",
    "indentLess",
    "duplicateLine",
    "deleteLine",
    "moveLineUp",
    "moveLineDown",
    "copyLineUp",
    "copyLineDown",
    "undo",
    "redo",
    "selectAll",
    "uppercaseSelection",
    "lowercaseSelection",
    "exPasteSqlInCondition",
  ];
  const sidebarShortcutActionIds: ShortcutActionId[] = ["copySidebarSelection", "pasteSidebarSelection", "editSidebarConnection"];

  it("registers formatter editor shortcuts in the generic editor scope", () => {
    for (const actionId of formatterEditorActionIds) {
      const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);

      expect(definition?.scope).toBe("editor");
      expect(DEFAULT_SHORTCUT_SETTINGS[actionId]).toBe(definition?.defaultShortcut);
    }
  });

  it("normalizes missing formatter editor shortcuts to their generic defaults", () => {
    const shortcuts = normalizeShortcutSettings({ executeSql: "Mod+Shift+Enter" });

    expect(shortcuts.executeSql).toBe("Mod+Shift+Enter");
    expect(shortcuts.formatSql).toBe("Shift+Mod+F");
    expect(shortcuts.toggleLineComment).toBe("Mod+/");
    expect(shortcuts.indentMore).toBe("");
    expect(shortcuts.indentLess).toBe("Shift+Tab");
    expect(shortcuts.duplicateLine).toBe("Mod+D");
    expect(shortcuts.deleteLine).toBe("Shift+Mod+K");
    expect(shortcuts.moveLineUp).toBe("Alt+ArrowUp");
    expect(shortcuts.moveLineDown).toBe("Alt+ArrowDown");
    expect(shortcuts.copyLineUp).toBe("Shift+Alt+ArrowUp");
    expect(shortcuts.copyLineDown).toBe("Shift+Alt+ArrowDown");
    expect(shortcuts.undo).toBe("Mod+Z");
    expect(shortcuts.redo).toBe("Shift+Mod+Z");
    expect(shortcuts.selectAll).toBe("Mod+A");
    expect(shortcuts.uppercaseSelection).toBe("Shift+Alt+U");
    expect(shortcuts.lowercaseSelection).toBe("Shift+Alt+L");
    expect(shortcuts.exPasteSqlInCondition).toBe("");
  });

  it("detects conflicts between formatter editor shortcuts and other editor shortcuts", () => {
    const shortcuts = normalizeShortcutSettings({ duplicateLine: "Mod+F" });

    expect(findShortcutConflict("duplicateLine", shortcuts.duplicateLine, shortcuts)).toBe("find");
  });

  it("detects conflicts for SQL selection case shortcuts", () => {
    const shortcuts = normalizeShortcutSettings({ uppercaseSelection: "Mod+A" });

    expect(findShortcutConflict("uppercaseSelection", shortcuts.uppercaseSelection, shortcuts)).toBe("selectAll");
  });

  it("registers sidebar shortcuts in the sidebar scope", () => {
    for (const actionId of sidebarShortcutActionIds) {
      const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);

      expect(definition?.scope).toBe("sidebar");
      expect(DEFAULT_SHORTCUT_SETTINGS[actionId]).toBe(definition?.defaultShortcut);
    }
  });

  it("detects conflicts only within sidebar shortcuts", () => {
    const shortcuts = normalizeShortcutSettings({ copySidebarSelection: "Mod+E" });

    expect(findShortcutConflict("copySidebarSelection", shortcuts.copySidebarSelection, shortcuts)).toBe("editSidebarConnection");
    expect(findShortcutConflict("copyCurrentRow", shortcuts.copyCurrentRow, shortcuts)).toBe(null);
  });

  it("formats Ctrl before Shift on Windows", () => {
    expect(formatShortcut("Shift+Mod+F", "Win32")).toBe("Ctrl+Shift+F");
  });

  it("converts plus-key shortcuts for CodeMirror keymaps", () => {
    expect(shortcutToCodeMirrorKey("Mod+Plus")).toBe("Mod-+");
    expect(shortcutToCodeMirrorKey("Shift+Mod++")).toBe("Shift-Mod-+");
  });

  it("converts slash shortcuts for CodeMirror keymaps", () => {
    expect(shortcutToCodeMirrorKey("Mod+/")).toBe("Mod-/");
  });

  it("converts multi-stroke shortcuts for CodeMirror keymaps", () => {
    expect(shortcutToCodeMirrorKey("Ctrl+K Ctrl+C")).toBe("Ctrl-k Ctrl-c");
  });
});
