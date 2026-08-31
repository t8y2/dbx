import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, editorSettingsDraftChanged, editorSettingsPatchFromDraft, normalizeQueryResultMaxRowsDraft, normalizeTableOpenPageSizeDraft, shouldConfirmEditorSettingsDialogClose } from "../editorSettingsDraft";
import type { EditorSettings } from "@/stores/settingsStore";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

function makeSettings(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return {
    autoCalculateTotalRows: false,
    pageSize: 100,
    tableOpenPageSize: 100,
    queryResultMaxRowsEnabled: true,
    queryResultMaxRows: 100000,
    sqlEngine: "desktop",
    tabSize: 2,
    keywordCase: "upper",
    indentStyle: "standard",
    lineWidth: 80,
    commaPosition: "end",
    editorFontFamily: "",
    editorFontSize: 0,
    editorLineHeight: 0,
    maxRowsPerPage: 50000,
    showHiddenFiles: false,
    confirmDangerousSqlExecution: true,
    continueOnErrorOnBatch: false,
    confirmUnsavedSqlClose: true,
    savedSqlOpenTargetMode: "saved",
    objectBrowserViewMode: "list",
    sqlVariableSubstitutionEnabled: true,
    sqlVariableSyntaxOverrides: {},
    tabLayout: "scroll",
    ...overrides,
  };
}

describe("EDITOR_SETTINGS_DRAFT_KEYS", () => {
  it("keeps connection and query timeout ownership outside editor settings", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).not.toContain("globalConnectTimeoutSecs");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).not.toContain("globalQueryTimeoutSecs");
  });

  it("includes showLineNumbers", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("showLineNumbers");
  });

  it("includes continueOnErrorOnBatch", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("continueOnErrorOnBatch");
  });

  it("includes the table-open page size", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("pageSize");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("tableOpenPageSize");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("queryResultMaxRowsEnabled");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("queryResultMaxRows");
  });

  it("includes the saved SQL open target mode", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("savedSqlOpenTargetMode");
  });

  it("includes the regular expression match limit", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("regexMaxMatchCount");
  });

  it("includes the data-tab reuse mode", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("dataTabReuseMode");
  });

  it("includes adjacent data-tab opening", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("openDataTabsNextToActive");
  });

  it("includes data grid type colors", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("colorizeDataGridCellTypes");
  });

  it("includes the type color scheme in the apply-footer draft", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("dataGridTypeColorSchemes");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("activeDataGridTypeColorSchemeId");

    const base = editorSettingsDraftFromSettings(makeSettings({ dataGridTypeColorSchemes: [], activeDataGridTypeColorSchemeId: "auto" }));
    const withScheme = editorSettingsDraftFromSettings(
      makeSettings({
        dataGridTypeColorSchemes: [{ id: "type-colors-1", name: "配色方案 1", colors: { integer: "#254fce", numeric: "#0e7490", string: "#fdc9c9", boolean: "#100cc2", temporal: "#7e22ce", structured: "#be185d", identifier: "#92400e", binary: "#b91c1c", spatial: "#047857" } }],
        activeDataGridTypeColorSchemeId: "type-colors-1",
      }),
    );

    expect(editorSettingsDraftChanged(withScheme, base)).toBe(true);
    expect(editorSettingsPatchFromDraft(withScheme, base)).toEqual({
      dataGridTypeColorSchemes: [{ id: "type-colors-1", name: "配色方案 1", colors: { integer: "#254fce", numeric: "#0e7490", string: "#fdc9c9", boolean: "#100cc2", temporal: "#7e22ce", structured: "#be185d", identifier: "#92400e", binary: "#b91c1c", spatial: "#047857" } }],
      activeDataGridTypeColorSchemeId: "type-colors-1",
    });
  });

  it("includes the data grid filter view", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("dataGridFilterEditorView");
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("dataGridTextFilterPanelHeight");
  });

  it("includes the multi-statement default view", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("multiStatementDefaultView");
  });

  it("includes the cell detail button visibility", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("dataGridCellDetailButtonVisible");
  });

  it("includes completionTriggerMode", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("completionTriggerMode");
  });

  it("includes the SQL variable substitution master switch", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("sqlVariableSubstitutionEnabled");
  });
});

