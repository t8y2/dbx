import { describe, expect, it } from "vitest";
import { createExportTranslate, EXPORT_LOCALES } from "../exportTranslate";

describe("createExportTranslate", () => {
  it("carries every locale the app ships", () => {
    expect(Object.keys(EXPORT_LOCALES).sort()).toEqual(["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"]);
  });

  it("resolves a nested key under the docs prefix", () => {
    expect(createExportTranslate("en")("docs.columns")).toBe("Columns");
    expect(createExportTranslate("en")("docs.warnings.orphanedNotes.title")).toBe("Some notes no longer match anything");
  });

  it("substitutes placeholders", () => {
    expect(createExportTranslate("en")("docs.shadowedComment", { comment: "hi" })).toBe("Database comment: hi");
  });

  it("falls back to English for an unknown locale", () => {
    // A hand-edited payload, or a --lang that slipped through, must render
    // English rather than raw keys in a file someone opens offline.
    expect(createExportTranslate("kl" as never)("docs.columns")).toBe("Columns");
  });

  it("returns the key when nothing resolves", () => {
    expect(createExportTranslate("en")("docs.nope.missing")).toBe("docs.nope.missing");
  });
});
