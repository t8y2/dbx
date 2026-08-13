import { describe, expect, it } from "vitest";
import { closeOtherTabsDefaultShortcut, DEFAULT_SHORTCUT_SETTINGS, SHORTCUT_DEFINITIONS, findShortcutConflict, formatShortcut, normalizeModifierOnlyShortcut, normalizeShortcutSettings, shortcutToCodeMirrorKey, type ShortcutActionId } from "@/lib/editor/shortcutRegistry";

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
    "toggleFold",
  ];
  const sidebarShortcutActionIds: ShortcutActionId[] = ["copySidebarSelection", "pasteSidebarSelection", "editSidebarConnection", "viewTableDdl"];

  it("registers the new-data-tab mouse modifier as a configurable sidebar shortcut", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "openDataInNewTab");

    expect(definition).toMatchObject({ scope: "sidebar", defaultShortcut: "Alt", inputKind: "modifier-only" });
    expect(DEFAULT_SHORTCUT_SETTINGS.openDataInNewTab).toBe("Alt");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.openDataInNewTab, "MacIntel")).toBe("Alt");
  });

  it("registers a conflict-free DBeaver-style shortcut for executing in a new result tab", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "executeSqlInNewResultTab");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Mod+\\" });
    expect(DEFAULT_SHORTCUT_SETTINGS.executeSqlInNewResultTab).toBe("Mod+\\");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.executeSqlInNewResultTab, "MacIntel")).toBe("Cmd+\\");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.executeSqlInNewResultTab, "Win32")).toBe("Ctrl+\\");
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.executeSqlInNewResultTab)).toBe("Mod-\\");
    expect(findShortcutConflict("executeSqlInNewResultTab", DEFAULT_SHORTCUT_SETTINGS.executeSqlInNewResultTab, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("registers a conflict-free shortcut for expanding SELECT stars", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "expandSelectStar");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Mod+Shift+X" });
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.expandSelectStar)).toBe("Mod-Shift-x");
    expect(findShortcutConflict("expandSelectStar", DEFAULT_SHORTCUT_SETTINGS.expandSelectStar, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("keeps current-view search and editor find contextual on Mod+F", () => {
    const focusSearch = SHORTCUT_DEFINITIONS.find((item) => item.id === "focusSearch");
    const find = SHORTCUT_DEFINITIONS.find((item) => item.id === "find");

    expect(focusSearch).toMatchObject({ scope: "global", defaultShortcut: "Mod+F" });
    expect(find).toMatchObject({ scope: "editor", defaultShortcut: "Mod+F" });
    expect(findShortcutConflict("focusSearch", DEFAULT_SHORTCUT_SETTINGS.focusSearch, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    expect(findShortcutConflict("find", DEFAULT_SHORTCUT_SETTINGS.find, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("uses Shift+Enter for inserting a complete line below", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "insertLineBelow");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Shift+Enter" });
    expect(DEFAULT_SHORTCUT_SETTINGS.insertLineBelow).toBe("Shift+Enter");
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.insertLineBelow)).toBe("Shift-Enter");
    expect(findShortcutConflict("insertLineBelow", DEFAULT_SHORTCUT_SETTINGS.insertLineBelow, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("resolves the close-other-tabs default per platform and heals cross-platform synced defaults", () => {
    // 本测试环境（darwin）：默认应为 macOS 组合
    expect(DEFAULT_SHORTCUT_SETTINGS.closeOtherTabs).toBe(closeOtherTabsDefaultShortcut());
    expect(closeOtherTabsDefaultShortcut("MacIntel")).toBe("Alt+Mod+W");
    // Windows/Linux 不含 Ctrl+Alt（AltGr）也不含 Ctrl+Shift+W（浏览器关窗保留键）
    expect(closeOtherTabsDefaultShortcut("Win32")).toBe("Shift+Alt+W");
    expect(closeOtherTabsDefaultShortcut("Linux x86_64")).toBe("Shift+Alt+W");
    // 云同步把另一平台的默认值带过来：视为未自定义，按本机平台还原
    expect(normalizeShortcutSettings({ closeOtherTabs: "Alt+Mod+W" }).closeOtherTabs).toBe(closeOtherTabsDefaultShortcut());
    expect(normalizeShortcutSettings({ closeOtherTabs: "Shift+Alt+W" }).closeOtherTabs).toBe(closeOtherTabsDefaultShortcut());
    // 用户真正自定义的组合原样保留
    expect(normalizeShortcutSettings({ closeOtherTabs: "Shift+Mod+O" }).closeOtherTabs).toBe("Shift+Mod+O");
  });

  it("uses the platform modifier for closing tabs and migrates the legacy Meta default", () => {
    expect(DEFAULT_SHORTCUT_SETTINGS.closeTab).toBe("Mod+W");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.closeTab, "Win32")).toBe("Ctrl+W");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.closeTab, "MacIntel")).toBe("Cmd+W");
    expect(normalizeShortcutSettings({ closeTab: "Meta+W" }).closeTab).toBe("Mod+W");
    expect(normalizeShortcutSettings({ closeTab: "Shift+Mod+W" }).closeTab).toBe("Shift+Mod+W");
    expect(normalizeShortcutSettings({ closeTab: "" }).closeTab).toBe("");
  });

  it("normalizes custom, cleared, and invalid modifier-only shortcuts", () => {
    expect(normalizeShortcutSettings({ openDataInNewTab: "Shift" }).openDataInNewTab).toBe("Shift");
    expect(normalizeShortcutSettings({ openDataInNewTab: "" }).openDataInNewTab).toBe("");
    expect(normalizeShortcutSettings({ openDataInNewTab: "Mod+Enter" }).openDataInNewTab).toBe("Alt");
    expect(normalizeModifierOnlyShortcut("Control")).toBe("Ctrl");
  });

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
    expect(shortcuts.extendSelection).toBe("Alt+W");
    expect(shortcuts.uppercaseSelection).toBe("Shift+Alt+U");
    expect(shortcuts.lowercaseSelection).toBe("Shift+Alt+L");
    expect(shortcuts.exPasteSqlInCondition).toBe("");
    expect(shortcuts.toggleFold).toBe("Mod+.");
  });

  it("registers IntelliJ-style extend selection as a configurable editor shortcut", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "extendSelection");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Alt+W" });
    expect(DEFAULT_SHORTCUT_SETTINGS.extendSelection).toBe("Alt+W");
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