describe("cell detail button settings control", () => {
  it("binds the switch through apply and both reset paths", () => {
    expect(settingsDialogSource).toContain("const editDataGridCellDetailButtonVisible = ref(settingsStore.editorSettings.dataGridCellDetailButtonVisible)");
    expect(settingsDialogSource).toContain("dataGridCellDetailButtonVisible: editDataGridCellDetailButtonVisible.value");
    expect(settingsDialogSource).toContain("editDataGridCellDetailButtonVisible.value = settingsStore.editorSettings.dataGridCellDetailButtonVisible");
    expect(settingsDialogSource.match(/editDataGridCellDetailButtonVisible\.value = DEFAULT_EDITOR_SETTINGS\.dataGridCellDetailButtonVisible/g)).toHaveLength(2);
    expect(settingsDialogSource).toContain('id="data-grid-cell-detail-button-visible" v-model="editDataGridCellDetailButtonVisible"');
  });
});

describe("editorSettingsDraftFromSettings", () => {
  it("round-trips a hidden line-number preference through the draft patch", () => {
    const settings = makeSettings({ showLineNumbers: true });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);

    draft.showLineNumbers = false;

    expect(editorSettingsPatchFromDraft(draft, base)).toEqual({ showLineNumbers: false });
  });

  it("toggles substitution without discarding per-database overrides", () => {
    const base = editorSettingsDraftFromSettings(
      makeSettings({
        sqlVariableSubstitutionEnabled: true,
        sqlVariableSyntaxOverrides: { mysql: { shell: false } },
      }),
    );
    const draft = editorSettingsDraftFromSettings(
      makeSettings({
        sqlVariableSubstitutionEnabled: true,
        sqlVariableSyntaxOverrides: { mysql: { shell: false } },
      }),
    );

    draft.sqlVariableSubstitutionEnabled = false;

    expect(editorSettingsPatchFromDraft(draft, base)).toEqual({ sqlVariableSubstitutionEnabled: false });
    expect(draft.sqlVariableSyntaxOverrides).toEqual({ mysql: { shell: false } });
    expect(base.sqlVariableSyntaxOverrides).toEqual({ mysql: { shell: false } });
  });

  it("does not include persisted global timeout values in editor drafts", () => {
    const settings = makeSettings({ globalConnectTimeoutSecs: 17, globalQueryTimeoutSecs: 43 });
    const draft = editorSettingsDraftFromSettings(settings);

    expect(draft).not.toHaveProperty("globalConnectTimeoutSecs");
    expect(draft).not.toHaveProperty("globalQueryTimeoutSecs");
    expect(editorSettingsPatchFromDraft(draft, draft)).not.toHaveProperty("globalConnectTimeoutSecs");
    expect(editorSettingsPatchFromDraft(draft, draft)).not.toHaveProperty("globalQueryTimeoutSecs");
  });

  it("maps continueOnErrorOnBatch from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ continueOnErrorOnBatch: true }));
    expect(draft.continueOnErrorOnBatch).toBe(true);
  });

  it("maps continueOnErrorOnBatch=false from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ continueOnErrorOnBatch: false }));
    expect(draft.continueOnErrorOnBatch).toBe(false);
  });

  it("maps the data grid type color preference from settings", () => {
    expect(editorSettingsDraftFromSettings(makeSettings({ colorizeDataGridCellTypes: false })).colorizeDataGridCellTypes).toBe(false);
  });

  it("maps the data grid filter view from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ dataGridFilterEditorView: "text", dataGridTextFilterPanelHeight: 224 }));
    expect(draft.dataGridFilterEditorView).toBe("text");
    expect(draft.dataGridTextFilterPanelHeight).toBe(224);
  });

  it("maps the multi-statement default view from settings", () => {
    expect(editorSettingsDraftFromSettings(makeSettings({ multiStatementDefaultView: "summary" })).multiStatementDefaultView).toBe("summary");
  });

  it("preserves the table-open default for legacy settings", () => {
    const settings = makeSettings();
    delete (settings as Partial<EditorSettings>).tableOpenPageSize;
    expect(editorSettingsDraftFromSettings(settings).tableOpenPageSize).toBe(100);
  });

  it("maps the saved SQL open target mode", () => {
    expect(editorSettingsDraftFromSettings(makeSettings({ savedSqlOpenTargetMode: "current" })).savedSqlOpenTargetMode).toBe("current");
  });

  it("maps completionTriggerMode from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ completionTriggerMode: "require-prefix" } as Partial<EditorSettings>));
    expect(draft.completionTriggerMode).toBe("require-prefix");
  });

  it("normalizes invalid completionTriggerMode to positional", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ completionTriggerMode: "always" as unknown } as Partial<EditorSettings>));
    expect(draft.completionTriggerMode).toBe("positional");
  });
});

