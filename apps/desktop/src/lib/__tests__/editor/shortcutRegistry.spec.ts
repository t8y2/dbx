import { describe, expect, it } from "vitest";
import {
  closeOtherTabsDefaultShortcut,
  countShortcutConflictPairs,
  DEFAULT_SHORTCUT_SETTINGS,
  findCrossScopeShortcutConflicts,
  findShortcutConflict,
  formatShortcut,
  gotoLineDefaultShortcut,
  isReservedShortcut,
  MACOS_RESERVED_SHORTCUTS,
  normalizeModifierOnlyShortcut,
  normalizeShortcutSettings,
  resolveCapturedShortcutEdit,
  selectionOccurrenceDefaultShortcut,
  SHORTCUT_DEFINITIONS,
  shortcutToCodeMirrorKey,
  toggleAiPanelDefaultShortcut,
  type ShortcutActionId,
} from "@/lib/editor/shortcutRegistry";

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
    "addNextSelectionOccurrence",
    "selectAllSelectionOccurrences",
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

    expect(findShortcutConflict("goToColumn", shortcuts.goToColumn, shortcuts)).toBe("copyCurrentRow");
    expect(findShortcutConflict("goToColumn", "Mod+F", shortcuts)).toBeNull();
  });

  it("registers copy-current-row Mod+D and edit-table-structure Mod+Shift+D as conflict-free grid defaults", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "editTableStructure");

    expect(definition).toMatchObject({
      labelKey: "settings.shortcutEditTableStructure",
      scope: "grid",
      defaultShortcut: "Mod+Shift+D",
    });
    expect(DEFAULT_SHORTCUT_SETTINGS.editTableStructure).toBe("Mod+Shift+D");
    expect(DEFAULT_SHORTCUT_SETTINGS.copyCurrentRow).toBe("Mod+D");
    expect(findShortcutConflict("editTableStructure", DEFAULT_SHORTCUT_SETTINGS.editTableStructure, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    expect(findShortcutConflict("copyCurrentRow", DEFAULT_SHORTCUT_SETTINGS.copyCurrentRow, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    expect(findShortcutConflict("duplicateLine", DEFAULT_SHORTCUT_SETTINGS.duplicateLine, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("restores copy-current-row Mod+D after the previous edit-structure migration", () => {
    expect(normalizeShortcutSettings()).toMatchObject({ editTableStructure: "Mod+Shift+D", copyCurrentRow: "Mod+D" });
    expect(normalizeShortcutSettings({ copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "Mod+Shift+D", copyCurrentRow: "Mod+D" });
    expect(normalizeShortcutSettings({ copyCurrentRow: "Shift+Mod+C" })).toMatchObject({ editTableStructure: "Mod+Shift+D", copyCurrentRow: "Shift+Mod+C" });
    expect(normalizeShortcutSettings({ editTableStructure: "", copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "", copyCurrentRow: "Mod+D" });
    expect(normalizeShortcutSettings({ editTableStructure: "Shift+Mod+D", copyCurrentRow: "Mod+D" })).toMatchObject({ editTableStructure: "Shift+Mod+D", copyCurrentRow: "Mod+D" });
    expect(normalizeShortcutSettings({ editTableStructure: "Mod+D", copyCurrentRow: "" })).toMatchObject({ editTableStructure: "Mod+Shift+D", copyCurrentRow: "Mod+D" });
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

  it("registers a configurable editor shortcut for the explain plan", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "explainSql");

    expect(definition).toMatchObject({ labelKey: "toolbar.explainPlan", scope: "editor", defaultShortcut: "Mod+E" });
    expect(shortcutToCodeMirrorKey(DEFAULT_SHORTCUT_SETTINGS.explainSql)).toBe("Mod-e");
    expect(findShortcutConflict("explainSql", "Mod+E", DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
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

  it("uses a platform-specific shortcut for toggling the AI panel", () => {
    const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "toggleAiPanel");

    expect(definition).toMatchObject({ id: "toggleAiPanel", labelKey: "settings.shortcutToggleAiPanel", scope: "global" });
    expect(toggleAiPanelDefaultShortcut("MacIntel")).toBe("Ctrl+Mod+I");
    expect(toggleAiPanelDefaultShortcut("Win32")).toBe("Ctrl+Alt+I");
    expect(normalizeShortcutSettings({ toggleAiPanel: "Ctrl+Alt+I" }, "MacIntel").toggleAiPanel).toBe("Ctrl+Mod+I");
    expect(normalizeShortcutSettings({ toggleAiPanel: "Ctrl+Mod+I" }, "Win32").toggleAiPanel).toBe("Ctrl+Alt+I");
    expect(findShortcutConflict("toggleAiPanel", normalizeShortcutSettings().toggleAiPanel, normalizeShortcutSettings())).toBeNull();
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
    // 测试平台（Linux runner）解析为非 mac 默认键；mac 变体在下方单独断言。
    expect(shortcuts.addNextSelectionOccurrence).toBe(selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence"));
    expect(shortcuts.selectAllSelectionOccurrences).toBe(selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences"));
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

  it("registers occurrence selection shortcuts for query editor multi-selection", () => {
    const next = SHORTCUT_DEFINITIONS.find((item) => item.id === "addNextSelectionOccurrence");
    const all = SHORTCUT_DEFINITIONS.find((item) => item.id === "selectAllSelectionOccurrences");

    expect(next).toMatchObject({ scope: "editor", defaultShortcut: "Ctrl+G" });
    expect(all).toMatchObject({ scope: "editor", defaultShortcut: "Ctrl+Mod+G" });
    expect(findShortcutConflict("selectAllSelectionOccurrences", DEFAULT_SHORTCUT_SETTINGS.selectAllSelectionOccurrences, DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
  });

  it("resolves occurrence selection defaults per platform", () => {
    expect(selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence", "MacIntel")).toBe("Ctrl+G");
    expect(selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences", "MacIntel")).toBe("Ctrl+Mod+G");
    // Ctrl+Mod+G is unreachable on non-mac (CodeMirror expands Mod→Ctrl) and
    // Ctrl+G there is find-next, so Windows/Linux use the JetBrains-style keys.
    expect(selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence", "Win32")).toBe("Alt+J");
    expect(selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences", "Win32")).toBe("Ctrl+Alt+Shift+J");
    expect(selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence", "Linux x86_64")).toBe("Alt+J");
    expect(selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences", "Linux x86_64")).toBe("Ctrl+Alt+Shift+J");
    // Both platform defaults must survive the CodeMirror key conversion.
    expect(shortcutToCodeMirrorKey(selectionOccurrenceDefaultShortcut("selectAllSelectionOccurrences", "Win32"))).toBe("Ctrl-Alt-Shift-j");
    expect(shortcutToCodeMirrorKey(selectionOccurrenceDefaultShortcut("addNextSelectionOccurrence", "Win32"))).toBe("Alt-j");
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

  it("reserves only the macOS Hide combinations that the app menu owns", () => {
    expect(MACOS_RESERVED_SHORTCUTS).toEqual(new Set(["Mod+H", "Alt+Mod+H"]));
    // Meta+H and Mod+H are the same key on macOS; Shift+Mod+H is NOT reserved
    // because no menu key equivalent uses the shifted form.
    expect(isReservedShortcut("Mod+H", "MacIntel")).toBe(true);
    expect(isReservedShortcut("Meta+H", "MacIntel")).toBe(true);
    expect(isReservedShortcut("Cmd+H", "MacIntel")).toBe(true);
    expect(isReservedShortcut("Alt+Mod+H", "MacIntel")).toBe(true);
    // eventToShortcut 记录的 ⌥⌘H 顺序是 Mod+Alt+H（修饰键顺序不同），比较必须不敏感于顺序。
    expect(isReservedShortcut("Mod+Alt+H", "MacIntel")).toBe(true);
    expect(isReservedShortcut("Meta+Alt+H", "MacIntel")).toBe(true);
    // 反例：Ctrl+H / Control+H 是同一物理组合（CodeMirror 的 deleteCharBackward），
    // 不是 DBX 应用菜单的 accelerator，绝不能误判为保留键。
    expect(isReservedShortcut("Ctrl+H", "MacIntel")).toBe(false);
    expect(isReservedShortcut("Control+H", "MacIntel")).toBe(false);
    expect(isReservedShortcut("Shift+Mod+H", "MacIntel")).toBe(false);
    expect(isReservedShortcut("Mod+R", "MacIntel")).toBe(false);
    // On Windows/Linux Mod expands to Ctrl, so Ctrl+H stays a legitimate replace alias.
    expect(isReservedShortcut("Mod+H", "Win32")).toBe(false);
    expect(isReservedShortcut("Mod+H", "Linux x86_64")).toBe(false);
  });

  it("repairs a mac-synced reserved replace/find shortcut to the platform default", () => {
    // 云同步把 Windows 上的 Ctrl+H 当作 replace 显式配置带到 macOS，此处应修复
    // 为该动作在 macOS 上的平台默认值 Mod+R（而不是清空），确保 ⌘H 不被劫持。
    expect(normalizeShortcutSettings({ replace: "Mod+H" }, "MacIntel").replace).toBe("Mod+R");
    expect(normalizeShortcutSettings({ replace: "Meta+H" }, "MacIntel").replace).toBe("Mod+R");
    expect(normalizeShortcutSettings({ replace: "Alt+Mod+H" }, "MacIntel").replace).toBe("Mod+R");
    // eventToShortcut 记录的 ⌥⌘H 是 Mod+Alt+H，两个顺序都必须修复到平台默认值。
    expect(normalizeShortcutSettings({ replace: "Mod+Alt+H" }, "MacIntel").replace).toBe("Mod+R");
    expect(normalizeShortcutSettings({ find: "Mod+H" }, "MacIntel").find).toBe("Mod+F");
    // ⌃H 不是保留键：手工编辑或同步进来的 ⌃H 绑定原样保留，绝不修复。
    expect(normalizeShortcutSettings({ replace: "Ctrl+H" }, "MacIntel").replace).toBe("Ctrl+H");
    // 未保留的 Shift+Mod+H 原样保留，其他动作的默认值不受影响。
    expect(normalizeShortcutSettings({ replace: "Shift+Mod+H" }, "MacIntel").replace).toBe("Shift+Mod+H");
    expect(normalizeShortcutSettings({ replace: "Mod+R" }, "MacIntel").replace).toBe("Mod+R");
    expect(normalizeShortcutSettings({ replace: "Mod+H" }, "MacIntel").find).toBe("Mod+F");
    // Windows/Linux 上 Mod+H = Ctrl+H 必须原样保留（正常的替换键）。
    expect(normalizeShortcutSettings({ replace: "Mod+H" }, "Win32").replace).toBe("Mod+H");
    expect(normalizeShortcutSettings({ replace: "Mod+H" }, "Linux x86_64").replace).toBe("Mod+H");
  });

  it("clears a reserved-key repair when the platform default is already occupied by an explicit config", () => {
    // find 的平台默认值是 Mod+F。若用户把 formatSql 显式配置为 Mod+F、而 find 又被
    // 云同步/旧配置带入 macOS 保留键 ⌘H，修复会把 find 还原成 Mod+F，恰好抢占
    // formatSql——QueryEditor.vue 的 keymap 里 find 绑定注册在 formatSql 之前，
    // 先匹配先执行，formatSql 就永远不可达了。用户显式配置必须赢，因此被占用的
    // 修复动作只能清空（"" = 未绑定），而不是把默认值强加回去。
    const findOccupied = normalizeShortcutSettings({ find: "Mod+H", formatSql: "Mod+F" }, "MacIntel");
    expect(findOccupied.find).toBe("");
    expect(findOccupied.formatSql).toBe("Mod+F");
    // 同理由 replace 的平台默认值 Mod+R 与显式配置的 formatSql 冲突时清空 replace。
    const replaceOccupied = normalizeShortcutSettings({ replace: "Mod+H", formatSql: "Mod+R" }, "MacIntel");
    expect(replaceOccupied.replace).toBe("");
    expect(replaceOccupied.formatSql).toBe("Mod+R");
    // 无占用时仍按原逻辑修复到平台默认值。
    expect(normalizeShortcutSettings({ replace: "Mod+H" }, "MacIntel").replace).toBe("Mod+R");
    expect(normalizeShortcutSettings({ find: "Mod+H" }, "MacIntel").find).toBe("Mod+F");
    // 占用者仅来自默认（未显式配置）时不清空；⌃H 不是保留键，也原样保留。
    expect(normalizeShortcutSettings({ find: "Mod+H", replace: "Ctrl+H" }, "MacIntel").find).toBe("Mod+F");
    expect(normalizeShortcutSettings({ replace: "Ctrl+H" }, "MacIntel").replace).toBe("Ctrl+H");
    // 非 mac 平台 Mod+H = Ctrl+H 不是保留键，原样保留且不触发清空。
    const windows = normalizeShortcutSettings({ find: "Mod+H", formatSql: "Mod+F" }, "Win32");
    expect(windows.find).toBe("Mod+H");
    expect(windows.formatSql).toBe("Mod+F");
  });

  describe("findCrossScopeShortcutConflicts", () => {
    it("reports the intentional cross-scope overlaps in the defaults", () => {
      // 默认配置里确实存在跨作用域同键，这是设计使然；设置界面把它作为“提示”
      // 展示，而 normalizeShortcutSettings 的占用判定刻意不管它们。
      const conflicts = findCrossScopeShortcutConflicts(DEFAULT_SHORTCUT_SETTINGS);
      expect(conflicts.find).toContain("focusSearch");
      expect(conflicts.focusSearch).toContain("find");
      expect(conflicts.acceptCompletion).toContain("toggleTranspose");
      expect(conflicts.explainSql).toContain("editSidebarConnection");
      // Shift+Mod+D 与 Mod+Shift+D 经 formatShortcut 规范化后同键。
      expect(conflicts.viewTableDdl).toContain("editTableStructure");
    });

    it("never reports same-scope duplicates (those are blocking conflicts)", () => {
      // uppercaseSelection 改成 Mod+A 只与同作用域的 selectAll 重复，
      // 跨作用域提示不应把它列出来——那属于 findShortcutConflict 的职责。
      const shortcuts = normalizeShortcutSettings({ uppercaseSelection: "Mod+A" });
      expect(findShortcutConflict("uppercaseSelection", shortcuts.uppercaseSelection, shortcuts)).toBe("selectAll");
      expect(findCrossScopeShortcutConflicts(shortcuts).uppercaseSelection).toBeUndefined();
    });

    it("ignores unbound shortcuts", () => {
      const shortcuts = normalizeShortcutSettings({ find: "", focusSearch: "" });
      expect(shortcuts.find).toBe("");
      expect(shortcuts.focusSearch).toBe("");
      const conflicts = findCrossScopeShortcutConflicts(shortcuts);
      expect(conflicts.find).toBeUndefined();
      expect(conflicts.focusSearch).toBeUndefined();
      // goToColumn 默认未绑定，也不参与比较。
      expect(conflicts.goToColumn).toBeUndefined();
    });

    it("resolves platform-dependent keys before comparing", () => {
      // Win32 上 Mod+F 展开为 Ctrl+F，两边仍然是同键，提示照旧成立；
      // 未自定义的组合也不会被误判。
      const windows = findCrossScopeShortcutConflicts(normalizeShortcutSettings(undefined, "Win32"), "Win32");
      expect(windows.find).toContain("focusSearch");
      const mac = findCrossScopeShortcutConflicts(normalizeShortcutSettings(undefined, "MacIntel"), "MacIntel");
      expect(mac.find).toContain("focusSearch");
    });

    it("does not mutate the settings it inspects", () => {
      const shortcuts = normalizeShortcutSettings({ duplicateLine: "Mod+Alt+K" });
      const before = { ...shortcuts };
      findCrossScopeShortcutConflicts(shortcuts);
      expect(shortcuts).toEqual(before);
    });
  });

  describe("gotoLine", () => {
    it("resolves the platform default and maps it to the CodeMirror key", () => {
      // macOS 的 ⌃G 已分配给「选中下一个相同词」（JetBrains 风格），沿用
      // CodeMirror 搜索键位里原本就指向 gotoLine 的 ⌘⌥G；Windows/Linux 用
      // VS Code / SSMS 惯例的 Ctrl+G。
      expect(gotoLineDefaultShortcut("MacIntel")).toBe("Mod+Alt+G");
      expect(gotoLineDefaultShortcut("Win32")).toBe("Mod+G");
      expect(gotoLineDefaultShortcut("Linux x86_64")).toBe("Mod+G");
      expect(shortcutToCodeMirrorKey(gotoLineDefaultShortcut("MacIntel"))).toBe("Mod-Alt-g");
      expect(shortcutToCodeMirrorKey(gotoLineDefaultShortcut("Win32"))).toBe("Mod-g");
    });

    it("registers an editor-scope definition with the settings label", () => {
      expect(SHORTCUT_DEFINITIONS.find((item) => item.id === "gotoLine")).toMatchObject({
        id: "gotoLine",
        labelKey: "settings.shortcutGotoLine",
        scope: "editor",
      });
      expect(DEFAULT_SHORTCUT_SETTINGS.gotoLine).toBe(gotoLineDefaultShortcut());
    });

    it("re-resolves a cloud-synced default from the other platform", () => {
      // 云同步会把另一平台的默认值当成显式配置带过来，解析后必须回到本机平台默认。
      expect(normalizeShortcutSettings({ gotoLine: "Mod+Alt+G" }, "Win32").gotoLine).toBe("Mod+G");
      expect(normalizeShortcutSettings({ gotoLine: "Mod+G" }, "MacIntel").gotoLine).toBe("Mod+Alt+G");
      // 用户真正自定义的组合原样保留，清空仍然表示「不绑定」。
      expect(normalizeShortcutSettings({ gotoLine: "Alt+Mod+Shift+L" }, "Win32").gotoLine).toBe("Alt+Mod+Shift+L");
      expect(normalizeShortcutSettings({ gotoLine: "" }, "Win32").gotoLine).toBe("");
    });

    it("never collides with the same-scope selection-occurrence shortcuts", () => {
      // 非 mac 的 Mod+G 展开后是 Ctrl+G，恰好等于 mac 上
      // addNextSelectionOccurrence 的默认键；两者分属不同平台，不能互相判为冲突。
      for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
        const shortcuts = normalizeShortcutSettings(undefined, platform);
        expect(shortcuts.gotoLine).toBe(gotoLineDefaultShortcut(platform));
        expect(findShortcutConflict("gotoLine", shortcuts.gotoLine, shortcuts, platform)).toBeNull();
        expect(findShortcutConflict("addNextSelectionOccurrence", shortcuts.addNextSelectionOccurrence, shortcuts, platform)).toBeNull();
      }
    });
  });

  describe("resolveCapturedShortcutEdit", () => {
    // #9881：设置面板「应用」点了毫无反应、「应用并关闭」每次都弹未保存确认，
    // 根因就是捕获到的组合被落盘口径改写，草稿和 store 值再也对不上。
    const macDefaults = normalizeShortcutSettings(undefined, "MacIntel");
    const crossPlatformCases: [ShortcutActionId, string][] = [
      ["closeOtherTabs", "Shift+Alt+W"],
      ["navigateTabHistoryBack", "Mod+Alt+ArrowLeft"],
      ["navigateTabHistoryForward", "Mod+Alt+ArrowRight"],
      ["addNextSelectionOccurrence", "Alt+J"],
      ["selectAllSelectionOccurrences", "Ctrl+Alt+Shift+J"],
      ["toggleAiPanel", "Ctrl+Alt+I"],
      ["gotoLine", "Mod+G"],
    ];

    it("flags combinations that are another platform's default for the same action", () => {
      for (const [actionId, shortcut] of crossPlatformCases) {
        const edit = resolveCapturedShortcutEdit(actionId, shortcut, macDefaults, "MacIntel");

        expect(edit.rejectedByPlatformDefault).toBe(true);
        // 落盘值是该动作本机平台的默认键，绝不能用它当草稿值写入
        expect(edit.shortcuts[actionId]).not.toBe(shortcut);
      }
    });

    it("accepts a plain rebind and keeps the draft a fixed point of the persistence normalizer", () => {
      const edit = resolveCapturedShortcutEdit("executeSql", "Shift+Ctrl+U", macDefaults, "MacIntel");

      expect(edit.rejectedByPlatformDefault).toBe(false);
      expect(edit.changed).toBe(true);
      expect(edit.shortcuts.executeSql).toBe("Shift+Ctrl+U");
      // 关键不变式：草稿再走一遍落盘口径不会被改写，否则“未保存”永远消不掉
      expect(normalizeShortcutSettings(edit.shortcuts, "MacIntel")).toEqual(edit.shortcuts);
    });

    it("adopts the copyCurrentRow/editTableStructure legacy migration into the draft", () => {
      const draft = normalizeShortcutSettings({ ...macDefaults, copyCurrentRow: "" }, "MacIntel");
      const edit = resolveCapturedShortcutEdit("editTableStructure", "Mod+D", draft, "MacIntel");

      expect(edit.rejectedByPlatformDefault).toBe(false);
      expect(edit.changed).toBe(true);
      expect(edit.shortcuts).toMatchObject({ editTableStructure: "Mod+Shift+D", copyCurrentRow: "Mod+D" });
      expect(normalizeShortcutSettings(edit.shortcuts, "MacIntel")).toEqual(edit.shortcuts);
    });

    it("reports no changes when the user re-presses the current combination", () => {
      const edit = resolveCapturedShortcutEdit("closeOtherTabs", macDefaults.closeOtherTabs, macDefaults, "MacIntel");

      expect(edit.rejectedByPlatformDefault).toBe(false);
      expect(edit.changed).toBe(false);
      expect(edit.shortcuts).toEqual(macDefaults);
    });

    it("still applies the cross-platform rule on Windows for the macOS default literals", () => {
      const windowsDefaults = normalizeShortcutSettings(undefined, "Win32");
      const edit = resolveCapturedShortcutEdit("closeOtherTabs", "Alt+Mod+W", windowsDefaults, "Win32");

      expect(edit.rejectedByPlatformDefault).toBe(true);
      expect(edit.shortcuts.closeOtherTabs).toBe(closeOtherTabsDefaultShortcut("Win32"));
    });
  });

  describe("countShortcutConflictPairs", () => {
    it("counts an unordered pair once even though the map is bidirectional", () => {
      expect(countShortcutConflictPairs({ find: "focusSearch", focusSearch: "find" })).toBe(1);
    });

    it("flattens multi-partner entries", () => {
      expect(countShortcutConflictPairs({ find: ["focusSearch", "formatSql"], formatSql: ["find"] })).toBe(2);
    });

    it("ignores empty entries", () => {
      expect(countShortcutConflictPairs({})).toBe(0);
      expect(countShortcutConflictPairs({ find: "" })).toBe(0);
      expect(countShortcutConflictPairs({ find: [] })).toBe(0);
    });
  });
});
