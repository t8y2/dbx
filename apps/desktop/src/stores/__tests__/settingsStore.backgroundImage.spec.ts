import { describe, expect, it } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings } from "@/stores/settingsStore";
import { defaultBackgroundImageSettings } from "@/lib/app/appBackgroundImage";

describe("normalizeEditorSettings backgroundImage", () => {
  it("merges default background image settings for legacy configs missing the field", () => {
    const normalized = normalizeEditorSettings({ fontFamily: "'Fira Code', monospace" } as never);
    expect(normalized.backgroundImage).toEqual(defaultBackgroundImageSettings());
    expect(normalized.fontFamily).toBe("'Fira Code', monospace");
  });

  it("keeps configured background image values and clamps invalid ones", () => {
    const normalized = normalizeEditorSettings({
      backgroundImage: { filePath: "/data/background-image.jpg", fileName: "a.jpg", opacity: 0.4, blur: 6, displayMode: "tile" },
    } as never);
    expect(normalized.backgroundImage).toEqual({ filePath: "/data/background-image.jpg", fileName: "a.jpg", opacity: 0.4, blur: 6, displayMode: "tile" });

    const clamped = normalizeEditorSettings({ backgroundImage: { opacity: 12, blur: -1 } } as never);
    expect(clamped.backgroundImage.opacity).toBe(1);
    expect(clamped.backgroundImage.blur).toBe(0);
  });

  it("drops unknown fields from stored settings (showOn* from the removed scoped mode)", () => {
    const normalized = normalizeEditorSettings({
      backgroundImage: { filePath: "/data/background-image.jpg", fileName: "a.jpg", opacity: 0.5, blur: 0, showOnWelcome: true, showOnEditor: true },
    } as never);
    expect(normalized.backgroundImage).toEqual({ filePath: "/data/background-image.jpg", fileName: "a.jpg", opacity: 0.5, blur: 0, displayMode: "fill" });
  });

  it("uses default settings for a brand-new store baseline", () => {
    expect(DEFAULT_EDITOR_SETTINGS.backgroundImage).toEqual(defaultBackgroundImageSettings());
  });
});