describe("normalizeTableOpenPageSizeDraft", () => {
  it.each([
    [200000, 200000],
    [2000000, 1000000],
    [0, 100],
    [-1, 100],
    ["123.9", 123],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    ["not-a-number", 100],
    [500, 500],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeTableOpenPageSizeDraft(value)).toBe(expected);
  });
});

describe("normalizeQueryResultMaxRowsDraft", () => {
  it.each([
    [250000, 250000],
    [0, 1],
    [2147483648, 2147483647],
    [Number.NaN, 100000],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeQueryResultMaxRowsDraft(value)).toBe(expected);
  });
});

describe("editorSettingsDraftChanged", () => {
  it("detects change in continueOnErrorOnBatch", () => {
    const settings = makeSettings({ continueOnErrorOnBatch: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.continueOnErrorOnBatch = true;
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects no change when continueOnErrorOnBatch matches", () => {
    const settings = makeSettings({ continueOnErrorOnBatch: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    expect(editorSettingsDraftChanged(draft, base)).toBe(false);
  });

  it("compares the normalized table-open page size", () => {
    const settings = makeSettings({ tableOpenPageSize: 100 });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.tableOpenPageSize = Number.NaN;
    expect(editorSettingsDraftChanged(draft, base)).toBe(false);
  });

  it("detects a saved SQL open target change", () => {
    const settings = makeSettings({ savedSqlOpenTargetMode: "saved" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.savedSqlOpenTargetMode = "current";
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects a data-tab reuse mode change", () => {
    const settings = makeSettings({ dataTabReuseMode: "same-table" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.dataTabReuseMode = "active-tab";
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects adjacent data-tab opening changes", () => {
    const settings = makeSettings({ openDataTabsNextToActive: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.openDataTabsNextToActive = true;
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects completionTriggerMode change", () => {
    const settings = makeSettings({ completionTriggerMode: "positional" } as Partial<EditorSettings>);
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.completionTriggerMode = "manual";
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects no change when completionTriggerMode matches", () => {
    const settings = makeSettings({ completionTriggerMode: "require-prefix" } as Partial<EditorSettings>);
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    expect(editorSettingsDraftChanged(draft, base)).toBe(false);
  });
});

describe("editorSettingsPatchFromDraft", () => {
  it("applies, cancels, and re-enables the cell detail button visibility", () => {
    const visible = editorSettingsDraftFromSettings(makeSettings({ dataGridCellDetailButtonVisible: true }));
    const hidden = editorSettingsDraftFromSettings(makeSettings({ dataGridCellDetailButtonVisible: false }));

    expect(editorSettingsPatchFromDraft(hidden, visible)).toEqual({ dataGridCellDetailButtonVisible: false });
    expect(editorSettingsPatchFromDraft(visible, visible)).toEqual({});
    expect(editorSettingsPatchFromDraft(visible, hidden)).toEqual({ dataGridCellDetailButtonVisible: true });
  });

  it("includes the multi-statement default view when changed", () => {
    const result = editorSettingsDraftFromSettings(makeSettings({ multiStatementDefaultView: "result" }));
    const summary = editorSettingsDraftFromSettings(makeSettings({ multiStatementDefaultView: "summary" }));

    expect(editorSettingsPatchFromDraft(summary, result)).toEqual({ multiStatementDefaultView: "summary" });
  });

  it("includes continueOnErrorOnBatch in patch when changed", () => {
    const settings = makeSettings({ continueOnErrorOnBatch: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.continueOnErrorOnBatch = true;
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.continueOnErrorOnBatch).toBe(true);
  });

  it("omits continueOnErrorOnBatch when unchanged", () => {
    const settings = makeSettings({ continueOnErrorOnBatch: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.continueOnErrorOnBatch).toBeUndefined();
  });

  it("writes the normalized table-open page size", () => {
    const settings = makeSettings({ tableOpenPageSize: 100 });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.tableOpenPageSize = 200000.9;
    expect(editorSettingsPatchFromDraft(draft, base).tableOpenPageSize).toBe(200000);
  });

  it("includes the saved SQL open target when changed", () => {
    const settings = makeSettings({ savedSqlOpenTargetMode: "saved" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.savedSqlOpenTargetMode = "current";
    expect(editorSettingsPatchFromDraft(draft, base).savedSqlOpenTargetMode).toBe("current");
  });

  it("includes the data-tab reuse mode when changed", () => {
    const settings = makeSettings({ dataTabReuseMode: "same-table" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.dataTabReuseMode = "always-new";
    expect(editorSettingsPatchFromDraft(draft, base).dataTabReuseMode).toBe("always-new");
  });

  it("includes adjacent data-tab opening when changed", () => {
    const settings = makeSettings({ openDataTabsNextToActive: false });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.openDataTabsNextToActive = true;
    expect(editorSettingsPatchFromDraft(draft, base).openDataTabsNextToActive).toBe(true);
  });

  it("includes completionTriggerMode in patch when changed", () => {
    const settings = makeSettings({ completionTriggerMode: "positional" } as Partial<EditorSettings>);
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.completionTriggerMode = "manual";
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.completionTriggerMode).toBe("manual");
  });

  it("omits completionTriggerMode when unchanged", () => {
    const settings = makeSettings({ completionTriggerMode: "require-prefix" } as Partial<EditorSettings>);
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.completionTriggerMode).toBeUndefined();
  });
});

describe("EDITOR_SETTINGS_DRAFT_KEYS - tabLayout", () => {
  it("includes tabLayout", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("tabLayout");
  });
});

describe("editorSettingsDraftFromSettings - tabLayout", () => {
  it("maps tabLayout from settings", () => {
    expect(editorSettingsDraftFromSettings(makeSettings({ tabLayout: "wrap" })).tabLayout).toBe("wrap");
    expect(editorSettingsDraftFromSettings(makeSettings({ tabLayout: "scroll" })).tabLayout).toBe("scroll");
  });
});

describe("editorSettingsDraftChanged - tabLayout", () => {
  it("detects change in tabLayout", () => {
    const settings = makeSettings({ tabLayout: "scroll" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.tabLayout = "wrap";
    expect(editorSettingsDraftChanged(draft, base)).toBe(true);
  });

  it("detects no change when tabLayout matches", () => {
    const settings = makeSettings({ tabLayout: "wrap" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    expect(editorSettingsDraftChanged(draft, base)).toBe(false);
  });
});

describe("shouldConfirmEditorSettingsDialogClose", () => {
  // Regression for https://github.com/t8y2/dbx/issues/5905: customizing a
  // shortcut or the sidebar activation mode and then dismissing the dialog
  // via Escape/outside-click/the "Close" button (anything other than Apply)
  // must not silently drop the draft.
  it("requests confirmation when the dialog is closing with an unsaved shortcut/sidebarActivation edit", () => {
    const settings = makeSettings({ sidebarActivation: "single" } as Partial<EditorSettings>);
    const base = editorSettingsDraftFromSettings(settings);
    const draft = editorSettingsDraftFromSettings(settings);
    draft.sidebarActivation = "double";

    expect(shouldConfirmEditorSettingsDialogClose(false, editorSettingsDraftChanged(draft, base))).toBe(true);
  });

  it("does not block closing when there is no unsaved draft", () => {
    const settings = makeSettings();
    const base = editorSettingsDraftFromSettings(settings);
    const draft = editorSettingsDraftFromSettings(settings);

    expect(shouldConfirmEditorSettingsDialogClose(false, editorSettingsDraftChanged(draft, base))).toBe(false);
  });

  it("never blocks opening the dialog, even with a stale dirty flag", () => {
    expect(shouldConfirmEditorSettingsDialogClose(true, true)).toBe(false);
  });
});

describe("editorSettingsPatchFromDraft - tabLayout", () => {
  it("includes tabLayout in patch when changed", () => {
    const settings = makeSettings({ tabLayout: "scroll" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    draft.tabLayout = "wrap";
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.tabLayout).toBe("wrap");
  });

  it("omits tabLayout when unchanged", () => {
    const settings = makeSettings({ tabLayout: "scroll" });
    const draft = editorSettingsDraftFromSettings(settings);
    const base = editorSettingsDraftFromSettings(settings);
    const patch = editorSettingsPatchFromDraft(draft, base);
    expect(patch.tabLayout).toBeUndefined();
  });
});
