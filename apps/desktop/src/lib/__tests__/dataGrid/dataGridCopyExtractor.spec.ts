import { describe, expect, it } from "vitest";
import {
  DATA_GRID_COPY_EXTRACTOR_IDS,
  DATA_GRID_DEFAULT_COPY_PREFERENCES,
  DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
  extractorUnavailableForDatabase,
  normalizeDataGridCopyPreference,
  normalizeDataGridExtractorOptions,
  normalizeVisibleDataGridCopyExtractors,
  resolveDataGridCopyPreference,
  validateDataGridExtractorOptions,
} from "@/lib/dataGrid/dataGridCopyExtractor";

describe("data-grid extractor options", () => {
  it("preserves native SQL defaults and normalizes portable INSERT options", () => {
    for (const legacy of [undefined, {}, { sql: {} }, { sql: { insertMode: "row-by-row" } }]) {
      expect(normalizeDataGridExtractorOptions(legacy).sql).toMatchObject({ quoteIdentifiers: true, temporalFormat: "native" });
    }
    const configured = normalizeDataGridExtractorOptions({ sql: { quoteIdentifiers: false, temporalFormat: "string" } });
    expect(configured.sql).toMatchObject({ quoteIdentifiers: false, temporalFormat: "string" });
    expect(normalizeDataGridExtractorOptions(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
    expect(normalizeDataGridExtractorOptions({ sql: { quoteIdentifiers: "false", temporalFormat: "custom" } }).sql).toMatchObject({ quoteIdentifiers: true, temporalFormat: "native" });
  });

  it("migrates the legacy primary-key flag and normalizes the explicit mode", () => {
    expect(normalizeDataGridExtractorOptions({}).sql.primaryKeyMode).toBe("include");
    expect(normalizeDataGridExtractorOptions({ sql: { excludePrimaryKeysFromInsert: true } }).sql.primaryKeyMode).toBe("exclude-generated");
    expect(normalizeDataGridExtractorOptions({ sql: { primaryKeyMode: "exclude-all" } }).sql.primaryKeyMode).toBe("exclude-all");
  });

  it("defaults to including database qualification and keeps an explicit opt-out", () => {
    expect(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql.includeDatabaseName).toBe(true);
    expect(normalizeDataGridExtractorOptions({ sql: {} }).sql.includeDatabaseName).toBe(true);
    const configured = normalizeDataGridExtractorOptions({ sql: { includeDatabaseName: false } });
    expect(configured.sql.includeDatabaseName).toBe(false);
    expect(normalizeDataGridExtractorOptions(JSON.parse(JSON.stringify(configured))).sql.includeDatabaseName).toBe(false);
    expect(normalizeDataGridExtractorOptions({ sql: { includeDatabaseName: "false" } }).sql.includeDatabaseName).toBe(true);
  });

  it("defaults DSV NULL output to an empty spreadsheet field", () => {
    expect(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.nullText).toBe("");
    expect(normalizeDataGridExtractorOptions({}).dsv.nullText).toBe("");
  });

  it("normalizes the additive CSV copy controls without changing legacy defaults", () => {
    expect(normalizeDataGridExtractorOptions({}).dsv).toMatchObject({ headerPosition: "legacy", headerFormat: "name", headerCase: "preserve", quotePolicy: "minimal", escapeFormulas: false, arrayFormat: "preserve", formatNumbers: "inherit" });
    expect(
      normalizeDataGridExtractorOptions({
        valueFormat: "edit",
        dsv: { headerPosition: "bottom", headerFormat: "both", headerCase: "upper", quotePolicy: "all-including-nulls", quoteNumericStrings: true, escapeFormulas: true, lineFeedEscapeString: "\\n", arrayFormat: "brackets", formatNumbers: "display" },
      }),
    ).toMatchObject({ valueFormat: "edit", dsv: { headerPosition: "bottom", headerFormat: "both", headerCase: "upper", quotePolicy: "all-including-nulls", quoteNumericStrings: true, escapeFormulas: true, lineFeedEscapeString: "\\n", arrayFormat: "brackets", formatNumbers: "display" } });
  });

  it("resolves smart copy to raw for one cell and TSV otherwise", () => {
    expect(normalizeDataGridCopyPreference(undefined)).toBe("smart");
    expect(normalizeDataGridCopyPreference("smart")).toBe("smart");
    expect(normalizeDataGridCopyPreference("raw")).toBe("raw");
    expect(resolveDataGridCopyPreference("smart", 1)).toBe("raw");
    expect(resolveDataGridCopyPreference("smart", 2)).toBe("tsv");
    expect(resolveDataGridCopyPreference("csv", 1)).toBe("csv");
    expect(resolveDataGridCopyPreference("raw", 3)).toBe("raw");
  });

  it("normalizes persisted values without sharing the default object", () => {
    const normalized = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);

    expect(normalized).toEqual(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    expect(normalized).not.toBe(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    expect(normalized.dsv).not.toBe(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv);
  });

  it("keeps camel-case JSON field names explicit and disabled by default", () => {
    expect(normalizeDataGridExtractorOptions({ json: {} }).json.camelCaseFieldNames).toBe(false);
    expect(normalizeDataGridExtractorOptions({ json: { camelCaseFieldNames: true } }).json.camelCaseFieldNames).toBe(true);
    expect(normalizeDataGridExtractorOptions({ json: { camelCaseFieldNames: "true" } }).json.camelCaseFieldNames).toBe(false);
  });

  it("keeps values-only JSON arrays explicit and disabled by default", () => {
    expect(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.json.valuesOnly).toBe(false);
    expect(normalizeDataGridExtractorOptions({ json: {} }).json.valuesOnly).toBe(false);
    expect(normalizeDataGridExtractorOptions({ json: { valuesOnly: true } }).json.valuesOnly).toBe(true);
    expect(normalizeDataGridExtractorOptions({ json: { valuesOnly: "true" } }).json.valuesOnly).toBe(false);
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

  it("requires PHP row delimiters to be whitespace only", () => {
    const options = normalizeDataGridExtractorOptions(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    options.php.rowDelimiter = ";";
    expect(validateDataGridExtractorOptions("php", options)).toBe("invalid-php-row-delimiter");
    options.php.rowDelimiter = "\n\t";
    expect(validateDataGridExtractorOptions("php", options)).toBeNull();
    options.php.rowDelimiter = "\u00a0";
    expect(validateDataGridExtractorOptions("php", options)).toBe("invalid-php-row-delimiter");
  });

  it("handles sql-deletes-inserts copy preference and database availability", () => {
    expect(normalizeDataGridCopyPreference("sql-deletes-inserts")).toBe("sql-deletes-inserts");
    expect(resolveDataGridCopyPreference("sql-deletes-inserts", 1)).toBe("sql-deletes-inserts");
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "postgres")).toBe(false);
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "mysql")).toBe(false);
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "sqlserver")).toBe(false);
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "mongodb")).toBe(true);
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "neo4j")).toBe(true);
    expect(extractorUnavailableForDatabase("sql-deletes-inserts", "tdengine")).toBe(true);
  });

  it("adds DbUnit and PHP without changing the extractor contract version", () => {
    expect(DATA_GRID_COPY_EXTRACTOR_IDS).toContain("dbunit");
    expect(DATA_GRID_COPY_EXTRACTOR_IDS).toContain("php");
    expect(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dbunit).toMatchObject({ upperCaseTableName: true, upperCaseColumnNames: true, includeNullValues: true, nullValueString: "[NULL]" });
    expect(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.php).toMatchObject({ arraySyntax: "short", formatDateIso: true, rowDelimiter: "\n", variableName: "" });
    expect(normalizeDataGridExtractorOptions({ php: { formatDateISO: false } }).php.formatDateIso).toBe(false);
  });

  it("normalizes visible copy formats deterministically and preserves an empty selection", () => {
    expect(normalizeVisibleDataGridCopyExtractors(undefined)).toEqual(DATA_GRID_COPY_EXTRACTOR_IDS);
    expect(normalizeVisibleDataGridCopyExtractors(undefined)).toContain("sql-select");
    expect(DATA_GRID_DEFAULT_COPY_PREFERENCES).not.toContain("sql-select");
    expect(normalizeVisibleDataGridCopyExtractors(["php", "php", "unknown", "csv"])).toEqual(["csv", "php"]);
    expect(normalizeVisibleDataGridCopyExtractors([])).toEqual([]);
  });
  it("keeps the two-row header format through normalization (#13305)", () => {
    const normalized = normalizeDataGridExtractorOptions({ extractor: "tsv-with-headers", dsv: { headerFormat: "name-and-description-two-rows" } });
    expect(normalized.dsv.headerFormat).toBe("name-and-description-two-rows");
    const rejected = normalizeDataGridExtractorOptions({ extractor: "tsv", dsv: { headerFormat: "made-up" } });
    expect(rejected.dsv.headerFormat).toBe("name");
  });
});
