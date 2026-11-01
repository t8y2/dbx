import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";

describe("CockroachDB SQL completion (#13078)", () => {
  function itemsFor(sql: string, driverProfile: "cockroachdb" | null = "cockroachdb") {
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: "postgres",
      driverProfile: driverProfile ?? undefined,
      tables: [],
      columnsByTable: new Map(),
    });
  }

  function labelsFor(sql: string, driverProfile?: "cockroachdb" | null) {
    return itemsFor(sql, driverProfile).map((item) => item.label);
  }

  it("offers AS OF SYSTEM TIME after the typed AS prefix", () => {
    const items = itemsFor("SELECT * FROM t AS O");
    const item = items.find((candidate) => candidate.label === "OF SYSTEM TIME");

    expect(item).toBeDefined();
    expect(items.indexOf(item!)).toBeLessThan(3);
  });

  it("offers CRDB table options and distributed keywords", () => {
    expect(labelsFor("CREATE TABLE t (id INT PRIMARY KEY) FAM")).toContain("FAMILY");
    expect(labelsFor("ALTER TABLE t SPLIT")).toContain("SPLIT AT");
    expect(labelsFor("ALTER TABLE t UNS")).toContain("UNSPLIT AT");
    expect(labelsFor("ALTER TABLE t SET LOCAL")).toContain("LOCALITY");
    expect(labelsFor("ALTER TABLE t REGIONAL BY")).toContain("REGIONAL BY ROW");
    expect(labelsFor("UPS")).toContain("UPSERT");
  });

  it("offers CRDB-only types as data types", () => {
    const bytes = itemsFor("CREATE TABLE t (payload BYT").find((item) => item.label === "BYTES");
    const vector = itemsFor("CREATE TABLE t (embedding VEC").find((item) => item.label === "VECTOR");

    expect(bytes?.detail).toBe("data type");
    expect(vector?.detail).toBe("data type");
  });

  it("offers CRDB built-in functions that PostgreSQL does not provide", () => {
    expect(labelsFor("SELECT cluster_logical_")).toContain("CLUSTER_LOGICAL_TIMESTAMP");
    expect(labelsFor("SELECT timeofday(")).toContain("TIMEOFDAY");
    expect(labelsFor("SELECT follower_")).toContain("FOLLOWER_READ_TIMESTAMP");
    expect(labelsFor("SELECT with_")).toEqual(expect.arrayContaining(["WITH_MIN_TIMESTAMP", "WITH_MAX_STALENESS"]));
    expect(labelsFor("SELECT l2_d")).toContain("L2_DISTANCE");
  });

  it("keeps PostgreSQL functions available on CockroachDB connections", () => {
    expect(labelsFor("SELECT now(")).toContain("NOW");
    expect(labelsFor("SELECT jsonb_build_object(")).toContain("JSONB_BUILD_OBJECT");
  });

  it("does not leak CockroachDB completions into a plain PostgreSQL connection", () => {
    expect(labelsFor("SELECT * FROM t AS O", null)).not.toContain("OF SYSTEM TIME");
    expect(labelsFor("SELECT cluster_logical_", null)).not.toContain("CLUSTER_LOGICAL_TIMESTAMP");
    expect(labelsFor("CREATE TABLE t (id INT PRIMARY KEY) FAM", null)).not.toContain("FAMILY");
  });

  it("offers CRDB key-generation and aggregate helpers", () => {
    expect(labelsFor("SELECT unique_")).toEqual(expect.arrayContaining(["UNIQUE_ROWID", "UNORDERED_UNIQUE_ROWID"]));
    expect(labelsFor("SELECT uuid_v")).toContain("UUID_V4");
    expect(labelsFor("SELECT ulid_to_")).toContain("ULID_TO_UUID");
    expect(labelsFor("SELECT sum_")).toContain("SUM_INT");
    expect(labelsFor("SELECT xor_")).toContain("XOR_AGG");
    expect(labelsFor("SELECT vector_")).toEqual(expect.arrayContaining(["VECTOR_DIMS", "VECTOR_NORM"]));
    expect(labelsFor("SELECT prettify_")).toContain("PRETTIFY_STATEMENT");
  });

  it("offers multi-region, chained, and transactional keywords", () => {
    expect(labelsFor("ALTER DATABASE db ADD REGI")).toContain("REGION");
    expect(labelsFor("ALTER DATABASE db SURV")).toContain("SURVIVE");
    expect(labelsFor("CREATE INDEX i ON t (a) STOR")).toContain("STORING");
    expect(labelsFor("CREATE TABLE t (id INT GENERATED ALW")).toContain("ALWAYS");
    expect(labelsFor("SAVE")).toContain("SAVEPOINT");
    expect(labelsFor("SELECT a FROM t GROUP BY ROLL")).toContain("ROLLUP");
  });

  it("offers SHOW and CRDB-specific SHOW clauses", () => {
    expect(labelsFor("SHO")).toContain("SHOW");
    expect(labelsFor("SHO", null)).toContain("SHOW");
    expect(labelsFor("SHOW R")).toEqual(expect.arrayContaining(["RANGES", "REGIONS", "ROLES"]));
    expect(labelsFor("SHOW J")).toContain("JOBS");
    expect(labelsFor("SHOW Z")).toContain("ZONE CONFIGURATIONS");
  });

  it("prefers FROM after SHOW TABLES and object types after SHOW CREATE", () => {
    expect(labelsFor("SHOW TABLES ")[0]).toBe("FROM");
    expect(labelsFor("SHOW COLUMNS ")[0]).toBe("FROM");
    expect(labelsFor("SHOW CREATE ")[0]).toBe("TABLE");
    expect(labelsFor("SHOW CREATE V")[0]).toBe("VIEW");
  });

  it("offers common SQL keywords that were missing from the shared tables", () => {
    expect(labelsFor("CREATE TEMP")).toEqual(expect.arrayContaining(["TEMP", "TEMPORARY"]));
    expect(labelsFor("START TRANS")).toContain("TRANSACTION");
    expect(labelsFor("CREATE SEQ")).toContain("SEQUENCE");
    expect(labelsFor("DROP TABLE t CASC")).toContain("CASCADE");
    expect(labelsFor("NULLS F")).toContain("FIRST");
    expect(labelsFor("SHOW STAT")).toContain("STATISTICS");
  });

  it("keeps PG-only keywords out of MySQL connections", () => {
    const mysql = (sql: string) => buildSqlCompletionItems(sql, sql.length, { databaseType: "mysql", tables: [], columnsByTable: new Map() }).map((item) => item.label);

    expect(labelsFor("CREATE SEQ")).toContain("SEQUENCE");
    expect(mysql("CREATE SEQ")).not.toContain("SEQUENCE");
    expect(mysql("CREATE TEM")).toEqual(expect.arrayContaining(["TEMPORARY"]));
  });

  it.each(["STRING", "BYTES"])("preserves Spanner %s type completion without a CRDB profile", (type) => {
    const sql = `CREATE TABLE t (value ${type.slice(0, 3)}`;
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "spanner",
      tables: [],
      columnsByTable: new Map(),
    });
    expect(items.find((item) => item.label === type)?.detail).toBe("data type");
  });

  it("returns signature help for CRDB functions", () => {
    const sql = "SELECT with_max_staleness(";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "postgres", "cockroachdb");

    expect(help?.name).toBe("WITH_MAX_STALENESS");
    expect(help?.parameters).toEqual(["max_staleness", "nearest_only"]);
  });
});
