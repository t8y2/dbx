import { describe, expect, it } from "vitest";
import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, editorSettingsDraftChanged, editorSettingsPatchFromDraft, normalizeQueryResultMaxRowsDraft, normalizeTableOpenPageSizeDraft } from "../editorSettingsDraft";
import type { EditorSettings } from "@/stores/settingsStore";

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

  it("includes data grid type colors", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("colorizeDataGridCellTypes");
  });

  it("includes completionTriggerMode", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("completionTriggerMode");
  });
});

describe("editorSettingsDraftFromSettings", () => {
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
