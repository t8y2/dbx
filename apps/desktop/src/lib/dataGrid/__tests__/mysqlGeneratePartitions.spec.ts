import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTableGenerateState, generateTableData, generateTableRowsChunk, type TableGenerateConfig } from "../dataGenerate";
import { constrainMysqlGenerateColumns, mysqlGeneratePartitionQuery, type MysqlGeneratePartition } from "../mysqlGeneratePartitions";

const config = (): TableGenerateConfig => ({
  tableName: "records",
  schema: "student",
  database: "student",
  rowCount: 1000,
  columns: [
    { columnName: "id", dataType: "bigint", rowCount: 1000, isAutoIncrement: true, generatorKey: "sequence", generatorParams: { startValue: 2, increment: 1 } },
    { columnName: "bucket", dataType: "int", rowCount: 1000, generatorKey: "number", generatorParams: { min: 1, max: 999999 } },
  ],
});
const partition = (method: string, description: string, expression = "`bucket`"): MysqlGeneratePartition => ({ method, description, expression });
const constrain = (cfg: TableGenerateConfig, partitions: MysqlGeneratePartition[]) => ({ ...cfg, columns: constrainMysqlGenerateColumns(cfg, partitions) });
afterEach(() => vi.restoreAllMocks());

describe("MySQL partition-aware data generation (#13883)", () => {
  it("reproduces the out-of-partition random value and keeps LIST values valid across preview and streamed chunks", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.570263);
    const cfg = config();
    expect(generateTableData(cfg, "mysql").rows[0]![1]).toBe(570263);
    const resolved = constrain(cfg, [partition("LIST", "10,20"), partition("LIST", "40")]);
    const preview = generateTableData({ ...resolved, rowCount: 50 }, "mysql");
    const state = createTableGenerateState(resolved, "mysql");
    const rows = [...generateTableRowsChunk(resolved, state, 333), ...generateTableRowsChunk(resolved, state, 667)];
    expect(rows).toHaveLength(1000);
    expect(rows.slice(0, 50)).toEqual(preview.rows);
    expect(rows.every((row) => ["10", "20", "40"].includes(String(row[1])))).toBe(true);
    expect(rows[999]![0]).toBe(1001);
  });

  it("quotes catalog names independently of backslash SQL mode", () => {
    const sql = mysqlGeneratePartitionQuery("a'\\数据库", "b'");
    expect(sql).toContain("CONVERT(X'6227' USING utf8mb4)");
    expect(sql).not.toContain("数据库");
    expect(sql).not.toContain("a'");
  });

  it("honors exclusive RANGE upper bounds with deterministic edge values", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99999999);
    const cfg = constrain(config(), [partition("RANGE", "100"), partition("RANGE", "200")]);
    const rows = generateTableData(cfg, "mysql").rows;
    expect(rows.every((row) => Number(row[1]) < 200)).toBe(true);
    expect(rows[0]![1]).toBe(199);
    expect(config().columns[1]!.generatorParams!.max).toBe(999999);
  });

  it("leaves ordinary, HASH/KEY and unbounded RANGE tables unchanged", () => {
    const cfg = config();
    for (const partitions of [[], [partition("HASH", "")], [partition("KEY", "")], [partition("RANGE", "MAXVALUE")]]) {
      expect(constrainMysqlGenerateColumns(cfg, partitions)).toBe(cfg.columns);
    }
  });

  it("rejects an auto-increment sequence outside partition capacity before any INSERT", () => {
    const cfg = config();
    expect(() => constrain(cfg, [partition("RANGE", "100", "`id`")])).toThrow(/records/);
    expect(() => constrain(cfg, [partition("LIST", "2,3", "`id`")])).toThrow(/partition/);
  });

  it.each([
    ["RANGE COLUMNS", "'2024-01-01'", "`created_at`"],
    ["RANGE", "2024", "year(`created_at`)"],
    ["RANGE", "739251", "to_days(`created_at`)"],
    ["RANGE", "1704067200", "unix_timestamp(`created_at`)"],
  ])("bounds temporal partition values for %s %s %s", (method, description, expression) => {
    vi.spyOn(Math, "random").mockReturnValue(0.99999999);
    const cfg = config();
    cfg.columns[1] = { columnName: "created_at", dataType: "datetime", rowCount: 1000, generatorKey: "datetime", generatorParams: { start: "2025-01-01", end: "2026-12-31" } };
    const rows = generateTableData(constrain(cfg, [partition(method, description, expression)]), "mysql").rows;
    expect(rows.every((r) => String(r[1]) < "2024-01-01")).toBe(true);
  });

  it("does not approximate unsupported expressions or unsafe BIGINT boundaries", () => {
    for (const p of [partition("RANGE", "100", "bucket + 1"), partition("RANGE", "9007199254740993"), partition("LIST COLUMNS", "(1,2)", "bucket,id")]) {
      expect(() => constrain(config(), [p])).toThrow(/Cannot safely generate/);
    }
  });
});

