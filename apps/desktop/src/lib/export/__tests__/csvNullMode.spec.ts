import { describe, expect, it } from "vitest";
import { csvNullLiteralForMode, DEFAULT_CSV_NULL_LITERAL, DEFAULT_CSV_NULL_MODE, normalizeCsvNullMode } from "@/lib/export/csvNullMode";

describe("normalizeCsvNullMode", () => {
  it("defaults to writing the NULL marker", () => {
    expect(DEFAULT_CSV_NULL_MODE).toBe("marker");
    expect(normalizeCsvNullMode(undefined)).toBe("marker");
    expect(normalizeCsvNullMode(null)).toBe("marker");
    expect(normalizeCsvNullMode("marker")).toBe("marker");
  });

  it("keeps an explicit request for the legacy empty field", () => {
    expect(normalizeCsvNullMode("empty")).toBe("empty");
  });

  it("falls back to the default for unknown values", () => {
    expect(normalizeCsvNullMode("")).toBe("marker");
    expect(normalizeCsvNullMode("\\N")).toBe("marker");
    expect(normalizeCsvNullMode(0)).toBe("marker");
  });
});

describe("csvNullLiteralForMode", () => {
  it("writes the MySQL-style NULL marker by default", () => {
    expect(csvNullLiteralForMode("marker")).toBe(DEFAULT_CSV_NULL_LITERAL);
    expect(csvNullLiteralForMode("marker")).toBe("\\N");
  });

  it("disables the literal with an empty string to restore the old export", () => {
    expect(csvNullLiteralForMode("empty")).toBe("");
  });
});
