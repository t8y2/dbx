import { describe, expect, it } from "vitest";
import { qualifiedTableName, quoteTableIdentifier } from "@/lib/table/tableSelectSql";

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

  it("leaves safe Kingbase identifiers unquoted across compatibility modes", () => {
    expect(quoteTableIdentifier("kingbase", "cqbq_ls")).toBe("cqbq_ls");
    expect(quoteTableIdentifier("kingbase", "actionlogs")).toBe("actionlogs");
    expect(qualifiedTableName({ databaseType: "kingbase", schema: "cqbq_ls", tableName: "actionlogs" })).toBe("cqbq_ls.actionlogs");
  });

  it("still quotes Kingbase reserved or non-simple identifiers", () => {
    expect(quoteTableIdentifier("kingbase", "order")).toBe('"order"');
    expect(quoteTableIdentifier("kingbase", "MixedCase")).toBe('"MixedCase"');
    expect(quoteTableIdentifier("kingbase", "order detail")).toBe('"order detail"');
  });
});
