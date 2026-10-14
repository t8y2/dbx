import { describe, expect, it } from "vitest";
import { cssFontFamilyForName, DEFAULT_MONO_FALLBACK_FONTS, DEFAULT_MONO_FONT_FAMILY, FONT_FAMILIES, LEGACY_PRESET_FONT_MAP, normalizeCustomFontFamilyInput, readableFontFamily } from "../appFonts";
import { displayFontFamily, isPresetFontFamily } from "../fontFamilyOptions";

describe("appFonts", () => {
  it("includes CJK fallbacks in DEFAULT_MONO_FALLBACK_FONTS", () => {
    expect(DEFAULT_MONO_FALLBACK_FONTS).toContain("PingFang SC");
    expect(DEFAULT_MONO_FALLBACK_FONTS).toContain("Hiragino Sans GB");
    expect(DEFAULT_MONO_FALLBACK_FONTS).toContain("Microsoft YaHei");
    expect(DEFAULT_MONO_FALLBACK_FONTS).toMatch(/monospace$/);
  });

  it("appends CJK fallbacks to DEFAULT_MONO_FONT_FAMILY", () => {
    expect(DEFAULT_MONO_FONT_FAMILY).toContain("'Fira Code'");
    expect(DEFAULT_MONO_FONT_FAMILY).toContain(DEFAULT_MONO_FALLBACK_FONTS);
  });

  it("appends CJK fallbacks to every preset font family", () => {
    for (const preset of FONT_FAMILIES) {
      expect(preset.value).toContain(DEFAULT_MONO_FALLBACK_FONTS);
    }
  });

  it("maps legacy preset values to updated stacks with CJK fallbacks", () => {
    expect(LEGACY_PRESET_FONT_MAP["'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace"]).toBe(DEFAULT_MONO_FONT_FAMILY);
    expect(LEGACY_PRESET_FONT_MAP["'JetBrains Mono', 'Fira Code', monospace"]).toContain(DEFAULT_MONO_FALLBACK_FONTS);
    expect(LEGACY_PRESET_FONT_MAP["'Consolas', 'Courier New', monospace"]).toContain(DEFAULT_MONO_FALLBACK_FONTS);
    expect(LEGACY_PRESET_FONT_MAP["monospace"]).toBe(DEFAULT_MONO_FALLBACK_FONTS);
  });

  it("constructs CSS font family for system font name with CJK fallbacks", () => {
    expect(cssFontFamilyForName("Ubuntu Mono")).toBe(`'Ubuntu Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`);
    expect(cssFontFamilyForName("JetBrains Mono")).toBe(`'JetBrains Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`);
    expect(cssFontFamilyForName("Font's Name")).toBe(`'Font\\'s Name', ${DEFAULT_MONO_FALLBACK_FONTS}`);
  });

  it("extracts readable font family name from font stacks", () => {
    expect(readableFontFamily(DEFAULT_MONO_FONT_FAMILY)).toBe("Fira Code");
    expect(readableFontFamily(`'JetBrains Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`)).toBe("JetBrains Mono");
    expect(readableFontFamily("Consolas")).toBe("Consolas");
  });

  it("normalizes custom font family input", () => {
    expect(normalizeCustomFontFamilyInput("")).toBe("");
    expect(normalizeCustomFontFamilyInput("   ")).toBe("");
    expect(normalizeCustomFontFamilyInput("Hack")).toBe(`'Hack', ${DEFAULT_MONO_FALLBACK_FONTS}`);
    // Custom font stacks with quotes or commas are preserved verbatim
    expect(normalizeCustomFontFamilyInput("'My Custom Font', monospace")).toBe("'My Custom Font', monospace");
    expect(normalizeCustomFontFamilyInput("Fira Code, PingFang SC, monospace")).toBe("Fira Code, PingFang SC, monospace");
  });

  it("recognizes preset font labels for both current and legacy preset values", () => {
    expect(displayFontFamily(DEFAULT_MONO_FONT_FAMILY)).toBe("Fira Code");
    expect(displayFontFamily(DEFAULT_MONO_FALLBACK_FONTS)).toBe("System Monospace");

    // Legacy preset values
    expect(displayFontFamily("'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace")).toBe("Fira Code");
    expect(displayFontFamily("'JetBrains Mono', 'Fira Code', monospace")).toBe("JetBrains Mono");
    expect(displayFontFamily("monospace")).toBe("System Monospace");

    // Custom font fallback
    expect(displayFontFamily("'My Font', monospace")).toBe("My Font");
  });

  it("identifies preset font values for both current and legacy presets", () => {
    expect(isPresetFontFamily(DEFAULT_MONO_FONT_FAMILY)).toBe(true);
    expect(isPresetFontFamily(DEFAULT_MONO_FALLBACK_FONTS)).toBe(true);
    expect(isPresetFontFamily("'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace")).toBe(true);
    expect(isPresetFontFamily("monospace")).toBe(true);
    expect(isPresetFontFamily("'Unknown Font', monospace")).toBe(false);
  });
});
