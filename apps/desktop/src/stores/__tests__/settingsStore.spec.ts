import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProxy } from "vue";
import { DEFAULT_EDITOR_SETTINGS, EXECUTE_MODE_CURRENT_DEFAULT_VERSION, enforceRightSidebarPanelExclusivity, normalizeAiConfig, normalizeDesktopSettings, normalizeEditorSettings, normalizeMcpGlobalPolicy, type RightSidebarPanelState, transitionRightSidebarPanels } from "@/stores/settingsStore";
import type { AiConfigItem } from "@/types/ai";

describe("normalizeEditorSettings", () => {
  it("enables SQL variable substitution by default and only preserves booleans", () => {
    expect(normalizeEditorSettings({}).sqlVariableSubstitutionEnabled).toBe(true);
    expect(normalizeEditorSettings({ sqlVariableSubstitutionEnabled: true }).sqlVariableSubstitutionEnabled).toBe(true);
    expect(normalizeEditorSettings({ sqlVariableSubstitutionEnabled: false }).sqlVariableSubstitutionEnabled).toBe(false);
    expect(normalizeEditorSettings({ sqlVariableSubstitutionEnabled: "false" } as any).sqlVariableSubstitutionEnabled).toBe(true);
    expect(normalizeEditorSettings({ sqlVariableSubstitutionEnabled: null } as any).sqlVariableSubstitutionEnabled).toBe(true);
  });

  it("keeps the quick filter view by default and preserves fixed filter views", () => {
    expect(normalizeEditorSettings({}).dataGridFilterEditorView).toBe("quick");
    expect(normalizeEditorSettings({ dataGridFilterEditorView: "conditions" }).dataGridFilterEditorView).toBe("conditions");
    expect(normalizeEditorSettings({ dataGridFilterEditorView: "text" }).dataGridFilterEditorView).toBe("text");
    expect(normalizeEditorSettings({ dataGridFilterEditorView: "invalid" } as any).dataGridFilterEditorView).toBe("quick");
  });

  it("defaults and bounds the persisted text filter panel height", () => {
    expect(normalizeEditorSettings({}).dataGridTextFilterPanelHeight).toBe(168);
    expect(normalizeEditorSettings({ dataGridTextFilterPanelHeight: 236.4 }).dataGridTextFilterPanelHeight).toBe(236);
    expect(normalizeEditorSettings({ dataGridTextFilterPanelHeight: 20 }).dataGridTextFilterPanelHeight).toBe(96);
    expect(normalizeEditorSettings({ dataGridTextFilterPanelHeight: 900 }).dataGridTextFilterPanelHeight).toBe(420);
  });

  it("keeps data type colors disabled by default and preserves an explicit opt-in", () => {
    expect(normalizeEditorSettings({}).colorizeDataGridCellTypes).toBe(false);
    expect(normalizeEditorSettings({ colorizeDataGridCellTypes: true }).colorizeDataGridCellTypes).toBe(true);
    expect(normalizeEditorSettings({ colorizeDataGridCellTypes: false }).colorizeDataGridCellTypes).toBe(false);
  });

  it("defaults and migrates the data-tab reuse mode", () => {
    expect(normalizeEditorSettings({}).dataTabReuseMode).toBe("same-table");
    expect(normalizeEditorSettings({ dataTabReuseMode: "always-new" }).dataTabReuseMode).toBe("always-new");
    expect(normalizeEditorSettings({ dataTabReuseMode: "active-tab" }).dataTabReuseMode).toBe("active-tab");
    expect(normalizeEditorSettings({ dataTabReuseMode: "invalid" } as any).dataTabReuseMode).toBe("same-table");
    expect(normalizeEditorSettings({ reuseDataTab: false } as any).dataTabReuseMode).toBe("always-new");
    expect(normalizeEditorSettings({ reuseDataTab: true } as any).dataTabReuseMode).toBe("same-table");
  });

  it("keeps adjacent data-tab opening disabled unless explicitly enabled", () => {
    expect(normalizeEditorSettings({}).openDataTabsNextToActive).toBe(false);
    expect(normalizeEditorSettings({ openDataTabsNextToActive: true }).openDataTabsNextToActive).toBe(true);
    expect(normalizeEditorSettings({ openDataTabsNextToActive: false }).openDataTabsNextToActive).toBe(false);
    expect(normalizeEditorSettings({ openDataTabsNextToActive: "true" } as any).openDataTabsNextToActive).toBe(false);
    expect(normalizeEditorSettings({ openDataTabsNextToActive: null } as any).openDataTabsNextToActive).toBe(false);
  });

  it("keeps SQL-file save formatting disabled unless explicitly enabled", () => {
    expect(normalizeEditorSettings({}).formatSqlOnSqlFileSave).toBe(false);
    expect(normalizeEditorSettings({ formatSqlOnSqlFileSave: true }).formatSqlOnSqlFileSave).toBe(true);
    expect(normalizeEditorSettings({ formatSqlOnSqlFileSave: false }).formatSqlOnSqlFileSave).toBe(false);
    expect(normalizeEditorSettings({ formatSqlOnSqlFileSave: "true" } as any).formatSqlOnSqlFileSave).toBe(false);
    expect(normalizeEditorSettings({ formatSqlOnSqlFileSave: null } as any).formatSqlOnSqlFileSave).toBe(false);
  });

  it("defaults and bounds the regular expression match limit", () => {
    expect(normalizeEditorSettings({}).regexMaxMatchCount).toBe(1000);
    expect(normalizeEditorSettings({ regexMaxMatchCount: 2500 }).regexMaxMatchCount).toBe(2500);
    expect(normalizeEditorSettings({ regexMaxMatchCount: 99 }).regexMaxMatchCount).toBe(1000);
    expect(normalizeEditorSettings({ regexMaxMatchCount: Number.POSITIVE_INFINITY }).regexMaxMatchCount).toBe(1000);
    expect(normalizeEditorSettings({ regexMaxMatchCount: Number.NaN }).regexMaxMatchCount).toBe(1000);
  });
  it("defaults and bounds the sidebar indent and font size", () => {
    expect(normalizeEditorSettings({}).sidebarIndent).toBe(16);
    expect(normalizeEditorSettings({}).sidebarFontSize).toBe(14);
    expect(normalizeEditorSettings({ sidebarIndent: 24, sidebarFontSize: 18 }).sidebarIndent).toBe(24);
    expect(normalizeEditorSettings({ sidebarIndent: 24, sidebarFontSize: 18 }).sidebarFontSize).toBe(18);
    expect(normalizeEditorSettings({ sidebarIndent: 999, sidebarFontSize: 1 } as any).sidebarIndent).toBe(32);
    expect(normalizeEditorSettings({ sidebarIndent: 999, sidebarFontSize: 1 } as any).sidebarFontSize).toBe(9);
    expect(normalizeEditorSettings({ sidebarIndent: 1.4, sidebarFontSize: 13.6 } as any).sidebarIndent).toBe(4);
    expect(normalizeEditorSettings({ sidebarIndent: 1.4, sidebarFontSize: 13.6 } as any).sidebarFontSize).toBe(14);
  });

  it("uses inline comments by default and preserves legacy comment visibility", () => {
    expect(normalizeEditorSettings({}).sidebarObjectInfoMode).toBe("comment-inline");
    expect(normalizeEditorSettings({ sidebarObjectInfoMode: "comment-aligned" }).sidebarObjectInfoMode).toBe("comment-aligned");
    expect(normalizeEditorSettings({ sidebarObjectInfoMode: "comment-inline" }).sidebarObjectInfoMode).toBe("comment-inline");
    expect(normalizeEditorSettings({ sidebarObjectInfoMode: "comment-right" }).sidebarObjectInfoMode).toBe("comment-right");
    expect(normalizeEditorSettings({ sidebarObjectInfoMode: "size" }).sidebarObjectInfoMode).toBe("size");
    expect(normalizeEditorSettings({ sidebarTableCommentLayout: "aligned" } as any).sidebarObjectInfoMode).toBe("comment-aligned");
    expect(normalizeEditorSettings({ sidebarTableCommentLayout: "hidden" } as any).sidebarObjectInfoMode).toBe("hidden");
    expect(normalizeEditorSettings({ sidebarHideTableComments: false } as any).sidebarObjectInfoMode).toBe("comment-inline");
    expect(normalizeEditorSettings({ sidebarHideTableComments: true } as any).sidebarObjectInfoMode).toBe("hidden");
    expect(
      normalizeEditorSettings({
        sidebarHideTableComments: true,
        sidebarShowDatabaseSizes: true,
      } as any).sidebarObjectInfoMode,
    ).toBe("hidden");
    expect(normalizeEditorSettings({ sidebarShowDatabaseSizes: true } as any).sidebarObjectInfoMode).toBe("size");
    expect(normalizeEditorSettings({ sidebarObjectInfoMode: "invalid" } as any).sidebarObjectInfoMode).toBe("comment-inline");
  });

  it("hides connection notes by default and preserves an explicit opt-in", () => {
    expect(normalizeEditorSettings({}).sidebarShowConnectionNotes).toBe(false);
    expect(normalizeEditorSettings({ sidebarShowConnectionNotes: true }).sidebarShowConnectionNotes).toBe(true);
    expect(normalizeEditorSettings({ sidebarShowConnectionNotes: false }).sidebarShowConnectionNotes).toBe(false);
  });

  it("defaults SQL execution to the current statement and migrates legacy execute-all settings", () => {
    expect(normalizeEditorSettings({}).executeMode).toBe("current");
    expect(normalizeEditorSettings({ executeMode: "all" }).executeMode).toBe("current");
    expect(
      normalizeEditorSettings({
        executeMode: "all",
        executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
      }).executeMode,
    ).toBe("all");
  });

  it("keeps blank-line execute-all disabled by default and preserves an explicit opt-in", () => {
    expect(normalizeEditorSettings({}).executeAllOnBlankLine).toBe(false);
    expect(normalizeEditorSettings({ executeAllOnBlankLine: false }).executeAllOnBlankLine).toBe(false);
    expect(normalizeEditorSettings({ executeAllOnBlankLine: true }).executeAllOnBlankLine).toBe(true);
  });

  it("enables automatic table aliases by default", () => {
    expect(normalizeEditorSettings({}).autoAliasTables).toBe(true);
  });

  it("preserves disabled automatic table aliases", () => {
    expect(normalizeEditorSettings({ autoAliasTables: false }).autoAliasTables).toBe(false);
  });

  it("enables a trailing space after completion by default and preserves the opt-out", () => {
    expect(normalizeEditorSettings({}).insertSpaceAfterCompletion).toBe(true);
    expect(normalizeEditorSettings({ insertSpaceAfterCompletion: false }).insertSpaceAfterCompletion).toBe(false);
  });

  it("selects the first completion candidate by default and preserves the opt-out", () => {
    expect(normalizeEditorSettings({}).selectFirstCompletionOnOpen).toBe(true);
    expect(normalizeEditorSettings({ selectFirstCompletionOnOpen: true }).selectFirstCompletionOnOpen).toBe(true);
    expect(normalizeEditorSettings({ selectFirstCompletionOnOpen: false }).selectFirstCompletionOnOpen).toBe(false);
    expect(normalizeEditorSettings({ selectFirstCompletionOnOpen: "true" } as any).selectFirstCompletionOnOpen).toBe(true);
  });

  it("defaults sidebar connection sorting to manual order and preserves valid alphabetical modes", () => {
    expect(normalizeEditorSettings({}).sidebarConnectionSortMode).toBe("manual");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "asc" }).sidebarConnectionSortMode).toBe("asc");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "desc" }).sidebarConnectionSortMode).toBe("desc");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "invalid" as any }).sidebarConnectionSortMode).toBe("manual");
  });

  it("shows line numbers by default and preserves an explicit opt-out", () => {
    expect(normalizeEditorSettings({}).showLineNumbers).toBe(true);
    expect(normalizeEditorSettings({ showLineNumbers: false }).showLineNumbers).toBe(false);
    expect(normalizeEditorSettings({ showLineNumbers: "false" } as any).showLineNumbers).toBe(true);
  });

  it("shows the current statement frame by default", () => {
    expect(normalizeEditorSettings({}).showCurrentStatementFrame).toBe(true);
  });

  it("preserves disabled current statement frames", () => {
    expect(normalizeEditorSettings({ showCurrentStatementFrame: false }).showCurrentStatementFrame).toBe(false);
  });

  it("shows INSERT value column hints by default", () => {
    expect(normalizeEditorSettings({}).showInsertValueHints).toBe(true);
  });

  it("preserves disabled INSERT value column hints", () => {
    expect(normalizeEditorSettings({ showInsertValueHints: false }).showInsertValueHints).toBe(false);
  });

  it("keeps SQL semantic diagnostics in auto mode and disabled by default", () => {
    const settings = normalizeEditorSettings({});
    expect(settings.sqlSemanticDiagnosticsMode).toBe("auto");
    expect(settings.sqlSemanticDiagnosticsEnabled).toBe(false);
  });

  it("preserves explicit SQL semantic diagnostics modes", () => {
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsMode: "enabled" }).sqlSemanticDiagnosticsEnabled).toBe(true);
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsMode: "disabled" }).sqlSemanticDiagnosticsEnabled).toBe(false);
  });

  it("migrates legacy SQL semantic diagnostics booleans to explicit modes", () => {
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsEnabled: true } as any).sqlSemanticDiagnosticsMode).toBe("enabled");
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsEnabled: false } as any).sqlSemanticDiagnosticsMode).toBe("disabled");
  });

  it("defaults update downloads to the official source", () => {
    expect(normalizeEditorSettings({}).updateDownloadSource).toBe("official");
  });

  it("preserves explicit editor themes from saved settings", () => {
    expect(normalizeEditorSettings({ theme: "xcode" }).theme).toBe("xcode");
    expect(normalizeEditorSettings({ theme: "one-dark" }).theme).toBe("one-dark");
    expect(normalizeEditorSettings({ theme: "custom" }).theme).toBe("custom");
  });

  it("restores all open tabs on launch by default", () => {
    expect(normalizeEditorSettings({}).openTabsRestoreMode).toBe("all");
  });

  it("preserves explicit open tab restore modes", () => {
    expect(normalizeEditorSettings({ openTabsRestoreMode: "pinned" }).openTabsRestoreMode).toBe("pinned");
    expect(normalizeEditorSettings({ openTabsRestoreMode: "none" }).openTabsRestoreMode).toBe("none");
    expect(normalizeEditorSettings({ openTabsRestoreMode: "invalid" as any }).openTabsRestoreMode).toBe("all");
  });

  it("migrates legacy open tab restore booleans", () => {
    expect(normalizeEditorSettings({ restoreOpenTabsOnLaunch: false } as any).openTabsRestoreMode).toBe("none");
    expect(normalizeEditorSettings({ restoreOpenTabsOnLaunch: true } as any).openTabsRestoreMode).toBe("all");
  });

  it("keeps unsaved SQL drafts on quit by default and preserves explicit modes", () => {
    expect(normalizeEditorSettings({}).appCloseUnsavedTabsMode).toBe("keep-drafts");
    expect(normalizeEditorSettings({ appCloseUnsavedTabsMode: "prompt" }).appCloseUnsavedTabsMode).toBe("prompt");
    expect(normalizeEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" }).appCloseUnsavedTabsMode).toBe("keep-drafts");
    expect(normalizeEditorSettings({ appCloseUnsavedTabsMode: "invalid" as any }).appCloseUnsavedTabsMode).toBe("keep-drafts");
  });

  it("preserves CNB, migrates AtomGit to CNB, and rejects invalid values", () => {
    expect(normalizeEditorSettings({ updateDownloadSource: "cnb" }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "atomgit" as any }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "mirror" as any }).updateDownloadSource).toBe("official");
  });

  it("defaults data grid search to row filtering and preserves highlight mode", () => {
    expect(normalizeEditorSettings({}).dataGridSearchMode).toBe("filter");
    expect(normalizeEditorSettings({ dataGridSearchMode: "highlight" }).dataGridSearchMode).toBe("highlight");
    expect(normalizeEditorSettings({ dataGridSearchMode: "invalid" as any }).dataGridSearchMode).toBe("filter");
  });

  it("defaults the global data grid copy preference and preserves valid choices", () => {
    expect(normalizeEditorSettings({}).dataGridCopyExtractor).toBe("smart");
    expect(normalizeEditorSettings({ dataGridCopyExtractor: "smart" }).dataGridCopyExtractor).toBe("smart");
    expect(normalizeEditorSettings({ dataGridCopyExtractor: "tsv" }).dataGridCopyExtractor).toBe("tsv");
    expect(normalizeEditorSettings({ dataGridCopyExtractor: "sql-updates" }).dataGridCopyExtractor).toBe("sql-updates");
    expect(normalizeEditorSettings({ dataGridCopyExtractor: "markdown" }).dataGridCopyExtractor).toBe("markdown");
    expect(normalizeEditorSettings({ dataGridCopyExtractor: "invalid" as any }).dataGridCopyExtractor).toBe("smart");
  });

  it("normalizes persistent extractor configuration fail-fast defaults", () => {
    const defaults = normalizeEditorSettings({}).dataGridExtractorOptions;
    expect(defaults.dsv).toMatchObject({
      columnSeparator: ",",
      rowSeparator: "\n",
      quote: '"',
      quotePolicy: "minimal",
    });
    expect(defaults.sql).toMatchObject({
      skipComputedColumns: true,
      skipGeneratedColumns: true,
      insertMode: "merged",
    });

    const configured = normalizeEditorSettings({
      dataGridExtractorOptions: {
        dsv: { ...defaults.dsv, columnSeparator: "|", quotePolicy: "always" },
        sql: { ...defaults.sql, insertMode: "row-by-row" },
        json: { pretty: false },
      },
    }).dataGridExtractorOptions;
    expect(configured.dsv.columnSeparator).toBe("|");
    expect(configured.dsv.quotePolicy).toBe("always");
    expect(configured.sql.insertMode).toBe("row-by-row");
    expect(configured.json.pretty).toBe(false);
  });

  it("defaults retained result runs to tiled tabs and preserves list mode", () => {
    expect(normalizeEditorSettings({}).resultRunDisplayMode).toBe("tabs");
    expect(normalizeEditorSettings({ resultRunDisplayMode: "list" }).resultRunDisplayMode).toBe("list");
    expect(normalizeEditorSettings({ resultRunDisplayMode: "invalid" as any }).resultRunDisplayMode).toBe("tabs");
  });

  it("defaults persistent data grid view options off and preserves enabled values", () => {
    const defaults = normalizeEditorSettings({});
    expect(defaults.dataGridMultiRowTranspose).toBe(false);
    expect(defaults.dataGridHideNullColumns).toBe(false);
    expect(defaults.dataGridBooleanDisplayMode).toBe("dropdown");

    const enabled = normalizeEditorSettings({
      dataGridMultiRowTranspose: true,
      dataGridHideNullColumns: true,
      dataGridBooleanDisplayMode: "dropdown",
    });
    expect(enabled.dataGridMultiRowTranspose).toBe(true);
    expect(enabled.dataGridHideNullColumns).toBe(true);
    expect(enabled.dataGridBooleanDisplayMode).toBe("dropdown");

    const invalid = normalizeEditorSettings({
      dataGridMultiRowTranspose: "true" as any,
      dataGridHideNullColumns: 1 as any,
      dataGridBooleanDisplayMode: "invalid" as any,
    });
    expect(invalid.dataGridMultiRowTranspose).toBe(false);
    expect(invalid.dataGridHideNullColumns).toBe(false);
    expect(invalid.dataGridBooleanDisplayMode).toBe("dropdown");
  });

  it("defaults the cell detail hover button on and preserves only boolean values", () => {
    expect(normalizeEditorSettings({}).dataGridCellDetailButtonVisible).toBe(true);
    expect(normalizeEditorSettings({ dataGridCellDetailButtonVisible: true }).dataGridCellDetailButtonVisible).toBe(true);
    expect(normalizeEditorSettings({ dataGridCellDetailButtonVisible: false }).dataGridCellDetailButtonVisible).toBe(false);

    for (const invalidValue of [0, 1, "false", null]) {
      expect(normalizeEditorSettings({ dataGridCellDetailButtonVisible: invalidValue as never }).dataGridCellDetailButtonVisible).toBe(true);
    }
  });

  it("defaults the crosshair highlight off and preserves only boolean values", () => {
    expect(normalizeEditorSettings({}).dataGridCrosshairHighlight).toBe(false);
    expect(normalizeEditorSettings({ dataGridCrosshairHighlight: true }).dataGridCrosshairHighlight).toBe(true);
    expect(normalizeEditorSettings({ dataGridCrosshairHighlight: false }).dataGridCrosshairHighlight).toBe(false);

    for (const invalidValue of [0, 1, "true", null]) {
      expect(normalizeEditorSettings({ dataGridCrosshairHighlight: invalidValue as never }).dataGridCrosshairHighlight).toBe(false);
    }
  });

  it("defaults the data grid font and preserves a custom font family", () => {
    const defaultFontFamily = `"Geist Variable Tabular", "Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    expect(normalizeEditorSettings({}).tableFontFamily).toBe(defaultFontFamily);
    expect(normalizeEditorSettings({ tableFontFamily: "'IBM Plex Mono', monospace" }).tableFontFamily).toBe("'IBM Plex Mono', monospace");
    expect(normalizeEditorSettings({ tableFontFamily: "   " }).tableFontFamily).toBe(defaultFontFamily);
  });

  it("shows cell detail metadata by default and preserves collapsed state", () => {
    expect(normalizeEditorSettings({}).cellDetailMetadataCollapsed).toBe(false);
    expect(normalizeEditorSettings({ cellDetailMetadataCollapsed: true }).cellDetailMetadataCollapsed).toBe(true);
  });

  it("normalizes the global query timeout and inherited connection ids", () => {
    expect(normalizeEditorSettings({}).globalConnectTimeoutSecs).toBe(10);
    expect(normalizeEditorSettings({ globalConnectTimeoutSecs: 0 }).globalConnectTimeoutSecs).toBe(1);
    expect(normalizeEditorSettings({}).globalQueryTimeoutSecs).toBe(30);
    expect(normalizeEditorSettings({ queryTimeoutSecs: 45 } as any).globalQueryTimeoutSecs).toBe(45);
    expect(normalizeEditorSettings({ globalQueryTimeoutSecs: -1 }).globalQueryTimeoutSecs).toBe(0);
    expect(normalizeEditorSettings({ globalQueryTimeoutSecs: 301 }).globalQueryTimeoutSecs).toBe(301);
    expect(normalizeEditorSettings({ globalQueryTimeoutSecs: 3600 }).globalQueryTimeoutSecs).toBe(3600);
    expect(normalizeEditorSettings({ globalQueryTimeoutSecs: 3601 }).globalQueryTimeoutSecs).toBe(3600);
    expect(normalizeEditorSettings({ connectTimeoutInheritConnectionIds: ["one", "one", " ", "two"] }).connectTimeoutInheritConnectionIds).toEqual(["one", "two"]);
    expect(normalizeEditorSettings({ queryTimeoutInheritConnectionIds: ["one", "one", " ", "two"] }).queryTimeoutInheritConnectionIds).toEqual(["one", "two"]);
    expect(normalizeEditorSettings({}).timeoutInheritanceMigrationVersion).toBe(0);
    expect(normalizeEditorSettings({ queryTimeoutInheritanceMigrationVersion: 1 } as any).timeoutInheritanceMigrationVersion).toBe(1);
    expect(normalizeEditorSettings({ timeoutInheritanceMigrationVersion: 2 }).timeoutInheritanceMigrationVersion).toBe(2);
  });

  it("normalizes toolbar item settings from older saved settings", () => {
    const settings = normalizeEditorSettings({
      toolbarItems: {
        sqlFileTree: false,
        history: false,
      } as any,
    });

    expect(settings.toolbarItems.sqlFileTree).toBe(false);
    expect(settings.toolbarItems.history).toBe(false);
    expect(settings.toolbarItems.sqlLibrary).toBe(true);
    expect(settings.toolbarItems.exclusiveRightSidebarPanels).toBe(true);
  });

  it("preserves disabled right sidebar panel exclusivity", () => {
    expect(
      normalizeEditorSettings({
        toolbarItems: {
          exclusiveRightSidebarPanels: false,
        } as any,
      }).toolbarItems.exclusiveRightSidebarPanels,
    ).toBe(false);
  });
});

describe("right sidebar panel transitions", () => {
  const state = (overrides: Partial<RightSidebarPanelState> = {}): RightSidebarPanelState => ({
    ai: false,
    history: false,
    sqlLibrary: false,
    sqlFile: false,
    ...overrides,
  });

  it("allows multiple panels when exclusivity is disabled", () => {
    expect(transitionRightSidebarPanels(state({ ai: true }), "history", true, false)).toEqual(state({ ai: true, history: true }));
  });

  it("switches panels and allows the active panel to toggle closed", () => {
    const switched = transitionRightSidebarPanels(state({ ai: true }), "sqlLibrary", true, true);
    expect(switched).toEqual(state({ sqlLibrary: true }));
    expect(transitionRightSidebarPanels(switched, "sqlLibrary", false, true)).toEqual(state());
  });

  it("collapses synchronized multi-panel state to the preferred open panel", () => {
    expect(enforceRightSidebarPanelExclusivity(state({ ai: true, history: true, sqlFile: true }), "history")).toEqual(state({ history: true }));
  });
});

describe("normalizeDesktopSettings", () => {
  it("normalizes the metadata cache memory budget", () => {
    expect(normalizeDesktopSettings({}).metadata_cache_max_memory_mb).toBe(64);
    expect(normalizeDesktopSettings({ metadata_cache_max_memory_mb: 1 }).metadata_cache_max_memory_mb).toBe(16);
    expect(normalizeDesktopSettings({ metadata_cache_max_memory_mb: 384 }).metadata_cache_max_memory_mb).toBe(384);
    expect(normalizeDesktopSettings({ metadata_cache_max_memory_mb: 513 }).metadata_cache_max_memory_mb).toBe(64);
  });

  it("defaults DuckDB worker process isolation to disabled for old settings", () => {
    expect(normalizeDesktopSettings({}).duckdb_worker_process_isolation).toBe(false);
  });

  it("defaults DuckDB worker max processes to 4 and clamps saved values", () => {
    expect(normalizeDesktopSettings({}).duckdb_worker_max_processes).toBe(4);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 1 }).duckdb_worker_max_processes).toBe(1);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 16 }).duckdb_worker_max_processes).toBe(16);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 0 }).duckdb_worker_max_processes).toBe(1);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 32 }).duckdb_worker_max_processes).toBe(16);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 3.6 }).duckdb_worker_max_processes).toBe(4);
  });
});

describe("normalizeMcpGlobalPolicy", () => {
  it("defaults to all connections with writes allowed", () => {
    expect(normalizeMcpGlobalPolicy(undefined)).toEqual({
      readOnly: false,
      allowDangerousSql: false,
      allowedConnectionIds: null,
      configured: false,
    });
  });

  it("normalizes and deduplicates an explicit connection allowlist", () => {
    expect(
      normalizeMcpGlobalPolicy({
        readOnly: true,
        allowDangerousSql: true,
        allowedConnectionIds: [" connection-1 ", "connection-1", "", "connection-2"],
        configured: true,
      }),
    ).toEqual({
      readOnly: true,
      allowDangerousSql: true,
      allowedConnectionIds: ["connection-1", "connection-2"],
      configured: true,
    });
  });

  it("preserves an empty allowlist as deny all", () => {
    expect(normalizeMcpGlobalPolicy({ allowedConnectionIds: [] }).allowedConnectionIds).toEqual([]);
  });
});

describe("normalizeEditorSettings - continueOnErrorOnBatch", () => {
  it("defaults continueOnErrorOnBatch to false", () => {
    expect(normalizeEditorSettings({}).continueOnErrorOnBatch).toBe(false);
  });

  it("preserves enabled continueOnErrorOnBatch", () => {
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: true }).continueOnErrorOnBatch).toBe(true);
  });

  it("treats non-boolean values as false", () => {
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: "yes" } as any).continueOnErrorOnBatch).toBe(false);
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: 1 } as any).continueOnErrorOnBatch).toBe(false);
  });
});

describe("normalizeEditorSettings - clickTableNavigationTarget", () => {
  it("defaults clickTableNavigationTarget to 'data'", () => {
    expect(normalizeEditorSettings({}).clickTableNavigationTarget).toBe("data");
  });

  it("preserves explicit 'ddl' value", () => {
    expect(normalizeEditorSettings({ clickTableNavigationTarget: "ddl" }).clickTableNavigationTarget).toBe("ddl");
  });

  it("preserves explicit 'data' value", () => {
    expect(normalizeEditorSettings({ clickTableNavigationTarget: "data" }).clickTableNavigationTarget).toBe("data");
  });

  it("falls back to 'data' for invalid values", () => {
    expect(normalizeEditorSettings({ clickTableNavigationTarget: "invalid" } as any).clickTableNavigationTarget).toBe("data");
    expect(normalizeEditorSettings({ clickTableNavigationTarget: undefined } as any).clickTableNavigationTarget).toBe("data");
    expect(normalizeEditorSettings({ clickTableNavigationTarget: null } as any).clickTableNavigationTarget).toBe("data");
    expect(normalizeEditorSettings({ clickTableNavigationTarget: 123 } as any).clickTableNavigationTarget).toBe("data");
  });
});

describe("normalizeEditorSettings - completionTriggerMode", () => {
  it("defaults completionTriggerMode to positional", () => {
    expect(normalizeEditorSettings({}).completionTriggerMode).toBe("positional");
  });

  it("preserves the three valid modes", () => {
    expect(normalizeEditorSettings({ completionTriggerMode: "manual" }).completionTriggerMode).toBe("manual");
    expect(normalizeEditorSettings({ completionTriggerMode: "require-prefix" }).completionTriggerMode).toBe("require-prefix");
    expect(normalizeEditorSettings({ completionTriggerMode: "positional" }).completionTriggerMode).toBe("positional");
  });

  it("normalizes invalid values to positional", () => {
    expect(normalizeEditorSettings({ completionTriggerMode: "always" } as any).completionTriggerMode).toBe("positional");
    expect(normalizeEditorSettings({ completionTriggerMode: "" } as any).completionTriggerMode).toBe("positional");
    expect(normalizeEditorSettings({ completionTriggerMode: undefined } as any).completionTriggerMode).toBe("positional");
    expect(normalizeEditorSettings({ completionTriggerMode: null } as any).completionTriggerMode).toBe("positional");
    expect(normalizeEditorSettings({ completionTriggerMode: 123 } as any).completionTriggerMode).toBe("positional");
  });
});

describe("normalizeEditorSettings - tabLayout", () => {
  it("defaults tabLayout to scroll", () => {
    expect(normalizeEditorSettings({}).tabLayout).toBe("scroll");
  });

  it("preserves explicit scroll mode", () => {
    expect(normalizeEditorSettings({ tabLayout: "scroll" }).tabLayout).toBe("scroll");
  });

  it("preserves explicit wrap mode", () => {
    expect(normalizeEditorSettings({ tabLayout: "wrap" }).tabLayout).toBe("wrap");
  });

  it("falls back to scroll for invalid values", () => {
    expect(normalizeEditorSettings({ tabLayout: "invalid" } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: undefined } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: null } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: 123 } as any).tabLayout).toBe("scroll");
  });
});

// --- Helpers for Pinia store tests ---

function makeTestConfig(overrides: Partial<AiConfigItem> & { id: string }): AiConfigItem {
  return {
    provider: "openai",
    apiKey: "",
    authMethod: "api-key",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiStyle: "completions",
    name: overrides.id,
    ...overrides,
  } as AiConfigItem;
}

describe("settingsStore AI API key normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("trims API keys before persisting new configurations", async () => {
    const saveAiConfigItem = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      saveAiConfigItem,
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    const config = makeTestConfig({
      id: "trimmed-key",
      apiKey: " \tsecret\r\n",
    });

    await store.createAiConfig(config);

    expect(saveAiConfigItem).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "secret" }));
    expect(store.aiConfigs[0].apiKey).toBe("secret");
  });

  it("trims API keys when normalizing loaded configurations", () => {
    expect(normalizeAiConfig({ provider: "openai", apiKey: "  secret  " }).apiKey).toBe("secret");
  });

  it("normalizes OpenCode CLI path and environment settings", () => {
    expect(
      normalizeAiConfig({
        provider: "opencode-cli",
        opencodeCliPath: "  /opt/homebrew/bin/opencode  ",
        opencodeCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: null as unknown as string },
      }),
    ).toMatchObject({
      provider: "opencode-cli",
      endpoint: "",
      model: "default",
      opencodeCliPath: "/opt/homebrew/bin/opencode",
      opencodeCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: "" },
    });
  });

  it("normalizes Cursor CLI path and environment settings", () => {
    expect(
      normalizeAiConfig({
        provider: "cursor-cli",
        cursorCliPath: "  ~/.local/bin/agent  ",
        cursorCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: null as unknown as string },
      }),
    ).toMatchObject({
      provider: "cursor-cli",
      endpoint: "",
      model: "default",
      cursorCliPath: "~/.local/bin/agent",
      cursorCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: "" },
    });
  });

  it("normalizes CodeBuddy CLI path and environment settings", () => {
    expect(
      normalizeAiConfig({
        provider: "codebuddy-cli",
        codebuddyCliPath: "  ~/.local/bin/codebuddy  ",
        codebuddyCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: null as unknown as string },
      }),
    ).toMatchObject({
      provider: "codebuddy-cli",
      endpoint: "",
      model: "default",
      codebuddyCliPath: "~/.local/bin/codebuddy",
      codebuddyCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", EMPTY: "" },
    });
  });

  it("normalizes Qoder CLI path and environment settings", () => {
    expect(
      normalizeAiConfig({
        provider: "qoder-cli",
        qoderCliPath: "  ~/.local/bin/qodercli  ",
        qoderCliEnv: { QODER_PERSONAL_ACCESS_TOKEN: "token", EMPTY: null as unknown as string },
      }),
    ).toMatchObject({
      provider: "qoder-cli",
      endpoint: "",
      model: "default",
      qoderCliPath: "~/.local/bin/qodercli",
      qoderCliEnv: { QODER_PERSONAL_ACCESS_TOKEN: "token", EMPTY: "" },
    });
  });
});

describe("settingsStore MCP policy persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("rolls an optimistic policy update back when persistence fails", async () => {
    let rejectSave!: (reason?: unknown) => void;
    const saveMcpGlobalPolicy = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    vi.doMock("@/lib/backend/api", () => ({ saveMcpGlobalPolicy }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    const previous = {
      readOnly: true,
      allowDangerousSql: false,
      allowedConnectionIds: ["connection-1"],
      configured: true,
    };
    store.mcpGlobalPolicy = previous;

    const update = store.updateMcpGlobalPolicy({
      readOnly: false,
      allowedConnectionIds: [],
    });
    expect(store.mcpGlobalPolicy).toEqual({
      readOnly: false,
      allowDangerousSql: false,
      allowedConnectionIds: [],
      configured: true,
    });

    rejectSave(new Error("save failed"));
    await expect(update).rejects.toThrow("save failed");
    expect(store.mcpGlobalPolicy).toEqual(previous);
  });
});

describe("settingsStore persisted settings initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("does not treat an editor settings read failure as an empty record", async () => {
    const loadEditorSettings = vi.fn().mockRejectedValue(new Error("storage temporarily unavailable"));
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    await expect(store.initEditorSettings()).rejects.toThrow("storage temporarily unavailable");
    expect(store.isEditorSettingsLoaded).toBe(false);
    expect(saveEditorSettings).not.toHaveBeenCalled();
  });

  it("can retry editor settings initialization without losing saved values", async () => {
    const loadEditorSettings = vi.fn().mockRejectedValueOnce(new Error("storage temporarily unavailable")).mockResolvedValueOnce({
      fontSize: 17,
      theme: "xcode-dark",
      executeMode: "all",
      executeModeDefaultVersion: 1,
      updateNotificationsEnabled: false,
    });
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    await expect(store.initEditorSettings()).rejects.toThrow("storage temporarily unavailable");
    store.updateEditorSettings({ appLayout: "separated" });
    expect(saveEditorSettings).not.toHaveBeenCalled();
    await store.initEditorSettings();

    expect(store.isEditorSettingsLoaded).toBe(true);
    expect(store.editorSettings).toMatchObject({
      fontSize: 17,
      theme: "xcode-dark",
      executeMode: "all",
      updateNotificationsEnabled: false,
      appLayout: "separated",
    });
    expect(saveEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 17, theme: "xcode-dark", appLayout: "separated" }));
  });

  it("loads and persists the substitution switch without discarding syntax overrides", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue({
      sqlVariableSubstitutionEnabled: false,
      sqlVariableSyntaxOverrides: { mysql: { shell: false } },
    });
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    expect(store.editorSettings.sqlVariableSubstitutionEnabled).toBe(false);
    expect(store.editorSettings.sqlVariableSyntaxOverrides).toEqual({ mysql: { shell: false } });

    await store.updateEditorSettingsAndPersist({ sqlVariableSubstitutionEnabled: true });

    expect(store.editorSettings.sqlVariableSubstitutionEnabled).toBe(true);
    expect(store.editorSettings.sqlVariableSyntaxOverrides).toEqual({ mysql: { shell: false } });
    expect(saveEditorSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        sqlVariableSubstitutionEnabled: true,
        sqlVariableSyntaxOverrides: { mysql: { shell: false } },
      }),
    );
  });

  it("loads and persists adjacent data-tab opening", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue({ openDataTabsNextToActive: true });
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    expect(store.editorSettings.openDataTabsNextToActive).toBe(true);

    await store.updateEditorSettingsAndPersist({ openDataTabsNextToActive: false });

    expect(store.editorSettings.openDataTabsNextToActive).toBe(false);
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ openDataTabsNextToActive: false }));
  });

  it("loads, persists, and reloads the cell detail button visibility", async () => {
    let persistedSettings: Record<string, unknown> = { dataGridCellDetailButtonVisible: false };
    const loadEditorSettings = vi.fn(async () => JSON.parse(JSON.stringify(persistedSettings)));
    const saveEditorSettings = vi.fn(async (settings: Record<string, unknown>) => {
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    expect(store.editorSettings.dataGridCellDetailButtonVisible).toBe(false);
    await store.updateEditorSettingsAndPersist({ dataGridCellDetailButtonVisible: true });
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ dataGridCellDetailButtonVisible: true }));

    setActivePinia(createPinia());
    const restartedStore = useSettingsStore();
    await restartedStore.initEditorSettings();
    expect(restartedStore.editorSettings.dataGridCellDetailButtonVisible).toBe(true);
  });

  it("defaults the crosshair highlight to off, persists an opt-in, and reloads it", async () => {
    let persistedSettings: Record<string, unknown> = {};
    const loadEditorSettings = vi.fn(async () => JSON.parse(JSON.stringify(persistedSettings)));
    const saveEditorSettings = vi.fn(async (settings: Record<string, unknown>) => {
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    expect(store.editorSettings.dataGridCrosshairHighlight).toBe(false);

    await store.updateEditorSettingsAndPersist({ dataGridCrosshairHighlight: true });
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ dataGridCrosshairHighlight: true }));

    setActivePinia(createPinia());
    const restartedStore = useSettingsStore();
    await restartedStore.initEditorSettings();
    expect(restartedStore.editorSettings.dataGridCrosshairHighlight).toBe(true);
  });

  it("loads, persists, and reloads hidden query editor line numbers", async () => {
    let persistedSettings: Record<string, unknown> = { showLineNumbers: true };
    const loadEditorSettings = vi.fn(async () => JSON.parse(JSON.stringify(persistedSettings)));
    const saveEditorSettings = vi.fn(async (settings: Record<string, unknown>) => {
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    await store.updateEditorSettingsAndPersist({ showLineNumbers: false });

    expect(store.editorSettings.showLineNumbers).toBe(false);
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ showLineNumbers: false }));

    setActivePinia(createPinia());
    const restartedStore = useSettingsStore();
    await restartedStore.initEditorSettings();

    expect(restartedStore.editorSettings.showLineNumbers).toBe(false);
  });

  it("shares concurrent initialization and applies startup changes after saved settings load", async () => {
    let resolveLoad!: (value: unknown) => void;
    const loadEditorSettings = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    const firstInitialization = store.initEditorSettings();
    const secondInitialization = store.initEditorSettings();

    store.updateEditorSettings({
      appLayout: "separated",
      tabLayout: "wrap",
      uiFontFamily: "pre-load default snapshot",
    });
    expect(saveEditorSettings).not.toHaveBeenCalled();
    expect(loadEditorSettings).toHaveBeenCalledOnce();

    resolveLoad({
      appLayout: "classic",
      tabLayout: "scroll",
      uiFontFamily: "persisted font",
      toolbarItems: { ...DEFAULT_EDITOR_SETTINGS.toolbarItems, history: false },
      snippets: [{ id: "persisted", label: "Persisted", prefix: "persisted", body: "SELECT 42", enabled: true }],
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    });
    await Promise.all([firstInitialization, secondInitialization]);

    expect(store.editorSettings).toMatchObject({
      appLayout: "separated",
      tabLayout: "wrap",
      uiFontFamily: "pre-load default snapshot",
      toolbarItems: expect.objectContaining({ history: false }),
      snippets: [expect.objectContaining({ id: "persisted", body: "SELECT 42" })],
    });
    expect(saveEditorSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appLayout: "separated",
        tabLayout: "wrap",
        uiFontFamily: "pre-load default snapshot",
        toolbarItems: expect.objectContaining({ history: false }),
        snippets: [expect.objectContaining({ id: "persisted", body: "SELECT 42" })],
      }),
    );
  });

  it("atomically updates connection note visibility and supports retry", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue({ sidebarShowConnectionNotes: false });
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    saveEditorSettings.mockClear();
    saveEditorSettings.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce(undefined);

    await expect(store.updateEditorSettingsAndPersist({ sidebarShowConnectionNotes: true })).rejects.toThrow("storage unavailable");
    expect(store.editorSettings.sidebarShowConnectionNotes).toBe(false);

    await store.updateEditorSettingsAndPersist({ sidebarShowConnectionNotes: true });
    expect(store.editorSettings.sidebarShowConnectionNotes).toBe(true);
    expect(saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ sidebarShowConnectionNotes: true }));
  });
});

describe("settingsStore editor settings persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("initializes legacy settings before queueing formatter mutations", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue({
      updateDownloadSource: "atomgit",
      customColumnFormatters: {},
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    });
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    const formatter = { id: "fmt_pre_init", name: "Pre-init", template: "legacy:${value}" };

    await store.upsertCustomColumnFormatter(formatter);

    expect(loadEditorSettings).toHaveBeenCalledOnce();
    expect(saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(saveEditorSettings.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        updateDownloadSource: "cnb",
        customColumnFormatters: {},
      }),
    );
    expect(saveEditorSettings.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        updateDownloadSource: "cnb",
        customColumnFormatters: { fmt_pre_init: formatter },
      }),
    );
    expect(store.editorSettings.customColumnFormatters.fmt_pre_init).toEqual(formatter);
  });

  it("rolls back a failed atomic update and allows retry", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue({
      ignoredUpdateVersion: "",
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    });
    const saveEditorSettings = vi.fn().mockRejectedValueOnce(new Error("save failed")).mockResolvedValueOnce(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    await expect(store.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.70" })).rejects.toThrow("save failed");
    expect(store.editorSettings.ignoredUpdateVersion).toBe("");

    await store.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.70" });

    expect(store.editorSettings.ignoredUpdateVersion).toBe("0.5.70");
    expect(saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(saveEditorSettings).toHaveBeenLastCalledWith(expect.objectContaining({ ignoredUpdateVersion: "0.5.70" }));
  });

  it("loads the persisted ignored version in a new store instance", async () => {
    let persistedSettings: Record<string, unknown> = {
      ignoredUpdateVersion: "",
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    };
    const loadEditorSettings = vi.fn(async () => JSON.parse(JSON.stringify(persistedSettings)));
    const saveEditorSettings = vi.fn(async (settings: Record<string, unknown>) => {
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const firstStore = useSettingsStore();
    await firstStore.initEditorSettings();
    await firstStore.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.70" });

    setActivePinia(createPinia());
    const restartedStore = useSettingsStore();
    await restartedStore.initEditorSettings();

    expect(restartedStore.editorSettings.ignoredUpdateVersion).toBe("0.5.70");
  });

  it("serializes overlapping saves so an older snapshot cannot finish last", async () => {
    let resolveFirstSave!: () => void;
    const loadEditorSettings = vi.fn().mockResolvedValue({
      ignoredUpdateVersion: "",
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    });
    const saveEditorSettings = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstSave = resolve;
        }),
    );
    saveEditorSettings.mockResolvedValueOnce(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    const firstSave = store.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.70" });
    await vi.waitFor(() => expect(saveEditorSettings).toHaveBeenCalledOnce());
    const secondSave = store.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.71" });

    expect(saveEditorSettings).toHaveBeenCalledOnce();
    expect(store.editorSettings.ignoredUpdateVersion).toBe("0.5.70");
    resolveFirstSave();
    await Promise.all([firstSave, secondSave]);

    expect(store.editorSettings.ignoredUpdateVersion).toBe("0.5.71");
    expect(saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(saveEditorSettings.mock.calls[0][0]).toEqual(expect.objectContaining({ ignoredUpdateVersion: "0.5.70" }));
    expect(saveEditorSettings.mock.calls[1][0]).toEqual(expect.objectContaining({ ignoredUpdateVersion: "0.5.71" }));
  });

  it("does not carry a failed atomic value into an already queued unrelated save", async () => {
    let rejectFirstSave!: (error: Error) => void;
    const loadEditorSettings = vi.fn().mockResolvedValue({
      ignoredUpdateVersion: "",
      theme: "system",
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    });
    const saveEditorSettings = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstSave = reject;
        }),
    );
    saveEditorSettings.mockResolvedValueOnce(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();

    const ignoredVersionSave = store.updateEditorSettingsAndPersist({ ignoredUpdateVersion: "0.5.70" });
    await vi.waitFor(() => expect(saveEditorSettings).toHaveBeenCalledOnce());
    store.updateEditorSettings({ theme: "xcode-dark" });
    rejectFirstSave(new Error("save failed"));

    await expect(ignoredVersionSave).rejects.toThrow("save failed");
    await vi.waitFor(() => expect(saveEditorSettings).toHaveBeenCalledTimes(2));

    expect(store.editorSettings).toMatchObject({ ignoredUpdateVersion: "", theme: "xcode-dark" });
    expect(saveEditorSettings.mock.calls[1][0]).toEqual(expect.objectContaining({ ignoredUpdateVersion: "", theme: "xcode-dark" }));
  });

  it("serializes queued saves before a failed formatter delete", async () => {
    let persistedSettings: Record<string, unknown> = {
      customColumnFormatters: {
        fmt_a: { id: "fmt_a", name: "A", template: "a:${value}" },
      },
      columnFormatters: {
        first: { kind: "custom-ref", formatterId: "fmt_a" },
      },
      executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION,
    };
    const loadEditorSettings = vi.fn(async () => JSON.parse(JSON.stringify(persistedSettings)));
    const saveEditorSettings = vi.fn(async (settings: Record<string, unknown>) => {
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    saveEditorSettings.mockClear();

    let resolveFirstSave!: () => void;
    let saveCall = 0;
    saveEditorSettings.mockImplementation(async (settings: Record<string, unknown>) => {
      saveCall += 1;
      if (saveCall === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstSave = resolve;
        });
      }
      if (saveCall === 3) throw new Error("delete save failed");
      persistedSettings = JSON.parse(JSON.stringify(settings));
    });

    store.updateEditorSettings({ theme: "xcode-dark" });
    await vi.waitFor(() => expect(saveEditorSettings).toHaveBeenCalledOnce());
    store.updateEditorSettings({ resultRunDisplayMode: "list" });
    const deletePromise = store.deleteCustomColumnFormatter("fmt_a");
    const deleteRejected = expect(deletePromise).rejects.toThrow("delete save failed");

    await Promise.resolve();
    await Promise.resolve();
    expect(store.editorSettings.customColumnFormatters.fmt_a).toBeDefined();

    resolveFirstSave();
    await deleteRejected;

    expect(saveEditorSettings).toHaveBeenCalledTimes(3);
    expect(store.editorSettings.customColumnFormatters.fmt_a).toBeDefined();
    expect(store.editorSettings.columnFormatters.first).toEqual({ kind: "custom-ref", formatterId: "fmt_a" });

    setActivePinia(createPinia());
    const restartedStore = useSettingsStore();
    await restartedStore.initEditorSettings();

    expect(restartedStore.editorSettings.customColumnFormatters.fmt_a).toEqual({ id: "fmt_a", name: "A", template: "a:${value}" });
    expect(restartedStore.editorSettings.columnFormatters.first).toEqual({ kind: "custom-ref", formatterId: "fmt_a" });
  });
});

describe("settingsStore sidebar connection sort persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("persists the selected alphabetical sort mode", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue(null);
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    store.updateEditorSettings({ sidebarConnectionSortMode: "desc" });

    expect(store.editorSettings.sidebarConnectionSortMode).toBe("desc");
    expect(saveEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ sidebarConnectionSortMode: "desc" }));
    expect(isProxy(saveEditorSettings.mock.calls[0][0])).toBe(false);

    await store.persistEditorSettings();
    expect(isProxy(saveEditorSettings.mock.calls[1][0])).toBe(false);
  });

  it("persists the retained result run display mode", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue(null);
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    store.updateEditorSettings({ resultRunDisplayMode: "list" });

    expect(store.editorSettings.resultRunDisplayMode).toBe("list");
    expect(saveEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ resultRunDisplayMode: "list" }));
    expect(isProxy(saveEditorSettings.mock.calls[0][0])).toBe(false);
  });
});

describe("settingsStore regular expression match limit persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("normalizes and persists the configured match limit", async () => {
    const loadEditorSettings = vi.fn().mockResolvedValue(null);
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ loadEditorSettings, saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initEditorSettings();
    store.updateEditorSettings({ regexMaxMatchCount: 2500.4 });

    expect(store.editorSettings.regexMaxMatchCount).toBe(2500);
    expect(saveEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ regexMaxMatchCount: 2500 }));
  });
});

// --- activeModel lifecycle tests ---

describe("settingsStore activeModel lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("updateActiveModel persists the model and does not change any config isDefault", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;

    store.updateActiveModel({ configId: "c1", modelId: "model-a" });
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });

    store.updateActiveModel({ configId: "c2", modelId: "model-b" });
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });

    // 核心保障：不改变任何配置的 isDefault
    expect(store.aiConfigs[0].isDefault).toBe(true);
    expect(store.aiConfigs[1].isDefault).toBe(false);
  });

  it("setDefaultAiConfig(id) changes the fallback config without replacing the active model", async () => {
    const setDefaultAiConfig = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
      setDefaultAiConfig,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;

    store.updateActiveModel({ configId: "c1", modelId: "model-a" });
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });

    await store.setDefaultAiConfig("c2");

    expect(setDefaultAiConfig).toHaveBeenCalledWith("c2");
    expect(store.aiConfigs[0].isDefault).toBe(false);
    expect(store.aiConfigs[1].isDefault).toBe(true);
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });
  });

  it("setDefaultAiConfig does not mutate state when backend call fails", async () => {
    const error = new Error("backend error");
    const setDefaultAiConfig = vi.fn().mockRejectedValue(error);

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
      setDefaultAiConfig,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;
    store.updateActiveModel({ configId: "c1", modelId: "model-a" });

    await expect(store.setDefaultAiConfig("c2")).rejects.toThrow("backend error");

    // isDefault 不变
    expect(store.aiConfigs[0].isDefault).toBe(true);
    expect(store.aiConfigs[1].isDefault).toBe(false);
    // activeModel 不变
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });
  });

  it("reloadAiConfigs sets activeModel to null when config list is empty", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.isAiConfigLoaded = false;
    await store.reloadAiConfigs();
    expect(store.activeModel).toBeNull();
  });

  it("reloadAiConfigs points activeModel to isDefault config, not first in list", async () => {
    const configs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: false }), makeTestConfig({ id: "c2", model: "model-b", isDefault: true }), makeTestConfig({ id: "c3", model: "model-c", isDefault: false })];

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue(configs),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.isAiConfigLoaded = false;
    await store.reloadAiConfigs();
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });
  });

  it("restores the locally persisted model and per-model effort independently of legacy config fields", async () => {
    const configs = [makeTestConfig({ id: "c1", model: "", isDefault: true })];
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue(configs),
      loadAiChatSelection: vi.fn().mockResolvedValue({
        version: 1,
        active: { configId: "c1", modelId: "runtime-model" },
        effortPreferences: [
          {
            configId: "c1",
            modelId: "runtime-model",
            selection: { kind: "enum", value: "high" },
          },
        ],
      }),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.initAiConfigs();

    expect(store.activeModel).toEqual({
      configId: "c1",
      modelId: "runtime-model",
    });
    expect(store.activeEffort).toEqual({ kind: "enum", value: "high" });
  });

  it("does not invent an active model when the first saved provider has no legacy model", async () => {
    const saveAiChatSelection = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      saveAiConfigItem: vi.fn().mockResolvedValue(undefined),
      saveAiChatSelection,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.createAiConfig(makeTestConfig({ id: "c1", model: "", isDefault: true }));

    expect(store.activeModel).toBeNull();
    expect(saveAiChatSelection).not.toHaveBeenCalled();
  });

  it("clears the active model and effort when an existing config changes provider", async () => {
    const saveAiConfigItem = vi.fn().mockResolvedValue(undefined);
    const saveAiChatSelection = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      saveAiConfigItem,
      saveAiChatSelection,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.aiConfigs = [makeTestConfig({ id: "c1", provider: "openai", model: "" })];
    store.updateActiveModel({ configId: "c1", modelId: "gpt-5" });
    store.updateActiveEffort({ kind: "enum", value: "high" });

    await store.updateAiConfigItem("c1", { provider: "gemini" });
    await vi.waitFor(() =>
      expect(saveAiChatSelection).toHaveBeenLastCalledWith({
        version: 1,
        active: undefined,
        effortPreferences: [],
        defaultMode: "ask",
      }),
    );

    expect(saveAiConfigItem).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", provider: "gemini" }));
    expect(store.activeModel).toBeNull();
    expect(store.activeEffort).toBeNull();
  });

  it("preserves the active model and effort when connection details change within the same provider", async () => {
    const saveAiConfigItem = vi.fn().mockResolvedValue(undefined);
    const saveAiChatSelection = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      saveAiConfigItem,
      saveAiChatSelection,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.aiConfigs = [makeTestConfig({ id: "c1", provider: "openai", model: "" })];
    store.updateActiveModel({ configId: "c1", modelId: "gpt-5" });
    store.updateActiveEffort({ kind: "enum", value: "high" });

    await store.updateAiConfigItem("c1", {
      endpoint: "https://gateway.example/v1",
    });

    expect(saveAiConfigItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "c1",
        endpoint: "https://gateway.example/v1",
      }),
    );
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "gpt-5" });
    expect(store.activeEffort).toEqual({ kind: "enum", value: "high" });
  });

  it("serializes rapid model and effort persistence without allowing an older snapshot to win", async () => {
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const saveAiChatSelection = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      saveAiChatSelection,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.updateActiveModel({ configId: "c1", modelId: "model-a" });
    store.updateActiveEffort({ kind: "enum", value: "high" });

    expect(saveAiChatSelection).toHaveBeenCalledTimes(1);
    releaseFirstSave();
    await vi.waitFor(() => expect(saveAiChatSelection).toHaveBeenCalledTimes(2));

    expect(saveAiChatSelection.mock.calls[1][0]).toEqual({
      version: 1,
      active: { configId: "c1", modelId: "model-a" },
      effortPreferences: [
        {
          configId: "c1",
          modelId: "model-a",
          selection: { kind: "enum", value: "high" },
        },
      ],
      defaultMode: "ask",
    });
  });

  it("clears stale in-memory AI configs and selections when a reload returns no configs", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.aiConfigs = [makeTestConfig({ id: "stale", model: "stale-model", isDefault: true })];
    store.activeModel = { configId: "stale", modelId: "stale-model" };
    store.isAiConfigLoaded = false;

    await store.reloadAiConfigs();

    expect(store.aiConfigs).toEqual([]);
    expect(store.activeModel).toBeNull();
  });
});

// --- defaultAiMode lifecycle tests ---

describe("settingsStore defaultAiMode lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("falls back to Ask when the saved chat selection has no defaultMode", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    await store.initAiConfigs();

    expect(store.defaultAiMode).toBe("ask");
  });

  it("restores Agent from the saved chat selection", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue({ version: 1, effortPreferences: [], defaultMode: "agent" }),
      saveAiChatSelection: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    await store.initAiConfigs();

    expect(store.defaultAiMode).toBe("agent");
  });

  it("setDefaultAiMode updates state and persists the mode", async () => {
    const saveAiChatSelection = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      loadAiChatSelection: vi.fn().mockResolvedValue(null),
      saveAiChatSelection,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.isAiConfigLoaded = true;

    store.setDefaultAiMode("agent");
    expect(store.defaultAiMode).toBe("agent");

    await vi.waitFor(() => expect(saveAiChatSelection).toHaveBeenCalled());
    expect(saveAiChatSelection.mock.calls[0][0]).toMatchObject({ defaultMode: "agent" });
  });
});
