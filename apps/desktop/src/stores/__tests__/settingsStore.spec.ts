import { describe, expect, it } from "vitest";
import { normalizeEditorSettings } from "@/stores/settingsStore";

describe("normalizeEditorSettings", () => {
  it("enables automatic table aliases by default", () => {
    expect(normalizeEditorSettings({}).autoAliasTables).toBe(true);
  });

  it("preserves disabled automatic table aliases", () => {
    expect(normalizeEditorSettings({ autoAliasTables: false }).autoAliasTables).toBe(false);
  });

  it("enables SQL semantic diagnostics by default", () => {
    expect(normalizeEditorSettings({}).sqlSemanticDiagnosticsEnabled).toBe(true);
  });

  it("preserves disabled SQL semantic diagnostics", () => {
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsEnabled: false }).sqlSemanticDiagnosticsEnabled).toBe(false);
  });

  it("defaults update downloads to the official source", () => {
    expect(normalizeEditorSettings({}).updateDownloadSource).toBe("official");
  });

  it("preserves CNB update download source and rejects invalid values", () => {
    expect(normalizeEditorSettings({ updateDownloadSource: "cnb" }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "mirror" as any }).updateDownloadSource).toBe("official");
  });
});
