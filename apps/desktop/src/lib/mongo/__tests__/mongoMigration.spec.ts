import { describe, expect, it } from "vitest";
import { assertMigrationMongoAck, executeMigrationOperations, migrationMongoOperations, migrationReadSql, migrationSqlOperations, mongoRowsToSql, sqlRowsToMongo, validateMigrationMappings, type MigrationSqlEndpoint, type MongoMigrationMapping } from "../mongoMigration";
import type { ColumnInfo } from "@/types/database";

const mapping = (source: string, target: string, extra: Partial<MongoMigrationMapping> = {}): MongoMigrationMapping => ({
  source,
  target,
  type: "auto",
  array: "reject",
  missing: "error",
  ...extra,
});
const endpoint: MigrationSqlEndpoint = { connectionId: "isolated", database: "fixture", schema: "", table: "target", dialect: "postgres" };
const column = (name: string, data_type = "text", extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type,
  is_nullable: true,
  column_default: null,
  is_primary_key: false,
  extra: null,
  ...extra,
});

describe("bounded SQL / Mongo migration", () => {
  it("quotes malicious identifiers rather than executing them", () => {
    expect(migrationReadSql({ ...endpoint, table: 'x"; DROP TABLE x;--' }, 1)).toBe('SELECT * FROM "x""; DROP TABLE x;--" LIMIT 2;');
    expect(migrationReadSql({ ...endpoint, dialect: "sqlserver" }, 100)).toBe("SELECT TOP (101) * FROM [target];");
    expect(() => migrationReadSql(endpoint, 0)).toThrow();
    expect(() => migrationReadSql(endpoint, 1001)).toThrow();
  });
  it("maps SQL exact values to nested typed BSON without converting numeric strings to doubles", () => {
    const source = {
      columns: ["id", "amount", "name", "enabled"],
      column_types: ["bigint", "numeric", "text", "bool"],
      rows: [["9223372036854775807", "12345678901234567890.1234", "Alice", true]],
    };
    const rows = sqlRowsToMongo(source, [mapping("id", "_id"), mapping("amount", "payment.amount"), mapping("name", "contact.name"), mapping("enabled", "enabled")]);
    expect(rows).toEqual([{ _id: { $numberLong: "9223372036854775807" }, payment: { amount: { $numberDecimal: "12345678901234567890.1234" } }, contact: { name: "Alice" }, enabled: true }]);
    expect(source.rows[0][0]).toBe("9223372036854775807");
    const operation = JSON.parse(migrationMongoOperations(rows, "target")[0].text);
    expect(operation.documents).toEqual(rows);
    expect(operation.writeConcern).toEqual({ w: "majority" });
  });
  it("rejects unsafe numbers, rounding decimal inputs, and over-range typed values", () => {
    const convert = (value: string | number, type: MongoMigrationMapping["type"] = "auto", sourceType = "") => sqlRowsToMongo({ columns: ["v"], rows: [[value]], column_types: [sourceType] }, [mapping("v", "v", { type })]);
    expect(() => convert(9007199254740992)).toThrow("Unsafe numeric");
    expect(() => convert(1.25, "string", "numeric")).toThrow("Exact SQL decimal");
    expect(() => convert("9223372036854775808", "int64")).toThrow("int64");
    expect(() => convert("12345678901234567890123456789012345", "decimal128")).toThrow("Decimal128");
    expect(() => convert("1e7000", "decimal128")).toThrow("Decimal128");
  });
  it("parses canonical EJSON and refuses unwrapped unsafe/fractional JSON numbers", () => {
    const convert = (value: string) => sqlRowsToMongo({ columns: ["v"], rows: [[value]] }, [mapping("v", "v", { type: "ejson" })]);
    expect(convert('{"n":{"$numberLong":"9007199254740993"},"v":{"$numberDecimal":"0.1234567890123456789"}}')[0].v).toEqual({
      n: { $numberLong: "9007199254740993" },
      v: { $numberDecimal: "0.1234567890123456789" },
    });
    expect(() => convert('{"n":9007199254740993}')).toThrow();
    expect(() => convert('{"n":0.1234567890123456789}')).toThrow();
    expect(() => convert('{"__proto__":{}}')).toThrow();
  });
  it("rejects overlapping paths and prototype pollution", () => {
    for (const target of ["__proto__.x", "a.constructor", "a..b", "$set.x", "a.*"]) expect(() => validateMigrationMappings([mapping("source", target)], "sqlToMongo")).toThrow();
    expect(() => validateMigrationMappings([mapping("a", "x"), mapping("b", "x.y")], "sqlToMongo")).toThrow("Overlapping");
  });
  it("does not round timestamps or accept ambiguous time zones", () => {
    const convert = (value: string) => sqlRowsToMongo({ columns: ["v"], rows: [[value]] }, [mapping("v", "v", { type: "date" })]);
    expect(convert("2026-10-12T03:04:05.123Z")[0].v).toEqual({ $date: "2026-10-12T03:04:05.123Z" });
    expect(() => convert("2026-10-12 03:04:05")).toThrow();
    expect(() => convert("2026-10-12T03:04:05.123456Z")).toThrow();
  });
  it("blocks duplicate SQL columns and truncated source cells", () => {
    expect(() => sqlRowsToMongo({ columns: ["x", "x"], rows: [[1, 2]] }, [mapping("x", "x")])).toThrow();
    expect(() => sqlRowsToMongo({ columns: ["x"], rows: [["preview"]], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 1000 }] }, [mapping("x", "x")])).toThrow("truncated");
  });
  it("flattens BSON paths, preserves exact numeric wrappers, and serializes complex types", () => {
    const document = { _id: { $oid: "507f1f77bcf86cd799439011" }, nested: { total: { $numberDecimal: "12.34" } }, binary: { $binary: { base64: "AQI=", subType: "00" } } };
    const rows = mongoRowsToSql([document], [mapping("_id", "id", { type: "string" }), mapping("nested.total", "total"), mapping("binary", "payload", { type: "ejson" })]);
    expect(rows[0]).toEqual({ id: "507f1f77bcf86cd799439011", total: { $numberDecimal: "12.34" }, payload: JSON.stringify(document.binary) });
    expect(() => mongoRowsToSql([document], [mapping("binary", "payload", { type: "string" })])).toThrow();
  });
  it("handles arrays only with explicit non-default policies and avoids double encoding", () => {
    const input = [{ items: [{ $numberLong: "9007199254740993" }, "b"] }];
    expect(() => mongoRowsToSql(input, [mapping("items", "items")])).toThrow("Array");
    expect(mongoRowsToSql(input, [mapping("items", "items", { array: "json", type: "ejson" })])[0].items).toBe(JSON.stringify(input[0].items));
    expect(mongoRowsToSql(input, [mapping("items", "first", { array: "first" })])[0].first).toEqual(input[0].items[0]);
  });
  it("distinguishes missing, null and target defaults", () => {
    expect(() => mongoRowsToSql([{}], [mapping("v", "v")])).toThrow("missing");
    expect(mongoRowsToSql([{}], [mapping("v", "v", { missing: "null" })])[0]).toEqual({ v: null });
    expect(mongoRowsToSql([{}], [mapping("v", "v", { missing: "null", type: "ejson" })])[0]).toEqual({ v: null });
    expect(mongoRowsToSql([{ v: null }], [mapping("v", "v", { type: "ejson" })])[0]).toEqual({ v: "null" });
    expect(mongoRowsToSql([{}], [mapping("v", "v", { missing: "omit" })])[0]).toEqual({});
    expect(mongoRowsToSql([{ v: null }], [mapping("v", "v", { missing: "omit" })])[0]).toEqual({ v: null });
  });
  it("generates exact SQL numeric literals and rejects target precision loss", () => {
    const rows = [{ n: { $numberLong: "9223372036854775807" }, amount: { $numberDecimal: "123.45" } }];
    const columns = [column("n", "bigint"), column("amount", "numeric", { numeric_precision: 5, numeric_scale: 2 })];
    expect(migrationSqlOperations(rows, endpoint, columns)[0].text).toContain("VALUES (9223372036854775807, 123.45)");
    expect(() => migrationSqlOperations([{ amount: { $numberDecimal: "123.456" } }], endpoint, columns)).toThrow("precision/scale");
    expect(() => migrationSqlOperations([{ n: { $numberLong: "9223372036854775808" } }], endpoint, columns)).toThrow("out of range");
    expect(() => migrationSqlOperations([{ amount: "123.45" }], { ...endpoint, dialect: "sqlite" }, columns)).toThrow("Unsupported");
  });
  it("encodes text without SQL mode-dependent escaping", () => {
    const value = "'\\'; DELETE FROM target;-- 中文";
    for (const dialect of ["mysql", "postgres", "sqlite"] as const) {
      const text = migrationSqlOperations([{ x: value }], { ...endpoint, dialect }, [column("x")])[0].text;
      expect(text).not.toContain("DELETE FROM");
    }
    expect(migrationSqlOperations([{ x: "a'b" }], { ...endpoint, dialect: "sqlserver" }, [column("x", "nvarchar(max)")])[0].text).toContain("N'a''b'");
  });
  it("rejects target coercions, length overflow, missing and generated columns", () => {
    expect(() => migrationSqlOperations([{ x: "long" }], endpoint, [column("x", "varchar(2)")])).toThrow("length");
    expect(() => migrationSqlOperations([{ x: null }], endpoint, [column("x", "text", { is_nullable: false })])).toThrow("nullable");
    expect(() => migrationSqlOperations([{ x: 1 }], endpoint, [column("x", "text")])).toThrow("string");
    expect(() => migrationSqlOperations([{ x: 1 }], endpoint, [column("x", "integer", { extra: "identity" })])).toThrow("generated");
    expect(() => migrationSqlOperations([{ x: "v" }], endpoint, [])).toThrow("not found");
    expect(() => migrationReadSql({ ...endpoint, dialect: "mysql", schema: "other_database" }, 1)).toThrow("schema");
    expect(() => migrationReadSql({ ...endpoint, dialect: "sqlite", schema: "attached_database" }, 1)).toThrow("Attached");
  });
  it("rejects reserved or invalid collection names before generating migration writes", () => {
    for (const name of ["", "system.profile", "archive.system.profile", "bad$name", "bad\0name"]) {
      expect(() => migrationMongoOperations([{ _id: 1 }], name)).toThrow("outputTarget");
    }
    expect(migrationMongoOperations([{ _id: 1 }], "archive.items")).toHaveLength(1);
  });
  it("checks write acknowledgements including per-item and write-concern errors", () => {
    expect(() => assertMigrationMongoAck({ ok: 1, n: 1 })).not.toThrow();
    expect(() => assertMigrationMongoAck({ ok: { $numberDouble: "1.0" }, n: { $numberInt: "1" } })).not.toThrow();
    for (const response of [{ ok: 1, n: 0 }, { ok: 1, n: 1, writeErrors: [{}] }, { ok: 1, n: 1, writeConcernError: {} }, null]) expect(() => assertMigrationMongoAck(response)).toThrow();
  });
  it("cancels between rows, preserves progress, and never retries uncertain writes", async () => {
    const operations = migrationMongoOperations([{ _id: 1 }, { _id: 2 }, { _id: 3 }], "fixture");
    const controller = new AbortController();
    let calls = 0;
    const cancelled = await executeMigrationOperations(
      operations,
      async () => {
        calls++;
        controller.abort();
      },
      { signal: controller.signal },
    );
    expect(cancelled).toEqual({ completed: 1, total: 3, status: "cancelled" });
    expect(calls).toBe(1);
    calls = 0;
    const failed = await executeMigrationOperations(operations, async () => {
      calls++;
      if (calls === 2) throw new Error("network lost");
    });
    expect(failed).toEqual({ completed: 1, total: 3, status: "failed", uncertainIndex: 2, error: "network lost" });
    expect(calls).toBe(2);
    const denied = await executeMigrationOperations(
      operations,
      async () => {
        calls++;
      },
      {
        beforeWrite: () => {
          throw new Error("read-only");
        },
      },
    );
    expect(denied.completed).toBe(0);
    expect(denied.uncertainIndex).toBeUndefined();
    expect(calls).toBe(2);
  });
});
