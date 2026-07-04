import { describe, expect, it } from "vitest";
import { normalizeDesktopSettings, normalizeEditorSettings } from "@/stores/settingsStore";

describe("normalizeEditorSettings", () => {
  it("enables automatic table aliases by default", () => {
    expect(normalizeEditorSettings({}).autoAliasTables).toBe(true);
  });

  it("preserves disabled automatic table aliases", () => {
    expect(normalizeEditorSettings({ autoAliasTables: false }).autoAliasTables).toBe(false);
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

  it("preserves mirror update download sources and rejects invalid values", () => {
    expect(normalizeEditorSettings({ updateDownloadSource: "cnb" }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "atomgit" }).updateDownloadSource).toBe("atomgit");
    expect(normalizeEditorSettings({ updateDownloadSource: "mirror" as any }).updateDownloadSource).toBe("official");
  });

  it("defaults data grid search to row filtering and preserves highlight mode", () => {
    expect(normalizeEditorSettings({}).dataGridSearchMode).toBe("filter");
    expect(normalizeEditorSettings({ dataGridSearchMode: "highlight" }).dataGridSearchMode).toBe("highlight");
    expect(normalizeEditorSettings({ dataGridSearchMode: "invalid" as any }).dataGridSearchMode).toBe("filter");
  });
});

describe("normalizeDesktopSettings", () => {
  it("defaults DuckDB worker process isolation to disabled for old settings", () => {
    expect(normalizeDesktopSettings({}).duckdb_worker_process_isolation).toBe(false);
  });
});
