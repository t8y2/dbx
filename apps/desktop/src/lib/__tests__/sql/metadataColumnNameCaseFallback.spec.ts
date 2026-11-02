import { describe, expect, it } from "vitest";
import { resolveMetadataColumnName } from "@/lib/sql/sqlAnalysis";

/**
 * Dialect folding (Oracle-compatible -> upper case, PostgreSQL-compatible ->
 * lower case) is only an assumption about how the server stores an unquoted
 * identifier. Dameng keeps the case the identifier was created with, so a table
 * created as `(id int primary key, name varchar(50))` reports lowercase columns
 * while the analyzer folds the query's `name` to `NAME` (issue #10233). The
 * folded spelling must stay the primary answer, and a case-only match is only a
 * rescue when it identifies exactly one column.
 */
describe("metadata column name resolution tolerates server-preserved casing", () => {
  it("rescues a lowercase dameng column when the folded spelling does not exist", () => {
    expect(resolveMetadataColumnName("dameng", "name", false, ["id", "name", "amount"])).toBe("name");
  });

  it("still prefers the folded spelling when the server stored upper case", () => {
    expect(resolveMetadataColumnName("dameng", "name", false, ["ID", "NAME"])).toBe("NAME");
  });

  it("rescues a PostgreSQL-compatible engine that reports an upper-case column", () => {
    expect(resolveMetadataColumnName("highgo", "label", false, ["ID", "LABEL"])).toBe("LABEL");
  });

  it("keeps PostgreSQL lower-case folding unchanged", () => {
    expect(resolveMetadataColumnName("highgo", "Label", false, ["id", "label"])).toBe("label");
  });

  it("refuses a case-only match that is ambiguous", () => {
    expect(resolveMetadataColumnName("dameng", "value", false, ["value", "Value"])).toBeUndefined();
  });

  it("keeps quoted identifiers exact", () => {
    expect(resolveMetadataColumnName("dameng", "name", true, ["NAME"])).toBeUndefined();
    expect(resolveMetadataColumnName("dameng", "NAME", true, ["NAME"])).toBe("NAME");
  });
});
