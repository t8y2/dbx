import { describe, expect, it } from "vitest";
import { qualifiedTableName, quoteTableDataIdentifier, quoteTableIdentifier } from "@/lib/table/tableSelectSql";

describe("qualifiedTableName — Doris/StarRocks multi-catalog", () => {
  it("prefixes external catalog for Doris (no schema)", () => {
    expect(qualifiedTableName({ databaseType: "doris", catalog: "iceberg_catalog", tableName: "orders" })).toBe("`iceberg_catalog`.`orders`");
  });

  it("prefixes external catalog for Doris (with schema)", () => {
    expect(qualifiedTableName({ databaseType: "doris", catalog: "iceberg_catalog", schema: "sales", tableName: "orders" })).toBe("`iceberg_catalog`.`sales`.`orders`");
  });

  it("prefixes external catalog for StarRocks", () => {
    expect(qualifiedTableName({ databaseType: "starrocks", catalog: "hive_catalog", tableName: "orders" })).toBe("`hive_catalog`.`orders`");
  });

  it("treats the internal catalog as no catalog", () => {
    expect(qualifiedTableName({ databaseType: "doris", catalog: "internal", tableName: "orders" })).toBe("`orders`");
  });

  it("omits the catalog for non-Doris engines", () => {
    // MySQL has no 3-part catalog naming; the catalog must be ignored.
    expect(qualifiedTableName({ databaseType: "mysql", catalog: "iceberg_catalog", tableName: "orders" })).toBe("`orders`");
  });

  it("escapes embedded backticks in catalog and table identifiers", () => {
    expect(qualifiedTableName({ databaseType: "doris", catalog: "a`b", schema: "c`d", tableName: "e`f" })).toBe("`a``b`.`c``d`.`e``f`");
  });
});

describe("quoteTableIdentifier", () => {
  it("backtick-quotes mysql identifiers", () => {
    expect(quoteTableIdentifier("mysql", "orders")).toBe("`orders`");
  });

  it("bracket-quotes sqlserver identifiers", () => {
    expect(quoteTableIdentifier("sqlserver", "orders")).toBe("[orders]");
  });

  it("uses the connection-reported quote for Kingbase table-data identifiers", () => {
    expect(quoteTableDataIdentifier("kingbase", "order", "`")).toBe("`order`");
    expect(quoteTableDataIdentifier("kingbase", "MixedCase", '"')).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("kingbase", "order detail", "`")).toBe("`order detail`");
  });

  it("escapes Kingbase identifiers without maintaining a reserved-word list", () => {
    expect(quoteTableDataIdentifier("kingbase", "ANALYZE", "`")).toBe("`ANALYZE`");
    expect(quoteTableDataIdentifier("kingbase", "AUTHORIZATION", '"')).toBe('"AUTHORIZATION"');
    expect(quoteTableDataIdentifier("kingbase", "COLLATE", "`")).toBe("`COLLATE`");
    expect(quoteTableDataIdentifier("kingbase", "a`b", "`")).toBe("`a``b`");
  });
});
