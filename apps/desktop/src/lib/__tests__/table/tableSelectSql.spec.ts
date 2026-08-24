import { describe, expect, it } from "vitest";
import { qualifiedTableName, qualifyTableReferencesInSql, quoteTableDataIdentifier, quoteTableIdentifier } from "@/lib/table/tableSelectSql";

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

describe("qualifiedTableName — optional database qualification", () => {
  it("keeps MySQL table references unchanged unless enabled", () => {
    expect(qualifiedTableName({ databaseType: "mysql", database: "analytics", tableName: "events" })).toBe("`events`");
    expect(qualifiedTableName({ databaseType: "mysql", database: "analytics", tableName: "events", includeDatabaseName: true })).toBe("`analytics`.`events`");
  });

  it("uses the dialect's identifier quoting for database-qualified names", () => {
    expect(qualifiedTableName({ databaseType: "clickhouse", database: "a`b", tableName: "c`d", includeDatabaseName: true })).toBe("`a``b`.`c``d`");
  });

  it("uses MySQL-compatible quoting for GoldenDB", () => {
    expect(qualifiedTableName({ databaseType: "goldendb", database: "a`b", tableName: "c`d", includeDatabaseName: true })).toBe("`a``b`.`c``d`");
  });
});

describe("qualifyTableReferencesInSql", () => {
  it("qualifies FROM and JOIN sources while preserving aliases", () => {
    expect(
      qualifyTableReferencesInSql("SELECT * FROM apis AS ap JOIN users AS u ON u.id = ap.user_id", {
        databaseType: "mysql",
        database: "aaa",
        includeDatabaseName: true,
      }),
    ).toBe("SELECT * FROM `aaa`.`apis` AS ap JOIN `aaa`.`users` AS u ON u.id = ap.user_id");
  });

  it("qualifies every source in a multi-line LEFT JOIN query", () => {
    const sql = "SELECT `u`.`id`, `g`.`group_name`\nFROM `users` AS `u`\nLEFT JOIN `group_users` AS `gu` ON `gu`.`user_id` = `u`.`id`\nLEFT JOIN `groups` AS `g` ON `g`.`id` = `gu`.`group_id`\nLEFT JOIN `user_roles` AS `ur` ON `ur`.`user_id` = `u`.`id`";
    const result = qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true });
    expect(result).toContain("FROM `aaa`.`users` AS `u`");
    expect(result).toContain("LEFT JOIN `aaa`.`group_users` AS `gu`");
    expect(result).toContain("LEFT JOIN `aaa`.`groups` AS `g`");
    expect(result).toContain("LEFT JOIN `aaa`.`user_roles` AS `ur`");
  });

  it("leaves already-qualified sources unchanged", () => {
    const options = { databaseType: "mysql" as const, database: "aaa", includeDatabaseName: true };
    expect(qualifyTableReferencesInSql("SELECT * FROM `aaa`.`apis`", options)).toBe("SELECT * FROM `aaa`.`apis`");
  });

  it("qualifies physical tables inside CTEs but never CTE references", () => {
    const sql = "WITH users AS (SELECT * FROM archived_users)\nSELECT * FROM users";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("WITH users AS (SELECT * FROM `aaa`.`archived_users`)\nSELECT * FROM users");
  });

  it("preserves CTE references when the statement has a trailing semicolon", () => {
    const sql = "WITH users AS (SELECT * FROM archived_users) SELECT * FROM users;";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("WITH users AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM users;");
  });

  it("keeps CTE visibility scoped to each statement", () => {
    const sql = "WITH users AS (SELECT * FROM archived_users) SELECT * FROM users; WITH roles AS (SELECT * FROM archived_roles) SELECT * FROM roles;";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("WITH users AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM users; WITH roles AS (SELECT * FROM `aaa`.`archived_roles`) SELECT * FROM roles;");
  });

  it("does not treat a later CTE name as visible inside an earlier CTE", () => {
    const sql = "WITH first AS (SELECT * FROM second), second AS (SELECT * FROM archived_users) SELECT * FROM first";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("WITH first AS (SELECT * FROM `aaa`.`second`), second AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM first");
  });

  it("does not leak a nested CTE name into the outer query", () => {
    const sql = "SELECT * FROM (WITH users AS (SELECT * FROM archived_users) SELECT * FROM users) nested JOIN users ON 1 = 1";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("SELECT * FROM (WITH users AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM users) nested JOIN `aaa`.`users` ON 1 = 1");
  });

  it("keeps outer CTEs visible inside nested WITH queries", () => {
    const sql = "WITH users AS (SELECT * FROM archived_users) SELECT * FROM (WITH roles AS (SELECT * FROM users) SELECT * FROM roles) nested";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("WITH users AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM (WITH roles AS (SELECT * FROM users) SELECT * FROM roles) nested");
  });

  it("does not let a nested CTE suppress an earlier outer physical table", () => {
    const sql = "SELECT * FROM users WHERE EXISTS (WITH users AS (SELECT * FROM archived_users) SELECT * FROM users)";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("SELECT * FROM `aaa`.`users` WHERE EXISTS (WITH users AS (SELECT * FROM `aaa`.`archived_users`) SELECT * FROM users)");
  });

  it("does not rewrite FROM and JOIN text inside literals or comments", () => {
    const sql = "SELECT 'FROM users JOIN groups' AS note\nFROM users -- JOIN groups";
    expect(qualifyTableReferencesInSql(sql, { databaseType: "mysql", database: "aaa", includeDatabaseName: true })).toBe("SELECT 'FROM users JOIN groups' AS note\nFROM `aaa`.`users` -- JOIN groups");
  });

  it("uses GoldenDB's MySQL-compatible identifier quoting", () => {
    expect(qualifyTableReferencesInSql("SELECT * FROM users", { databaseType: "goldendb", database: "aaa", includeDatabaseName: true })).toBe("SELECT * FROM `aaa`.`users`");
  });
});

