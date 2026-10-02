import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";
import type { DatabaseType } from "@/types/database";

/** 在 `SELECT xxx` 后触发补全，返回候选项；`prefix` 通常取函数名去掉最后一个字符 */
function completionItems(prefix: string, databaseType: DatabaseType) {
  const sql = `SELECT ${prefix}`;
  return buildSqlCompletionItems(sql, sql.length, { databaseType, tables: [], columnsByTable: new Map() });
}

function functionItem(name: string, databaseType: DatabaseType) {
  return completionItems(name.slice(0, -1), databaseType).find((item) => item.label === name);
}

function functionLabels(databaseType: DatabaseType): string[] {
  return completionItems("", databaseType)
    .filter((item) => item.type === "function")
    .map((item) => item.label);
}

const ORACLE_FAMILY: DatabaseType[] = ["oracle", "oceanbase-oracle", "dameng", "yashandb", "oscar", "xugu"];
const POSTGRES_FAMILY: DatabaseType[] = ["postgres", "redshift", "kingbase", "highgo", "uxdb", "vastbase", "gaussdb", "opengauss", "sundb"];
const HIVE_SPARK_FAMILY: DatabaseType[] = ["hive", "spark", "databricks", "impala", "transwarp", "kyuubi", "argo"];

describe("SQL function completion across dialects", () => {
  it.each(ORACLE_FAMILY)("offers Oracle built-in functions for %s", (databaseType) => {
    expect(functionItem("NVL", databaseType)).toMatchObject({ type: "function", apply: expect.stringContaining("NVL(") });
    expect(functionItem("TO_CHAR", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("DECODE", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("ADD_MONTHS", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("LISTAGG", databaseType)).toMatchObject({ type: "function" });
  });

  it.each(["oracle", "dameng"])("inserts Oracle syntax-sensitive functions through their templates for %s", (databaseType) => {
    expect(functionItem("EXTRACT", databaseType)?.apply).toBe("EXTRACT(${unit} FROM ${datetime})");
    expect(functionItem("LISTAGG", databaseType)?.apply).toContain("WITHIN GROUP (ORDER BY ${order_by})");
  });

  it("offers signature help for Oracle-only functions", () => {
    const sql = "SELECT TO_CHAR(";
    expect(getSqlFunctionSignatureHelp(sql, sql.length, "oracle")).not.toBeNull();
    expect(getSqlFunctionSignatureHelp(sql, sql.length, "mysql")).toBeNull();
  });

  it.each(POSTGRES_FAMILY)("offers PostgreSQL family functions for %s", (databaseType) => {
    expect(functionItem("DATE_TRUNC", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("SPLIT_PART", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("ARRAY_LENGTH", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("REGEXP_REPLACE", databaseType)).toMatchObject({ type: "function" });
  });

  it("inserts PostgreSQL syntax-sensitive functions through their templates", () => {
    expect(functionItem("POSITION", "postgres")?.apply).toBe("POSITION(${substring} IN ${string})");
    expect(functionItem("PERCENTILE_CONT", "kingbase")?.apply).toContain("WITHIN GROUP (ORDER BY ${expression})");
  });

  it("offers DuckDB list and date functions on top of the PostgreSQL baseline", () => {
    expect(functionItem("STRFTIME", "duckdb")).toMatchObject({ type: "function" });
    expect(functionItem("LIST_VALUE", "duckdb")).toMatchObject({ type: "function", apply: expect.stringContaining("LIST_VALUE(") });
    expect(functionItem("STRING_SPLIT", "duckdb")).toMatchObject({ type: "function" });
    // DuckDB 复用 PG 的语法模板
    expect(functionItem("POSITION", "duckdb")?.apply).toBe("POSITION(${substring} IN ${string})");
    // PG 基线函数同样可用
    expect(functionItem("DATE_TRUNC", "duckdb")).toMatchObject({ type: "function" });
  });

  it.each(HIVE_SPARK_FAMILY)("offers Hive/Spark family functions for %s", (databaseType) => {
    expect(functionItem("GET_JSON_OBJECT", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("COLLECT_LIST", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("EXPLODE", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("EXTRACT", databaseType)?.apply).toBe("EXTRACT(${field} FROM ${source})");
  });

  it.each(["trino", "prestosql"])("offers Trino/Presto functions for %s", (databaseType) => {
    expect(functionItem("DATE_DIFF", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("REGEXP_EXTRACT", databaseType)).toMatchObject({ type: "function" });
    expect(functionItem("ARRAY_JOIN", databaseType)).toMatchObject({ type: "function" });
  });

  it("shares the MySQL function table with MySQL-compatible engines", () => {
    expect(functionItem("DATE_FORMAT", "goldendb")).toMatchObject({ type: "function" });
    expect(functionItem("GROUP_CONCAT", "goldendb")).toMatchObject({ type: "function" });
    expect(functionItem("IFNULL", "goldendb")).toMatchObject({ type: "function" });
  });

  it("keeps dialect-specific functions out of other dialects", () => {
    const mysqlFunctions = functionLabels("mysql");
    expect(mysqlFunctions).not.toContain("NVL");
    expect(mysqlFunctions).not.toContain("TO_CHAR");
    expect(mysqlFunctions).not.toContain("DATE_TRUNC");
    expect(mysqlFunctions).not.toContain("GET_JSON_OBJECT");

    const oracleFunctions = functionLabels("oracle");
    expect(oracleFunctions).not.toContain("IFNULL");
    expect(oracleFunctions).not.toContain("DATE_FORMAT");
    expect(oracleFunctions).not.toContain("GROUP_CONCAT");
    expect(oracleFunctions).not.toContain("STRFTIME");

    const postgresFunctions = functionLabels("postgres");
    expect(postgresFunctions).not.toContain("NVL");
    expect(postgresFunctions).not.toContain("IFNULL");
    expect(postgresFunctions).not.toContain("GET_JSON_OBJECT");

    const trinoFunctions = functionLabels("trino");
    expect(trinoFunctions).not.toContain("NVL");
    expect(trinoFunctions).not.toContain("GET_JSON_OBJECT");
  });
});
