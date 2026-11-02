import { describe, expect, it } from "vitest";
import { DATABASE_TYPES } from "@/types/generated/databaseTypes";
import { foldUnquotedPostgresMetadataIdentifier, POSTGRES_FOLDED_IDENTIFIER_TYPES } from "@/lib/sql/sqlAnalysis";

/**
 * Grid saves re-quote the table identity that the query result carried. On
 * PostgreSQL-compatible engines an unquoted identifier only resolves after the
 * server folds it to lower case, so the folded spelling is the one the save
 * must use (issue #10567: `UPDATE term."MSS_CHECK_SALES_ITEM"` fails against a
 * table stored as `mss_check_sales_item` while the unquoted SELECT worked).
 *
 * The polarity is locked over the full DATABASE_TYPES enum: every listed
 * PostgreSQL-compatible member folds, every unlisted member must NOT fold —
 * engines such as Kingbase (Oracle-compat mode) fold in the opposite direction
 * and would break if they were silently swept into the lower-case set.
 */
describe("foldUnquotedPostgresMetadataIdentifier", () => {
  it("folds unquoted identifiers to lower case for every listed PostgreSQL-compatible type", () => {
    expect(POSTGRES_FOLDED_IDENTIFIER_TYPES.size).toBeGreaterThan(0);
    for (const databaseType of POSTGRES_FOLDED_IDENTIFIER_TYPES) {
      expect(DATABASE_TYPES).toContain(databaseType);
      expect(foldUnquotedPostgresMetadataIdentifier(databaseType, "MSS_CHECK_SALES_ITEM", false)).toBe("mss_check_sales_item");
      expect(foldUnquotedPostgresMetadataIdentifier(databaseType, "Term", false)).toBe("term");
      // Already-lower-case identifiers are unchanged, quoted ones stay exact.
      expect(foldUnquotedPostgresMetadataIdentifier(databaseType, "mss_check_sales_item", false)).toBe("mss_check_sales_item");
      expect(foldUnquotedPostgresMetadataIdentifier(databaseType, "MSS_CHECK_SALES_ITEM", true)).toBe("MSS_CHECK_SALES_ITEM");
    }
  });

  it("never folds members outside the PostgreSQL-compatible set", () => {
    const outside = DATABASE_TYPES.filter((databaseType) => !POSTGRES_FOLDED_IDENTIFIER_TYPES.has(databaseType));
    expect(outside).toEqual(expect.arrayContaining(["mysql", "oracle", "sqlserver", "jdbc", "kingbase", "dameng", "saphana", "duckdb"]));
    for (const databaseType of outside) {
      expect(foldUnquotedPostgresMetadataIdentifier(databaseType, "MSS_CHECK_SALES_ITEM", false)).toBe("MSS_CHECK_SALES_ITEM");
    }
  });

  it("keeps every enum member classified as either folding or deliberately untouched", () => {
    for (const databaseType of DATABASE_TYPES) {
      const folded = foldUnquotedPostgresMetadataIdentifier(databaseType, "Mixed_Case", false);
      expect([folded === "mixed_case", folded === "Mixed_Case"]).toContain(true);
    }
  });

  it("passes through missing identifiers so caller fallbacks survive", () => {
    expect(foldUnquotedPostgresMetadataIdentifier("postgres", undefined, false)).toBeUndefined();
    expect(foldUnquotedPostgresMetadataIdentifier("postgres", "", false)).toBe("");
  });
});
