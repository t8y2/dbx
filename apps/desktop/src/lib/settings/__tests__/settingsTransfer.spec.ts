import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_SETTINGS, DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@/stores/settingsStore";
import { EDITOR_SETTINGS_DRAFT_KEYS } from "../editorSettingsDraft";
import { buildSettingsTransferFilename, collectTransferCategories, parseSettingsTransferFile, pickTransferableDesktopSettings, serializeSettingsTransfer, SETTINGS_TRANSFER_FORMAT_VERSION, transferCategoryForKey } from "../settingsTransfer";

function fileWith(editor: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: SETTINGS_TRANSFER_FORMAT_VERSION,
    app: { name: "dbx", version: "1.2.3" },
    exportedAt: "2026-09-06T00:00:00.000Z",
    settings: { editor },
    ...overrides,
  });
}

function fileWithSections(sections: Record<string, unknown>): string {
  return JSON.stringify({
    formatVersion: SETTINGS_TRANSFER_FORMAT_VERSION,
    app: { name: "dbx", version: "1.2.3" },
    exportedAt: "2026-09-06T00:00:00.000Z",
    settings: sections,
  });
}

describe("settingsTransfer", () => {
  it("round-trips column comment placement as a data preference and rejects non-booleans", () => {
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, dataGridColumnCommentsInInfoArea: true, dataGridTransposeMetadataInInfoColumn: true });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.dataGridColumnCommentsInInfoArea).toBe(true);
    if (result.ok) expect(result.value.editorSettings.dataGridTransposeMetadataInInfoColumn).toBe(true);
    expect(transferCategoryForKey("dataGridTransposeMetadataInInfoColumn")).toBe("data");
    expect(transferCategoryForKey("dataGridColumnCommentsInInfoArea")).toBe("data");
    expect(parseSettingsTransferFile(fileWith({ dataGridColumnCommentsInInfoArea: "true" })).ok).toBe(false);
    expect(parseSettingsTransferFile(fileWith({ dataGridTransposeMetadataInInfoColumn: "true" })).ok).toBe(false);
  });
  it("round-trips an opt-out of comment-first result names and rejects non-booleans", () => {
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, resultTabPreferComments: false });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.resultTabPreferComments).toBe(false);
    expect(transferCategoryForKey("resultTabPreferComments")).toBe("data");
    expect(parseSettingsTransferFile(fileWith({ resultTabPreferComments: "false" })).ok).toBe(false);
  });

  it("round-trips functionCompletionIncludeParams as an editor setting and rejects non-booleans", () => {
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, functionCompletionIncludeParams: false });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.functionCompletionIncludeParams).toBe(false);
    expect(transferCategoryForKey("functionCompletionIncludeParams")).toBe("editor");
    expect(parseSettingsTransferFile(fileWith({ functionCompletionIncludeParams: "false" })).ok).toBe(false);
  });

  it("round-trips sequenceCompletionEnabled as an editor setting and rejects non-booleans", () => {
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, sequenceCompletionEnabled: false });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.sequenceCompletionEnabled).toBe(false);
    expect(transferCategoryForKey("sequenceCompletionEnabled")).toBe("editor");
    expect(parseSettingsTransferFile(fileWith({ sequenceCompletionEnabled: "false" })).ok).toBe(false);
  });

  it("round-trips the welcome page mode and rejects invalid values", () => {
    const result = parseSettingsTransferFile(fileWith({ welcomePageMode: "workspace" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.welcomePageMode).toBe("workspace");

    const invalid = parseSettingsTransferFile(fileWith({ welcomePageMode: "connections" }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.detail).toContain("welcomePageMode");
  });

  it("builds a dated transfer filename", () => {
    expect(buildSettingsTransferFilename(new Date(2026, 8, 6))).toBe("dbx-settings-2026-09-06.json");
  });

  it("round-trips the default settings through serialize and parse", () => {
    const text = serializeSettingsTransfer(DEFAULT_EDITOR_SETTINGS, { appVersion: "1.2.3" });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appVersion).toBe("1.2.3");
    expect(Object.keys(result.value.editorSettings).sort()).toEqual([...EDITOR_SETTINGS_DRAFT_KEYS].sort());
    expect(result.value.editorSettings.pageSize).toBe(DEFAULT_EDITOR_SETTINGS.pageSize);
    expect(result.value.editorSettings.snippets).toEqual(DEFAULT_EDITOR_SETTINGS.snippets);
    expect(result.value.categories).toContain("snippets");
    expect(result.value.categories).toContain("shortcuts");
  });

  it("round-trips custom model generation templates", () => {
    const settings: EditorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      modelGenerationTemplates: [{ id: "model-1", name: "GraphQL", extension: "graphql", body: "type {{class.name}} {}" }],
    };
    const result = parseSettingsTransferFile(serializeSettingsTransfer(settings));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.modelGenerationTemplates).toEqual(settings.modelGenerationTemplates);
    expect(result.value.categories).toContain("editor");
  });

  it("rejects malformed model generation templates instead of dropping them", () => {
    const missingBody = parseSettingsTransferFile(fileWith({ modelGenerationTemplates: [{ id: "broken", name: "Broken", extension: "ts" }] }));
    expect(missingBody.ok).toBe(false);
    if (!missingBody.ok) expect(missingBody.error.detail).toContain("modelGenerationTemplates");

    const duplicateIds = parseSettingsTransferFile(
      fileWith({
        modelGenerationTemplates: [
          { id: "same", name: "One", extension: "ts", body: "one" },
          { id: "same", name: "Two", extension: "ts", body: "two" },
        ],
      }),
    );
    expect(duplicateIds.ok).toBe(false);
  });

  it("keeps connection timeout ownership out of the payload", () => {
    const text = serializeSettingsTransfer(DEFAULT_EDITOR_SETTINGS);
    expect(text).not.toContain("connectTimeoutInheritConnectionIds");
    expect(text).not.toContain("queryTimeoutInheritConnectionIds");
  });

  it("rejects invalid JSON", () => {
    const result = parseSettingsTransferFile("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-json");
  });

  it("rejects unsupported format versions", () => {
    const result = parseSettingsTransferFile(fileWith({}, { formatVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-version");
    expect(result.error.detail).toBe("99");
  });

  it("rejects wrong-typed fields", () => {
    const result = parseSettingsTransferFile(fileWith({ fontSize: "big" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-fields");
    expect(result.error.detail).toContain("fontSize");
  });

  it("rejects out-of-domain enum values", () => {
    const result = parseSettingsTransferFile(fileWith({ updateDownloadSource: "evil" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-fields");
    expect(result.error.detail).toContain("updateDownloadSource");
  });

  it("round-trips table completion schema qualification as an editor setting", () => {
    const result = parseSettingsTransferFile(fileWith({ tableCompletionSchemaQualification: "always" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.tableCompletionSchemaQualification).toBe("always");
    expect(result.value.categories).toEqual(["editor"]);

    const invalid = parseSettingsTransferFile(fileWith({ tableCompletionSchemaQualification: "sometimes" }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.detail).toContain("tableCompletionSchemaQualification");
  });

  it("rejects out-of-range numbers that the normalizer clamps", () => {
    const result = parseSettingsTransferFile(fileWith({ sidebarIndent: 99999 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-fields");
    expect(result.error.detail).toContain("sidebarIndent");
  });

  it("rejects pass-through numeric fields outside the editor font range", () => {
    const zero = parseSettingsTransferFile(fileWith({ fontSize: 0 }));
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error.detail).toContain("fontSize");

    const huge = parseSettingsTransferFile(fileWith({ fontSize: 100 }));
    expect(huge.ok).toBe(false);
  });

  it("accepts in-range fractional editor font sizes", () => {
    const result = parseSettingsTransferFile(fileWith({ fontSize: 13.5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.fontSize).toBe(13.5);
  });

  it("rejects pass-through layout enums", () => {
    const result = parseSettingsTransferFile(fileWith({ appLayout: "invalid" }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.code).toBe("invalid-fields");
    expect(result.error.detail).toContain("appLayout");
  });

  it("round-trips sidebarDensity in navigation category and rejects invalid values", () => {
    const valid = parseSettingsTransferFile(fileWith({ sidebarDensity: "compact" }));
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.value.editorSettings.sidebarDensity).toBe("compact");
    expect(valid.value.categories).toContain("navigation");

    const invalid = parseSettingsTransferFile(fileWith({ sidebarDensity: "ultra-compact" }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) return;
    expect(invalid.error.detail).toContain("sidebarDensity");
  });

  it("rejects pass-through boolean flags with non-boolean values", () => {
    const result = parseSettingsTransferFile(fileWith({ wordWrap: "yes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.detail).toContain("wordWrap");
  });

  it("transfers the column header hover tooltip preference as a data setting", () => {
    expect(transferCategoryForKey("showColumnHeaderTooltips")).toBe("data");

    const result = parseSettingsTransferFile(fileWith({ showColumnHeaderTooltips: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.showColumnHeaderTooltips).toBe(false);
    expect(result.value.categories).toContain("data");

    const rejected = parseSettingsTransferFile(fileWith({ showColumnHeaderTooltips: "no" }));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.detail).toContain("showColumnHeaderTooltips");
  });

  it("rejects toolbar items whose known keys are not booleans", () => {
    const result = parseSettingsTransferFile(fileWith({ toolbarItems: { dataTransfer: "yes" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.detail).toContain("toolbarItems");
  });

  it("rejects toolbar flags that the normalizer would coerce", () => {
    const result = parseSettingsTransferFile(fileWith({ toolbarItems: { exclusiveRightSidebarPanels: "no" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.detail).toContain("toolbarItems");
  });

  it("rejects empty active custom theme ids", () => {
    const result = parseSettingsTransferFile(fileWith({ activeCustomThemeId: "  " }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.detail).toContain("activeCustomThemeId");
  });

  it("imports only the keys present in the file", () => {
    const result = parseSettingsTransferFile(fileWith({ theme: DEFAULT_EDITOR_SETTINGS.theme }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.editorSettings)).toEqual(["theme"]);
    expect(result.value.categories).toEqual(["appearance"]);
  });

  it("round-trips persistent filter editor expansion as a data setting", () => {
    const result = parseSettingsTransferFile(fileWith({ dataGridKeepFilterEditorExpanded: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.dataGridKeepFilterEditorExpanded).toBe(true);
    expect(result.value.categories).toEqual(["data"]);
    expect(transferCategoryForKey("dataGridKeepFilterEditorExpanded")).toBe("data");
  });

  it("migrates the legacy auto-hide filter preference from older exports", () => {
    const expanded = parseSettingsTransferFile(fileWith({ dataGridAutoHideFilterBuilder: false }));
    expect(expanded.ok).toBe(true);
    if (expanded.ok) expect(expanded.value.editorSettings.dataGridKeepFilterEditorExpanded).toBe(true);

    const collapsed = parseSettingsTransferFile(fileWith({ dataGridAutoHideFilterBuilder: true }));
    expect(collapsed.ok).toBe(true);
    if (collapsed.ok) expect(collapsed.value.editorSettings.dataGridKeepFilterEditorExpanded).toBe(false);
  });

  it("ignores unknown fields instead of importing them", () => {
    const result = parseSettingsTransferFile(
      fileWith({
        theme: DEFAULT_EDITOR_SETTINGS.theme,
        notARealSetting: "injected",
        connectTimeoutInheritConnectionIds: ["conn-1"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings).not.toHaveProperty("notARealSetting");
    expect(result.value.editorSettings).not.toHaveProperty("connectTimeoutInheritConnectionIds");
  });

  it("sanitizes object fields through the store normalizer", () => {
    const result = parseSettingsTransferFile(fileWith({ shortcuts: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.shortcuts).toEqual(DEFAULT_EDITOR_SETTINGS.shortcuts);
  });

  it("rejects files without importable settings", () => {
    const result = parseSettingsTransferFile(fileWith({ notARealSetting: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("empty-settings");
  });

  it("rejects oversized files", () => {
    const result = parseSettingsTransferFile("x".repeat(5 * 1024 * 1024 + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too-large");
  });

  it("maps every whitelisted key to a display category", () => {
    for (const key of EDITOR_SETTINGS_DRAFT_KEYS) {
      expect(transferCategoryForKey(key), key).toBeDefined();
    }
    expect(transferCategoryForKey("ddlOpenMode")).toBe("editor");
    expect(transferCategoryForKey("notARealSetting")).toBeUndefined();
  });

  it("round-trips the wallpaper settings under the appearance category", () => {
    const settings: EditorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      backgroundImage: { ...DEFAULT_EDITOR_SETTINGS.backgroundImage, filePath: "/data/background-image.png", fileName: "wall.png", opacity: 0.42 },
    };
    const result = parseSettingsTransferFile(serializeSettingsTransfer(settings));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.backgroundImage).toEqual(settings.backgroundImage);
    expect(transferCategoryForKey("backgroundImage")).toBe("appearance");
  });

  it("collects categories in display order without duplicates", () => {
    expect(collectTransferCategories(["snippets", "theme", "shortcuts", "fontFamily"])).toEqual(["appearance", "shortcuts", "snippets"]);
  });

  it("does not mutate the shared defaults while validating", () => {
    const before = JSON.stringify(DEFAULT_EDITOR_SETTINGS) as string;
    parseSettingsTransferFile(fileWith({ shortcuts: { hijacked: true }, customThemes: [{ id: "x" }] }));
    expect(JSON.stringify(DEFAULT_EDITOR_SETTINGS)).toBe(before);
  });

  it("accepts a serialized draft of arbitrary settings unchanged", () => {
    const settings = {
      ...DEFAULT_EDITOR_SETTINGS,
      theme: DEFAULT_EDITOR_SETTINGS.theme,
      pageSize: 200,
      snippets: [{ id: "s1", label: "L", prefix: "p", body: "SELECT 1", enabled: true }],
      snippetTriggerKey: "space",
    } as EditorSettings;
    const result = parseSettingsTransferFile(serializeSettingsTransfer(settings));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.pageSize).toBe(200);
    expect(result.value.editorSettings.snippets).toEqual(settings.snippets);
    expect(result.value.editorSettings.snippetTriggerKey).toBe("space");
  });

  it("round-trips table default sorting settings", () => {
    const settings = {
      ...DEFAULT_EDITOR_SETTINGS,
      tableOpenSortMode: "database",
      tableDatabaseSortDirection: "desc",
      tableLocalSortDirection: "asc",
    } as EditorSettings;
    const result = parseSettingsTransferFile(serializeSettingsTransfer(settings));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.tableOpenSortMode).toBe("database");
    expect(result.value.editorSettings.tableDatabaseSortDirection).toBe("desc");
    expect(result.value.editorSettings.tableLocalSortDirection).toBe("asc");
    expect(transferCategoryForKey("tableOpenSortMode")).toBe("data");
  });

  it("rejects custom theme items that lack id or name", () => {
    const validTheme = { ...DEFAULT_EDITOR_SETTINGS.customThemes[0] };
    const idless = parseSettingsTransferFile(fileWith({ customThemes: [{ ...validTheme, id: "" }] }));
    expect(idless.ok).toBe(false);
    if (idless.ok) return;
    expect(idless.error.detail).toContain("customThemes");

    const unnamed = parseSettingsTransferFile(fileWith({ customThemes: [{ ...validTheme, name: undefined }] }));
    expect(unnamed.ok).toBe(false);
    if (unnamed.ok) return;
    expect(unnamed.error.detail).toContain("customThemes");
  });

  it("rejects custom theme items with wrong-typed colors", () => {
    const validTheme = DEFAULT_EDITOR_SETTINGS.customThemes[0];
    const result = parseSettingsTransferFile(
      fileWith({
        customThemes: [{ ...validTheme, id: "t1", name: "T1", colors: { ...validTheme.colors, keyword: 5 } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("customThemes");
  });

  it("rejects custom theme items with wrong-typed optional background and foreground colors", () => {
    const validTheme = DEFAULT_EDITOR_SETTINGS.customThemes[0];
    const background = parseSettingsTransferFile(
      fileWith({
        customThemes: [{ ...validTheme, id: "t1", name: "T1", colors: { ...validTheme.colors, background: {} } }],
      }),
    );
    expect(background.ok).toBe(false);
    if (background.ok) return;
    expect(background.error.detail).toContain("customThemes");

    const foreground = parseSettingsTransferFile(
      fileWith({
        customThemes: [{ ...validTheme, id: "t1", name: "T1", colors: { ...validTheme.colors, foreground: 5 } }],
      }),
    );
    expect(foreground.ok).toBe(false);
  });

  it("accepts custom theme items with optional background and foreground colors", () => {
    const base = DEFAULT_EDITOR_SETTINGS.customThemes[0];
    const validTheme = { ...base, id: "t1", name: "T1", colors: { ...base.colors, background: "#282c34", foreground: "#abb2bf" } };
    const result = parseSettingsTransferFile(fileWith({ customThemes: [validTheme] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.customThemes).toEqual([validTheme]);
  });

  it("accepts custom theme items with optional UI colors", () => {
    const base = DEFAULT_EDITOR_SETTINGS.customThemes[0];
    const validTheme = {
      ...base,
      id: "t1",
      name: "T1",
      colors: {
        ...base.colors,
        background: "#282c34",
        foreground: "#abb2bf",
        activeLine: "#2c313a",
        selection: "#3e4451",
        cursor: "#528bff",
        gutterBackground: "#21252b",
        lineNumber: "#4b5263",
        matchingBracket: "#515a6b",
      },
    };
    const result = parseSettingsTransferFile(fileWith({ customThemes: [validTheme] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.customThemes).toEqual([validTheme]);
  });

  it("rejects custom theme items with wrong-typed optional UI colors", () => {
    const base = DEFAULT_EDITOR_SETTINGS.customThemes[0];
    const result = parseSettingsTransferFile(
      fileWith({
        customThemes: [{ ...base, id: "t1", name: "T1", colors: { ...base.colors, activeLine: 123 } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("customThemes");
  });

  it("rejects null custom theme items instead of crashing", () => {
    const result = parseSettingsTransferFile(fileWith({ customThemes: [null] }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.code).toBe("invalid-fields");
    expect(result.error.detail).toContain("customThemes");
  });

  it("accepts complete custom themes and data grid color schemes", () => {
    const validTheme = { ...DEFAULT_EDITOR_SETTINGS.customThemes[0], id: "t1", name: "T1" };
    const scheme = {
      id: "s1",
      name: "S1",
      colors: { integer: "#1d4ed8", numeric: "#0e7490", string: "#166534", boolean: "#c2410c", temporal: "#7e22ce", structured: "#be185d", identifier: "#92400e", binary: "#b91c1c", spatial: "#047857" },
    };
    const result = parseSettingsTransferFile(fileWith({ customThemes: [validTheme], dataGridTypeColorSchemes: [scheme] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.customThemes).toEqual([validTheme]);
    expect(result.value.editorSettings.dataGridTypeColorSchemes).toEqual([scheme]);
  });

  it("rejects data grid color schemes claiming the reserved auto id", () => {
    const result = parseSettingsTransferFile(fileWith({ dataGridTypeColorSchemes: [{ id: "auto", name: "S" }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("dataGridTypeColorSchemes");
  });

  it("rejects malformed snippet items instead of substituting defaults", () => {
    const result = parseSettingsTransferFile(fileWith({ snippets: [{}] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("snippets");
  });

  it("rejects malformed sql shortcut items", () => {
    const result = parseSettingsTransferFile(fileWith({ sqlShortcuts: [{ id: "s1" }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("sqlShortcuts");
  });

  it("rejects non-string entries in string array settings", () => {
    const redis = parseSettingsTransferFile(fileWith({ redisKeyTemplates: [5] }));
    expect(redis.ok).toBe(false);
    if (redis.ok) return;
    expect(redis.error.detail).toContain("redisKeyTemplates");

    const prefixes = parseSettingsTransferFile(fileWith({ sidebarHiddenTablePrefixes: [null] }));
    expect(prefixes.ok).toBe(false);
    if (prefixes.ok) return;
    expect(prefixes.error.detail).toContain("sidebarHiddenTablePrefixes");
  });

  it("rejects formatter settings missing a required option", () => {
    const partialFormatter: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter };
    delete partialFormatter.keywordCase;
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: partialFormatter }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("sqlFormatter");
  });

  it("rejects unknown formatter option keys", () => {
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter, layoutEngine: "dbx" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("sqlFormatter");
  });

  it("rejects an invalid value for a formatter option that is present", () => {
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter, layoutStyle: "upstream" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("sqlFormatter");
  });

  it("imports a formatter payload exported before commaPosition existed", () => {
    // Regression: v0.6.35 made the completeness check require every current
    // key, so files exported by any earlier version failed to import at all.
    const legacy: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter };
    delete legacy.commaPosition;
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: legacy }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.sqlFormatter?.commaPosition).toBe("after");
    expect(result.value.editorSettings.sqlFormatter?.keywordCase).toBe(DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase);
  });

  it("imports a formatter payload missing both post-transfer keys and defaults them", () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter };
    delete legacy.commaPosition;
    delete legacy.layoutStyle;
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: legacy }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.sqlFormatter?.layoutStyle).toBe("dbx");
    expect(result.value.editorSettings.sqlFormatter?.commaPosition).toBe("after");
  });

  it("imports a pre-custom-rules application backup without dropping existing settings", () => {
    const current = DEFAULT_EDITOR_SETTINGS.sqlFormatter;
    const oldKeys = [
      "layoutStyle",
      "keywordCase",
      "dataTypeCase",
      "functionCase",
      "identifierCase",
      "indentStyle",
      "useTabs",
      "tabWidth",
      "logicalOperatorNewline",
      "commaPosition",
      "fromClauseLayout",
      "expressionWidth",
      "linesBetweenQueries",
      "preserveEmptyLines",
      "denseOperators",
      "newlineBeforeSemicolon",
      "paramTypes",
    ];
    const legacy = Object.fromEntries(Object.entries(current).filter(([key]) => oldKeys.includes(key)));
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter: legacy }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.sqlFormatter).toMatchObject({ ...legacy, customRulesEnabled: false, selectListLayout: "vertical" });
  });

  it("preserves custom rules and a 76-column width in application backups", () => {
    const sqlFormatter = { ...DEFAULT_EDITOR_SETTINGS.sqlFormatter, customRulesEnabled: true, selectListLayout: "wrap", updateListLayout: "vertical", expressionWidth: 76 };
    const result = parseSettingsTransferFile(fileWith({ sqlFormatter }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.sqlFormatter).toEqual(sqlFormatter);
  });

  it("accepts and transfers sql variable syntax overrides with boolean flags", () => {
    const overrides = { postgres: { substitution: true }, oracle: { substitution: false } };
    const result = parseSettingsTransferFile(fileWith({ sqlVariableSyntaxOverrides: overrides }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.sqlVariableSyntaxOverrides).toEqual(overrides);
  });

  it("rejects malformed sql variable syntax overrides", () => {
    const result = parseSettingsTransferFile(fileWith({ sqlVariableSyntaxOverrides: { mysql: { positional: "yes" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("sqlVariableSyntaxOverrides");
  });

  it("rejects shortcut overrides whose known keys are not strings", () => {
    const result = parseSettingsTransferFile(fileWith({ shortcuts: { executeSql: 5 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("shortcuts");
  });

  it("maps csvQuoteMode into the data category", () => {
    expect(transferCategoryForKey("csvQuoteMode")).toBe("data");
    expect(collectTransferCategories(["csvQuoteMode", "pageSize"])).toEqual(["data"]);
  });

  it("maps csvNullMode into the data category", () => {
    expect(transferCategoryForKey("csvNullMode")).toBe("data");
    expect(collectTransferCategories(["csvNullMode", "csvQuoteMode"])).toEqual(["data"]);
  });

  it("maps queryResultExportFileNameSource into the data category (#12092)", () => {
    expect(transferCategoryForKey("queryResultExportFileNameSource")).toBe("data");
    expect(collectTransferCategories(["queryResultExportFileNameSource", "pageSize"])).toEqual(["data"]);
  });

  it("round-trips zebra row background in data category", () => {
    expect(transferCategoryForKey("dataGridZebraRowBg")).toBe("data");

    const text = serializeSettingsTransfer({
      ...DEFAULT_EDITOR_SETTINGS,
      dataGridZebraRowBg: "#232323",
    });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.dataGridZebraRowBg).toBe("#232323");
  });

  it("round-trips crosshair row and column backgrounds in data category", () => {
    expect(transferCategoryForKey("dataGridCrosshairRowBg")).toBe("data");
    expect(transferCategoryForKey("dataGridCrosshairColBg")).toBe("data");

    const text = serializeSettingsTransfer({
      ...DEFAULT_EDITOR_SETTINGS,
      dataGridCrosshairRowBg: "#232323",
      dataGridCrosshairColBg: "#343434",
    });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.dataGridCrosshairRowBg).toBe("#232323");
    expect(result.value.editorSettings.dataGridCrosshairColBg).toBe("#343434");
  });

  it("round-trips caretBrowsingEnabled in editor category (#11827)", () => {
    expect(transferCategoryForKey("caretBrowsingEnabled")).toBe("editor");
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, caretBrowsingEnabled: true });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.caretBrowsingEnabled).toBe(true);
  });

  it("round-trips aiSqlApplyTargetMode and rejects invalid values (#12438)", () => {
    expect(transferCategoryForKey("aiSqlApplyTargetMode")).toBe("editor");
    const text = serializeSettingsTransfer({ ...DEFAULT_EDITOR_SETTINGS, aiSqlApplyTargetMode: "new" });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.editorSettings.aiSqlApplyTargetMode).toBe("new");
    expect(parseSettingsTransferFile(fileWith({ aiSqlApplyTargetMode: "invalid" })).ok).toBe(false);
  });

  it("round-trips the app theme mode and desktop preferences (#13166)", () => {
    const desktopSettings = {
      show_tray_icon: false,
      icon_theme: "black",
      quit_on_close: true,
      debug_logging_enabled: true,
      metadata_cache_max_memory_mb: 128,
      duckdb_worker_process_isolation: true,
      duckdb_worker_max_processes: 8,
      sidebar_table_page_size: 500,
    };
    const text = serializeSettingsTransfer(DEFAULT_EDITOR_SETTINGS, {}, { themeMode: "dark", desktopSettings });
    const result = parseSettingsTransferFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.themeMode).toBe("dark");
    expect(result.value.desktopSettings).toEqual(desktopSettings);
    expect(result.value.categories).toContain("appearance");
    expect(result.value.categories).toContain("other");
  });

  it("imports editor-only exports without theme mode or desktop preferences", () => {
    const result = parseSettingsTransferFile(serializeSettingsTransfer(DEFAULT_EDITOR_SETTINGS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.themeMode).toBeUndefined();
    expect(result.value.desktopSettings).toEqual({});
  });

  it("imports a file that only carries the appearance and desktop sections", () => {
    const result = parseSettingsTransferFile(fileWithSections({ appearance: { themeMode: "system" }, desktop: { show_tray_icon: false } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings).toEqual({});
    expect(result.value.themeMode).toBe("system");
    expect(result.value.desktopSettings).toEqual({ show_tray_icon: false });
    expect(result.value.categories).toEqual(["appearance", "other"]);
  });

  it("rejects invalid theme modes", () => {
    const invalid = parseSettingsTransferFile(fileWithSections({ appearance: { themeMode: "blue" } }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid-fields");
      expect(invalid.error.detail).toContain("appearance.themeMode");
    }
    expect(parseSettingsTransferFile(fileWithSections({ appearance: { themeMode: "soft-dark" } })).ok).toBe(false);
  });

  it("rejects wrong-typed desktop values", () => {
    const flag = parseSettingsTransferFile(fileWithSections({ desktop: { show_tray_icon: "yes" } }));
    expect(flag.ok).toBe(false);
    if (!flag.ok) expect(flag.error.detail).toContain("show_tray_icon");

    const numeric = parseSettingsTransferFile(fileWithSections({ desktop: { metadata_cache_max_memory_mb: "128" } }));
    expect(numeric.ok).toBe(false);
  });

  it("rejects desktop values the normalizer would clamp or replace", () => {
    const clamped = parseSettingsTransferFile(fileWithSections({ desktop: { duckdb_worker_max_processes: 99 } }));
    expect(clamped.ok).toBe(false);
    if (!clamped.ok) expect(clamped.error.detail).toContain("duckdb_worker_max_processes");

    const iconTheme = parseSettingsTransferFile(fileWithSections({ desktop: { icon_theme: "blue" } }));
    expect(iconTheme.ok).toBe(false);

    const floored = parseSettingsTransferFile(fileWithSections({ desktop: { sidebar_table_page_size: 0 } }));
    expect(floored.ok).toBe(false);

    const belowMinimum = parseSettingsTransferFile(fileWithSections({ desktop: { metadata_cache_max_memory_mb: 5 } }));
    expect(belowMinimum.ok).toBe(false);
  });

  it("ignores unknown and excluded keys in the desktop section", () => {
    const result = parseSettingsTransferFile(fileWithSections({ desktop: { quit_on_close: true, driver_store_dir: "C:\\evil", close_action_prompted: true, injected: "x" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.desktopSettings).toEqual({ quit_on_close: true });
  });

  it("keeps device-specific desktop keys out of the serialized payload", () => {
    const text = serializeSettingsTransfer(
      DEFAULT_EDITOR_SETTINGS,
      {},
      {
        desktopSettings: pickTransferableDesktopSettings({ ...DEFAULT_DESKTOP_SETTINGS, driver_store_dir: "C:\\drivers", quit_on_close: true }),
      },
    );
    expect(text).not.toContain("driver_store_dir");
    expect(text).not.toContain("saved_sql_sync_dir");
    expect(text).not.toContain("close_action_prompted");
    expect(text).toContain("quit_on_close");
  });

  it("rejects non-object appearance and desktop sections", () => {
    expect(parseSettingsTransferFile(fileWithSections({ desktop: [1] })).ok).toBe(false);
    expect(parseSettingsTransferFile(fileWithSections({ appearance: "dark" })).ok).toBe(false);
  });

  it("skips the desktop section on web imports but keeps the editor payload", () => {
    const result = parseSettingsTransferFile(fileWithSections({ appearance: { themeMode: "dark" }, desktop: { show_tray_icon: false }, editor: { wordWrap: true } }), { includeDesktopSettings: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.themeMode).toBe("dark");
    expect(result.value.desktopSettings).toEqual({});
    expect(result.value.editorSettings.wordWrap).toBe(true);
    expect(result.value.categories).toContain("appearance");
    expect(result.value.categories).not.toContain("other");
  });

  it("ignores a malformed desktop section on web imports", () => {
    expect(parseSettingsTransferFile(fileWithSections({ desktop: [1], editor: { wordWrap: true } }), { includeDesktopSettings: false }).ok).toBe(true);
    expect(parseSettingsTransferFile(fileWithSections({ desktop: { show_tray_icon: "yes" }, editor: { wordWrap: true } }), { includeDesktopSettings: false }).ok).toBe(true);
  });

  it("reports an empty import when a desktop-only file is read on web", () => {
    const result = parseSettingsTransferFile(fileWithSections({ desktop: { show_tray_icon: false } }), { includeDesktopSettings: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("empty-settings");
  });
});
