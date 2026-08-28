import { describe, expect, it } from "vitest";
import { closeOtherTabsDefaultShortcut, DEFAULT_SHORTCUT_SETTINGS, SHORTCUT_DEFINITIONS, findShortcutConflict, formatShortcut, normalizeModifierOnlyShortcut, normalizeShortcutSettings, shortcutToCodeMirrorKey, type ShortcutActionId } from "@/lib/editor/shortcutRegistry";

describe("shortcutRegistry editor actions", () => {
  const formatterEditorActionIds: ShortcutActionId[] = [
    "formatSql",
    "toggleLineComment",
    "toggleBlockComment",
    "indentMore",
    "indentLess",
    "joinLines",
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

  it("registers pagination navigation as unassigned grid shortcuts", () => {
    const paginationActions = [
      ["goToFirstPage", "settings.shortcutGoToFirstPage"],
      ["goToPreviousPage", "settings.shortcutGoToPreviousPage"],
      ["goToNextPage", "settings.shortcutGoToNextPage"],
      ["goToLastPage", "settings.shortcutGoToLastPage"],
    ] as const;

    for (const [id, labelKey] of paginationActions) {
      expect(SHORTCUT_DEFINITIONS.find((item) => item.id === id)).toMatchObject({ id, labelKey, scope: "grid", defaultShortcut: "" });
      expect(DEFAULT_SHORTCUT_SETTINGS[id]).toBe("");
    }
  });

  it("normalizes missing, legacy, cleared, and configured pagination shortcuts", () => {
    const missing = normalizeShortcutSettings();
    const legacy = normalizeShortcutSettings({ goToColumn: "Mod+G" });
    const configured = normalizeShortcutSettings({ goToFirstPage: "Alt+F1", goToPreviousPage: "Alt+F2", goToNextPage: "Alt+F3", goToLastPage: "Alt+F4" });

    for (const actionId of ["goToFirstPage", "goToPreviousPage", "goToNextPage", "goToLastPage"] as const) {
      expect(missing[actionId]).toBe("");
      expect(legacy[actionId]).toBe("");
    }
    expect(configured.goToFirstPage).toBe("Alt+F1");
    expect(configured.goToPreviousPage).toBe("Alt+F2");
    expect(configured.goToNextPage).toBe("Alt+F3");
    expect(configured.goToLastPage).toBe("Alt+F4");
    expect(configured.goToColumn).toBe("");
  });

  it("detects pagination shortcut conflicts in the grid scope", () => {
    const shortcuts = normalizeShortcutSettings({ goToFirstPage: "Alt+F1", goToPreviousPage: "Alt+F1" });

    expect(findShortcutConflict("goToFirstPage", shortcuts.goToFirstPage, shortcuts)).toBe("goToPreviousPage");
    expect(findShortcutConflict("goToFirstPage", "Mod+F", shortcuts)).toBeNull();
  });

  it("registers go to column as an unassigned grid shortcut", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "goToColumn");

    expect(definition).toMatchObject({
      labelKey: "settings.shortcutGoToColumn",
      scope: "grid",
      defaultShortcut: "",
    });
    expect(DEFAULT_SHORTCUT_SETTINGS.goToColumn).toBe("");
  });

  it("normalizes missing, legacy, cleared, and configured go-to-column settings", () => {
    expect(normalizeShortcutSettings().goToColumn).toBe("");
    expect(normalizeShortcutSettings({ executeSql: "Mod+Shift+Enter" }).goToColumn).toBe("");
    expect(normalizeShortcutSettings({ goToColumn: "" }).goToColumn).toBe("");
    expect(normalizeShortcutSettings({ goToColumn: "Mod+G" }).goToColumn).toBe("Mod+G");
  });

  it("detects go-to-column conflicts only within the grid scope", () => {
    const shortcuts = normalizeShortcutSettings({ goToColumn: "Mod+D" });

    expect(findShortcutConflict("goToColumn", shortcuts.goToColumn, shortcuts)).toBe("editTableStructure");
    expect(findShortcutConflict("goToColumn", "Mod+F", shortcuts)).toBeNull();
  });

  it("registers edit table structure as the conflict-free default Mod+D grid action", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "editTableStructure");

    expect(definition).toMatchObject({
      labelKey: "settings.shortcutEditTableStructure",
      scope: "grid",
      defaultShortcut: "Mod+D",
    });
    expect(DEFAULT_SHORTCUT_SETTINGS.editTableStructure).toBe("Mod+D");
    expect(DEFAULT_SHORTCUT_SETTINGS.copyCurrentRow).toBe("");
    expect(findShortcutConflict("editTableStructure", DEFAULT_SHORTCUT_SETTINGS.editTableStructure, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    expect(findShortcutConflict("duplicateLine", DEFAULT_SHORTCUT_SETTINGS.duplicateLine, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("migrates the legacy copy-row Mod+D default without overwriting explicit shortcuts", () => {
    expect(normalizeShortcutSettings()).toMatchObject({ editTableStructure: "Mod+D", copyCurrentRow: "" });
    expect(normalizeShortcutSettings({ copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "Mod+D", copyCurrentRow: "" });
    expect(normalizeShortcutSettings({ copyCurrentRow: "Shift+Mod+C" })).toMatchObject({ editTableStructure: "Mod+D", copyCurrentRow: "Shift+Mod+C" });
    expect(normalizeShortcutSettings({ editTableStructure: "", copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "", copyCurrentRow: "Mod+D" });
    expect(normalizeShortcutSettings({ editTableStructure: "Shift+Mod+D", copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "Shift+Mod+D", copyCurrentRow: "Mod+D" });
  });

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

  it("registers a conflict-free global shortcut for Zen mode", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "toggleZenMode");

    expect(definition).toMatchObject({ labelKey: "settings.shortcutToggleZenMode", scope: "global", defaultShortcut: "Shift+Mod+F12" });
    expect(DEFAULT_SHORTCUT_SETTINGS.toggleZenMode).toBe("Shift+Mod+F12");
    expect(findShortcutConflict("toggleZenMode", DEFAULT_SHORTCUT_SETTINGS.toggleZenMode, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("uses Shift+Enter for inserting a complete line below", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "insertLineBelow");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Shift+Enter" });
    expect(DEFAULT_SHORTCUT_SETTINGS.insertLineBelow).toBe("Shift+Enter");
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.insertLineBelow)).toBe("Shift-Enter");
    expect(findShortcutConflict("insertLineBelow", DEFAULT_SHORTCUT_SETTINGS.insertLineBelow, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("registers a conflict-free platform shortcut for joining lines", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "joinLines");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Mod+J" });
    expect(DEFAULT_SHORTCUT_SETTINGS.joinLines).toBe("Mod+J");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.joinLines, "MacIntel")).toBe("Cmd+J");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.joinLines, "Win32")).toBe("Ctrl+J");
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.joinLines)).toBe("Mod-j");
    expect(findShortcutConflict("joinLines", DEFAULT_SHORTCUT_SETTINGS.joinLines, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
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
    expect(shortcuts.toggleBlockComment).toBe("Shift+Alt+A");
    expect(shortcuts.indentMore).toBe("");
    expect(shortcuts.indentLess).toBe("Shift+Tab");
    expect(shortcuts.joinLines).toBe("Mod+J");
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

  it("registers an IDEA/DataGrip-style Alt+/ shortcut for manually triggering completion", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "triggerCompletion");

    expect(definition).toMatchObject({ scope: "editor", defaultShortcut: "Alt+/" });
    expect(DEFAULT_SHORTCUT_SETTINGS.triggerCompletion).toBe("Alt+/");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.triggerCompletion, "Win32")).toBe("Alt+/");
    expect(formatShortcut(DEFAULT_SHORTCUT_SETTINGS.triggerCompletion, "MacIntel")).toBe("Alt+/");
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.triggerCompletion)).toBe("Alt-/");
    expect(findShortcutConflict("triggerCompletion", DEFAULT_SHORTCUT_SETTINGS.triggerCompletion, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
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
