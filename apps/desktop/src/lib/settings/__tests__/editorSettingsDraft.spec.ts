import { describe, expect, it } from "vitest";
import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, editorSettingsDraftChanged, editorSettingsPatchFromDraft, normalizeTableOpenPageSizeDraft } from "../editorSettingsDraft";
import type { EditorSettings } from "@/stores/settingsStore";

function makeSettings(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return {
    autoCalculateTotalRows: false,
    pageSize: 100,
    tableOpenPageSize: 100,
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
    objectBrowserViewMode: "list",
    sqlVariableSyntaxOverrides: {},
    tabLayout: "scroll",
    ...overrides,
  };
}

describe("EDITOR_SETTINGS_DRAFT_KEYS", () => {
  it("includes continueOnErrorOnBatch", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("continueOnErrorOnBatch");
  });

  it("includes the table-open page size", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("tableOpenPageSize");
  });
});

describe("editorSettingsDraftFromSettings", () => {
  it("maps continueOnErrorOnBatch from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ continueOnErrorOnBatch: true }));
    expect(draft.continueOnErrorOnBatch).toBe(true);
  });

  it("maps continueOnErrorOnBatch=false from settings", () => {
    const draft = editorSettingsDraftFromSettings(makeSettings({ continueOnErrorOnBatch: false }));
    expect(draft.continueOnErrorOnBatch).toBe(false);
  });

  it("preserves the table-open default for legacy settings", () => {
    const settings = makeSettings();
    delete (settings as Partial<EditorSettings>).tableOpenPageSize;
    expect(editorSettingsDraftFromSettings(settings).tableOpenPageSize).toBe(100);
  });
});

describe("normalizeTableOpenPageSizeDraft", () => {
  it.each([
    [200000, 100000],
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
    expect(editorSettingsPatchFromDraft(draft, base).tableOpenPageSize).toBe(100000);
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