describe("qualifiedTableName — SQLite attached databases", () => {
  it("qualifies tables with the attached database alias", () => {
    expect(qualifiedTableName({ databaseType: "sqlite", schema: "analytics", tableName: "events" })).toBe('"analytics"."events"');
  });
});

describe("qualifiedTableName — schema-aware JDBC profiles", () => {
  it("qualifies Phoenix tables without forcing identifier quotes", () => {
    expect(qualifiedTableName({ databaseType: "jdbc", driverProfile: "phoenix", schema: "DEMO", tableName: "STUDENT" })).toBe("DEMO.STUDENT");
  });

  it("uses the driver-reported quote for Phoenix special identifiers", () => {
    expect(qualifiedTableName({ databaseType: "jdbc", driverProfile: "phoenix", identifierQuote: '"', schema: "MY_SCHEMA", tableName: "ORDER" })).toBe('"MY_SCHEMA"."ORDER"');
  });

  it("keeps an unscoped JDBC table unqualified", () => {
    expect(qualifiedTableName({ databaseType: "jdbc", driverProfile: "phoenix", tableName: "STUDENT" })).toBe("STUDENT");
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

  it("backtick-quotes Kyuubi identifiers", () => {
    expect(quoteTableIdentifier("kyuubi", "order`items")).toBe("`order``items`");
  });

  it("backtick-quotes Databricks identifiers", () => {
    expect(quoteTableIdentifier("databricks", "order`items")).toBe("`order``items`");
    expect(quoteTableDataIdentifier("databricks", "order`items")).toBe("`order``items`");
    expect(qualifiedTableName({ databaseType: "databricks", schema: "sales", tableName: "ads_veeva_target_customer_df" })).toBe("`sales`.`ads_veeva_target_customer_df`");
  });

  it("uses BigQuery quoted identifiers and escape sequences", () => {
    expect(quoteTableIdentifier("bigquery", "order")).toBe("`order`");
    expect(quoteTableIdentifier("bigquery", "a`b")).toBe("`a\\`b`");
  });

  it("backtick-quotes Cloud Spanner GoogleSQL identifiers by default", () => {
    expect(quoteTableIdentifier("spanner", "order")).toBe("`order`");
    expect(quoteTableIdentifier("spanner", "a`b")).toBe("`a\\`b`");
  });

  it("uses the connection-reported quote for Cloud Spanner table-data identifiers", () => {
    // GoogleSQL dialect: the agent reports a backtick.
    expect(quoteTableDataIdentifier("spanner", "order", "`")).toBe("`order`");
    // PostgreSQL dialect: the agent reports a double quote.
    expect(quoteTableDataIdentifier("spanner", "MixedCase", '"')).toBe('"MixedCase"');
  });

  it("keeps Cloud Spanner GoogleSQL names single-segment and qualifies PostgreSQL-dialect names", () => {
    // GoogleSQL user schema is the empty string; a two-part name would be a syntax error.
    expect(qualifiedTableName({ databaseType: "spanner", schema: "", tableName: "singers", identifierQuote: "`" })).toBe("`singers`");
    expect(qualifiedTableName({ databaseType: "spanner", schema: "public", tableName: "singers", identifierQuote: '"' })).toBe('"public"."singers"');
    // No reported quote: fall back to the GoogleSQL default.
    expect(qualifiedTableName({ databaseType: "spanner", tableName: "singers" })).toBe("`singers`");
  });

  it("never qualifies a Cloud Spanner table with the resource path", () => {
    // The sidebar SQL template path collapses `node.schema || node.database`, and for Spanner the
    // database is the resource path, which is not a schema and is not valid inside a table name.
    const resourcePath = "projects/p/instances/i/databases/db";
    expect(qualifiedTableName({ databaseType: "spanner", schema: resourcePath, database: resourcePath, tableName: "singers", identifierQuote: "`" })).toBe("`singers`");
    expect(qualifiedTableName({ databaseType: "spanner", schema: resourcePath, database: resourcePath, tableName: "singers", identifierQuote: '"' })).toBe('"singers"');
    expect(qualifiedTableName({ databaseType: "spanner", schema: resourcePath, tableName: "singers" })).toBe("`singers`");
  });

  it("keeps the Cloud Spanner schema qualifier even before the connection quote loads", () => {
    // The quote is fetched asynchronously after connect and can be missing, so the
    // branch is unconditional: a named schema must never lose its qualifier.
    expect(qualifiedTableName({ databaseType: "spanner", schema: "analytics", tableName: "singers" })).toBe("`analytics`.`singers`");
    expect(qualifiedTableName({ databaseType: "spanner", schema: "  ", tableName: "singers" })).toBe("`singers`");
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
