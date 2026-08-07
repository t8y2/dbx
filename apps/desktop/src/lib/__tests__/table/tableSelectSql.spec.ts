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

describe("qualifiedTableName — SQLite attached databases", () => {
  it("qualifies tables with the attached database alias", () => {
    expect(qualifiedTableName({ databaseType: "sqlite", schema: "analytics", tableName: "events" })).toBe('"analytics"."events"');
  });
});

describe("qualifiedTableName — GBase 8s", () => {
  it("omits the metadata owner for GBase 8s table data", () => {
    expect(qualifiedTableName({ databaseType: "informix", driverProfile: "gbase8s", identifierQuote: "", schema: "gbasedbt", tableName: "connection_smoke" })).toBe("connection_smoke");
    expect(quoteTableDataIdentifier("informix", "connection_smoke", "")).toBe("connection_smoke");
  });

  it("keeps native Informix owner qualification", () => {
    expect(qualifiedTableName({ databaseType: "informix", identifierQuote: "", schema: "gbasedbt", tableName: "connection_smoke" })).toBe("gbasedbt.connection_smoke");
  });
});

describe("quoteTableIdentifier", () => {
  it("backtick-quotes mysql identifiers", () => {
    expect(quoteTableIdentifier("mysql", "orders")).toBe("`orders`");
  });

  it("uses BigQuery quoted identifiers and escape sequences", () => {
    expect(quoteTableIdentifier("bigquery", "order")).toBe("`order`");
    expect(quoteTableIdentifier("bigquery", "a`b")).toBe("`a\\`b`");
  });

  it("bracket-quotes sqlserver identifiers", () => {
    expect(quoteTableIdentifier("sqlserver", "orders")).toBe("[orders]");
  });

  it("uses the connection-reported quote for Kingbase table-data identifiers", () => {
    expect(quoteTableDataIdentifier("kingbase", "order", "`")).toBe("`order`");
    expect(quoteTableDataIdentifier("kingbase", "MixedCase", '"')).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("kingbase", "order detail", "`")).toBe("`order detail`");
  });

  it("selectively quotes GaussDB JDBC identifiers with the driver-reported quote", () => {
    expect(quoteTableDataIdentifier("gaussdb", "table_01", '"')).toBe("table_01");
    expect(quoteTableDataIdentifier("gaussdb", "MixedCase", '"')).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("gaussdb", "order", '"')).toBe('"order"');
    expect(quoteTableDataIdentifier("gaussdb", "order detail", '"')).toBe('"order detail"');
    expect(quoteTableDataIdentifier("gaussdb", 'already"quoted', '"')).toBe('"already""quoted"');
    expect(quoteTableDataIdentifier("gaussdb", '"AlreadyQuoted"', '"')).toBe('"AlreadyQuoted"');

    expect(quoteTableDataIdentifier("gaussdb", "table_01", "`")).toBe("table_01");
    expect(quoteTableDataIdentifier("gaussdb", "MixedCase", "`")).toBe("`MixedCase`");
    expect(quoteTableDataIdentifier("gaussdb", "order", "`")).toBe("`order`");
    expect(quoteTableDataIdentifier("gaussdb", "order detail", "`")).toBe("`order detail`");
    expect(quoteTableDataIdentifier("gaussdb", "already`quoted", "`")).toBe("`already``quoted`");
    expect(quoteTableDataIdentifier("gaussdb", "`AlreadyQuoted`", "`")).toBe("`AlreadyQuoted`");
  });

  it("uses detected GaussDB compatibility quotes through PostgreSQL-compatible JDBC dialects", () => {
    for (const databaseType of ["postgres", "opengauss"] as const) {
      expect(quoteTableDataIdentifier(databaseType, "table_01", "`")).toBe("table_01");
      expect(quoteTableDataIdentifier(databaseType, "MixedCase", "`")).toBe("`MixedCase`");
      expect(quoteTableDataIdentifier(databaseType, "order", "`")).toBe("`order`");
      expect(quoteTableDataIdentifier(databaseType, "order detail", "`")).toBe("`order detail`");
      expect(quoteTableDataIdentifier(databaseType, "`AlreadyQuoted`", "`")).toBe("`AlreadyQuoted`");
      expect(quoteTableDataIdentifier(databaseType, "MixedCase", '"')).toBe('"MixedCase"');
    }
  });

  it("preserves native GaussDB and openGauss quoting behavior", () => {
    expect(quoteTableDataIdentifier("gaussdb", "table_01")).toBe('"table_01"');
    expect(quoteTableDataIdentifier("gaussdb", "MixedCase")).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("gaussdb", '"AlreadyQuoted"')).toBe('"AlreadyQuoted"');
    expect(quoteTableDataIdentifier("opengauss", "table_01")).toBe('"table_01"');
    expect(quoteTableDataIdentifier("opengauss", "MixedCase")).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("opengauss", '"AlreadyQuoted"')).toBe('"AlreadyQuoted"');
  });

  it("escapes Kingbase identifiers without maintaining a reserved-word list", () => {
    expect(quoteTableDataIdentifier("kingbase", "ANALYZE", "`")).toBe("`ANALYZE`");
    expect(quoteTableDataIdentifier("kingbase", "AUTHORIZATION", '"')).toBe('"AUTHORIZATION"');
    expect(quoteTableDataIdentifier("kingbase", "COLLATE", "`")).toBe("`COLLATE`");
    expect(quoteTableDataIdentifier("kingbase", "a`b", "`")).toBe("`a``b`");
  });
});
