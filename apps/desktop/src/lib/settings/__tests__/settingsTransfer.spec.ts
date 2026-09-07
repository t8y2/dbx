import { describe, expect, it } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@/stores/settingsStore";
import { EDITOR_SETTINGS_DRAFT_KEYS } from "../editorSettingsDraft";
import { buildSettingsTransferFilename, collectTransferCategories, parseSettingsTransferFile, serializeSettingsTransfer, SETTINGS_TRANSFER_FORMAT_VERSION, transferCategoryForKey } from "../settingsTransfer";

function fileWith(editor: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: SETTINGS_TRANSFER_FORMAT_VERSION,
    app: { name: "dbx", version: "1.2.3" },
    exportedAt: "2026-09-06T00:00:00.000Z",
    settings: { editor },
    ...overrides,
  });
}

describe("settingsTransfer", () => {
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

  it("rejects pass-through boolean flags with non-boolean values", () => {
    const result = parseSettingsTransferFile(fileWith({ wordWrap: "yes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.detail).toContain("wordWrap");
  });

  it("rejects toolbar items whose known keys are not booleans", () => {
    const result = parseSettingsTransferFile(fileWith({ toolbarItems: { dataTransfer: "yes" } }));
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
    expect(transferCategoryForKey("notARealSetting")).toBeUndefined();
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
    } as EditorSettings;
    const result = parseSettingsTransferFile(serializeSettingsTransfer(settings));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.editorSettings.pageSize).toBe(200);
    expect(result.value.editorSettings.snippets).toEqual(settings.snippets);
  });
});
