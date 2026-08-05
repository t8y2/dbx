import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, normalizeDataGridCopyPreference, normalizeDataGridExtractorOptions, resolveDataGridCopyPreference, validateDataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";

describe("data-grid extractor options", () => {
  it("resolves smart copy to raw for one cell and TSV otherwise", () => {
    expect(normalizeDataGridCopyPreference(undefined)).toBe("smart");
    expect(normalizeDataGridCopyPreference("smart")).toBe("smart");
    expect(resolveDataGridCopyPreference("smart", 1)).toBe("raw");
    expect(resolveDataGridCopyPreference("smart", 2)).toBe("tsv");
    expect(resolveDataGridCopyPreference("csv", 1)).toBe("csv");
  });

  it("normalizes persisted values without sharing the default object", () => {
    const normalized = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);

    expect(normalized).toEqual(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    expect(normalized).not.toBe(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    expect(normalized.dsv).not.toBe(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv);
  });

  it("rejects overlapping effective row and column separators", () => {
    const options = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    options.dsv.rowSeparator = ",";

    expect(validateDataGridExtractorOptions("csv", options)).toBe("separators-overlap");
  });

  it("rejects an empty custom separator before normalization can hide it", () => {
    const options = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    options.dsv.columnSeparator = "";

    expect(validateDataGridExtractorOptions("dsv", options)).toBe("column-separator-empty");
  });

  it("requires exactly one Unicode quote character", () => {
    const options = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    options.dsv.quote = "🙂";
    expect(validateDataGridExtractorOptions("one-row", options)).toBeNull();

    options.dsv.quote = "''";
    expect(validateDataGridExtractorOptions("one-row", options)).toBe("invalid-quote");
  });

  it("normalizes and validates separator and null-text limits by Unicode code point", () => {
    const columnSeparator = "🙂".repeat(5);
    const nullText = "🧊".repeat(40);
    const normalized = normalizeDataGridExtractorOptions({
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      dsv: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv, columnSeparator, nullText },
    });

    expect(normalized.dsv.columnSeparator).toBe(columnSeparator);
    expect(normalized.dsv.nullText).toBe(nullText);
    expect(validateDataGridExtractorOptions("dsv", normalized)).toBeNull();
  });

  it("rejects quote conflicts, control quotes, and oversized values", () => {
    const options = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    options.dsv.quote = ",";
    expect(validateDataGridExtractorOptions("csv", options)).toBe("quote-conflicts");

    options.dsv.quote = "\n";
    expect(validateDataGridExtractorOptions("one-row", options)).toBe("invalid-quote");

    options.dsv.quote = '"';
    options.dsv.nullText = "x".repeat(65);
    expect(validateDataGridExtractorOptions("dsv", options)).toBe("null-text-too-long");
  });
});