// Opt-in: uses the local mysql CLI's configured connection and a fresh scratch
// database. No application database is read or changed.
it.runIf(process.env.DBX_TEST_MYSQL_PARTITIONS === "1")("inserts generated rows into a populated MySQL LIST partition table", () => {
  const database = `dbx_issue13883_${process.pid}_${Date.now()}`;
  const mysql = (sql: string) => execFileSync("mysql", ["-uroot", "--batch", "--skip-column-names"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  mysql(`CREATE DATABASE ${database}`);
  try {
    mysql(`CREATE TABLE ${database}.records (id BIGINT NOT NULL AUTO_INCREMENT, bucket INT NOT NULL, PRIMARY KEY(id,bucket)) PARTITION BY LIST(bucket) (PARTITION p0 VALUES IN (10,20), PARTITION p1 VALUES IN (40)); INSERT INTO ${database}.records VALUES (1,10);`);
    const cfg = { ...config(), schema: database, database };
    vi.spyOn(Math, "random").mockReturnValue(0.570263);
    expect(() => mysql(`USE ${database}; ${generateTableData(cfg, "mysql").sql}`)).toThrow(/ERROR 1526.*570263/);
    const metadata = mysql(mysqlGeneratePartitionQuery(database, "records"));
    const partitions = metadata
      .trim()
      .split("\n")
      .map((line) => {
        const [method, expression, description] = line.split("\t");
        return { method: method!, expression: expression!, description: description! };
      });
    mysql(`USE ${database}; ${generateTableData(constrain(cfg, partitions), "mysql").sql}`);
    expect(mysql(`SELECT COUNT(*), COUNT(DISTINCT id) FROM ${database}.records`).trim()).toBe("1001\t1001");
    // Also exercise exclusive numeric and date-expression RANGE bounds on the
    // server, including an existing row and an auto-increment key.
    mysql(`CREATE TABLE ${database}.range_records (id BIGINT NOT NULL AUTO_INCREMENT, bucket INT NOT NULL, PRIMARY KEY(id,bucket)) PARTITION BY RANGE(bucket) (PARTITION p0 VALUES LESS THAN (100), PARTITION p1 VALUES LESS THAN (200)); INSERT INTO ${database}.range_records VALUES (1,10);`);
    const rangeCfg = { ...cfg, tableName: "range_records" };
    mysql(`USE ${database}; ${generateTableData(constrain(rangeCfg, [partition("RANGE", "100"), partition("RANGE", "200")]), "mysql").sql}`);
    expect(mysql(`SELECT COUNT(*), MAX(bucket) < 200 FROM ${database}.range_records`).trim()).toBe("1001\t1");
    mysql(`CREATE TABLE ${database}.date_records (id BIGINT NOT NULL AUTO_INCREMENT, created_at DATETIME NOT NULL, PRIMARY KEY(id,created_at)) PARTITION BY RANGE(TO_DAYS(created_at)) (PARTITION p0 VALUES LESS THAN (739251)); INSERT INTO ${database}.date_records VALUES (1,'2022-01-01');`);
    const dateCfg = { ...cfg, tableName: "date_records", columns: [cfg.columns[0]!, { columnName: "created_at", dataType: "datetime", rowCount: 1000, generatorKey: "datetime", generatorParams: { start: "2025-01-01", end: "2026-12-31" } }] };
    mysql(`USE ${database}; ${generateTableData(constrain(dateCfg, [partition("RANGE", "739251", "to_days(`created_at`)")]), "mysql").sql}`);
    expect(mysql(`SELECT COUNT(*), MAX(created_at) < '2024-01-01' FROM ${database}.date_records`).trim()).toBe("1001\t1");
  } finally {
    mysql(`DROP DATABASE ${database}`);
  }
});
