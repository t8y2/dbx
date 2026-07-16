import { describe, expect, it } from "vitest";
import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, editorSettingsDraftChanged, editorSettingsPatchFromDraft } from "../editorSettingsDraft";
import type { EditorSettings } from "@/stores/settingsStore";

function makeSettings(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return {
    autoCalculateTotalRows: false,
    pageSize: 100,
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
    ...overrides,
  };
}

describe("EDITOR_SETTINGS_DRAFT_KEYS", () => {
  it("includes continueOnErrorOnBatch", () => {
    expect(EDITOR_SETTINGS_DRAFT_KEYS).toContain("continueOnErrorOnBatch");
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
});
