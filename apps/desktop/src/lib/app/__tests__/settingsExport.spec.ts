import { describe, expect, it } from "vitest";
import { parseSettingsExport, serializeSettingsExport, settingsExportFileName, SETTINGS_EXPORT_SCHEMA_VERSION, stripSensitiveSettings } from "@/lib/app/settingsExport";

const exportedAt = new Date("2026-10-20T04:12:33.000Z");

describe("settings export", () => {
  it("writes a versioned envelope with the exported settings", () => {
    const text = serializeSettingsExport({ editorSettings: { fontSize: 15, theme: "dark" }, exportedAt });
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(SETTINGS_EXPORT_SCHEMA_VERSION);
    expect(parsed.exportedAt).toBe("2026-10-20T04:12:33.000Z");
    expect(parsed.editorSettings).toEqual({ fontSize: 15, theme: "dark" });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("never writes credentials to the plaintext file", () => {
    const text = serializeSettingsExport({
      editorSettings: {
        fontSize: 15,
        aiApiKey: "sk-should-not-be-exported",
        nested: { providerToken: "secret-token", keep: 1 },
        list: [{ password: "p", label: "keep" }],
      } as never,
      exportedAt,
    });
    expect(text).not.toContain("sk-should-not-be-exported");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain('"p"');
    const parsed = JSON.parse(text);
    expect(parsed.editorSettings).toEqual({ fontSize: 15, nested: { keep: 1 }, list: [{ label: "keep" }] });
  });

  it("drops undefined values instead of writing nulls", () => {
    const parsed = JSON.parse(serializeSettingsExport({ editorSettings: { fontSize: 14, theme: undefined } as never, exportedAt }));
    expect(parsed.editorSettings).toEqual({ fontSize: 14 });
  });

  it("builds a Windows-safe file name", () => {
    expect(settingsExportFileName(exportedAt)).toBe("dbx-settings-2026-10-20T04-12-33.000Z.json");
  });

  it("round-trips a file it wrote", () => {
    const text = serializeSettingsExport({ editorSettings: { fontSize: 16, tabSize: 4 }, exportedAt });
    expect(parseSettingsExport(text)).toEqual({ ok: true, settings: { fontSize: 16, tabSize: 4 } });
  });

  it("rejects input that is not a settings file", () => {
    expect(parseSettingsExport("   ")).toEqual({ ok: false, code: "empty" });
    expect(parseSettingsExport("{")).toEqual({ ok: false, code: "invalidJson" });
    expect(parseSettingsExport("[]")).toEqual({ ok: false, code: "notAnObject" });
    expect(parseSettingsExport(JSON.stringify({ editorSettings: {} }))).toEqual({ ok: false, code: "missingSchemaVersion" });
    expect(parseSettingsExport(JSON.stringify({ schemaVersion: 1 }))).toEqual({ ok: false, code: "missingEditorSettings" });
  });

  it("refuses a file written by a newer build instead of dropping its settings", () => {
    const text = JSON.stringify({ schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION + 1, editorSettings: { fontSize: 18 } });
    expect(parseSettingsExport(text)).toEqual({ ok: false, code: "unsupportedSchemaVersion", schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION + 1 });
  });

  it("leaves non-sensitive primitives and arrays untouched", () => {
    expect(stripSensitiveSettings(7)).toBe(7);
    expect(stripSensitiveSettings("text")).toBe("text");
    expect(stripSensitiveSettings([1, { password: "x", keep: true }])).toEqual([1, { keep: true }]);
  });
});
