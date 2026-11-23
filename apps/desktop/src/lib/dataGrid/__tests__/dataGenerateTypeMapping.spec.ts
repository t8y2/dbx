import { describe, expect, it } from "vitest";
import { bitColumnShape, defaultGeneratorParams, findGeneratorKey, formatGeneratedValue, generateTableData, generateValue, isBooleanColumnType, normalizeColumnDataType } from "@/lib/dataGrid/dataGenerate";

// Column metadata reports the full SQL type, modifiers included. The generator
// used to compare that raw string, so `time(3)` / `bit(1)` columns missed every
// branch and silently fell back to the text generator (#12994).
describe("normalizeColumnDataType", () => {
  it.each([
    ["TIMESTAMP(6) WITHOUT TIME ZONE", "timestamp without time zone"],
    ["time(3)", "time"],
    ["decimal(10, 2)", "decimal"],
    ["character varying(64)", "character varying"],
    ["  BIT(1)  ", "bit"],
  ])("strips modifiers from %s", (dataType, expected) => {
    expect(normalizeColumnDataType(dataType)).toBe(expected);
  });
});

describe("isBooleanColumnType", () => {
  it.each([
    ["bool", true],
    ["boolean", true],
    ["bit", true],
    ["bit(1)", true],
    ["bit(8)", false],
    ["tinyint(1)", true],
    ["tinyint ( 1 )", true],
    ["tinyint(4)", false],
    ["bit varying(8)", false],
    ["varchar(1)", false],
    ["int", false],
  ])("classifies %s as boolean=%s", (dataType, expected) => {
    expect(isBooleanColumnType(dataType)).toBe(expected);
  });
});

describe("findGeneratorKey honors the column type with modifiers (#12994)", () => {
  it.each([
    ["time", "time"],
    ["time(3)", "time"],
    ["time(6)", "time"],
    ["time without time zone", "time"],
    ["timestamp(6) without time zone", "datetime"],
    ["datetime(3)", "datetime"],
    ["date", "datetime"],
    ["bit", "enum"],
    ["bit(1)", "enum"],
    ["bit(8)", "bitmask"],
    ["bit varying(8)", "bitmask"],
    ["varbit(8)", "bitmask"],
    ["bit varying", "bitmask"],
    ["bool", "enum"],
    ["boolean", "enum"],
    ["tinyint(1)", "enum"],
    ["tinyint(4)", "number"],
    ["smallint unsigned", "number"],
    ["number(10,2)", "number"],
    ["numeric(10,2)", "number"],
    ["decimal(10,2)", "number"],
    ["serial", "sequence"],
    ["bigserial", "sequence"],
    ["varchar(32)", "text"],
    ["character varying(64)", "text"],
    ["nvarchar2(50)", "text"],
    ["uuid", "uuid"],
  ])("maps %s to the %s generator", (dataType, expected) => {
    expect(findGeneratorKey("plain_column", dataType)).toBe(expected);
  });

  it("still prefers the auto-increment sequence over the declared type", () => {
    expect(findGeneratorKey("id", "bigint", true)).toBe("sequence");
  });

  it("only treats the PostgreSQL serial pseudo-type as a sequence", () => {
    expect(findGeneratorKey("value", "serial_number_code")).toBe("text");
    expect(findGeneratorKey("value", "serial(8)")).toBe("sequence");
    expect(findGeneratorKey("value", "smallserial")).toBe("sequence");
  });
});

describe("generated values match the declared column type (#12994)", () => {
  it("emits a clock time for a TIME column with a fractional-seconds modifier", () => {
    const params = defaultGeneratorParams("starts_at", { dataType: "time(3)" }, "time");
    const value = generateValue("starts_at", "time(3)", "time", 0, params);
    expect(value).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("emits 0/1 for a BIT(1) flag instead of free text", () => {
    const params = defaultGeneratorParams("enabled", { dataType: "bit(1)" }, "enum");
    expect(params.values).toBe("0\n1");
    for (let row = 0; row < 20; row += 1) {
      expect(["0", "1"]).toContain(generateValue("enabled", "bit(1)", "enum", row, params));
    }
  });

  it("keeps the 0/1/2 enum for a wider BIT column", () => {
    const params = defaultGeneratorParams("bit_mask", { dataType: "bit(8)" }, "enum");
    expect(params.values).toBe("0\n1\n2");
  });

  it("falls back to a clock time when a TIME column has no generator key", () => {
    expect(generateValue("starts_at", "time(3)", undefined, 0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

// PostgreSQL `bit(n)` stores exactly n bits and `bit varying(n)` up to n, while
// MySQL `BIT(n)` only accepts a bit-value literal. The generator keeps the
// declared width and formats the literal per dialect (#13014 review).
describe("bit-string generation honors the declared width (#13014)", () => {
  it("parses the width and variability of the bit family", () => {
    expect(bitColumnShape("bit")).toEqual({ width: 1, varying: false });
    expect(bitColumnShape("bit(1)")).toEqual({ width: 1, varying: false });
    expect(bitColumnShape("bit(8)")).toEqual({ width: 8, varying: false });
    expect(bitColumnShape("bit varying(8)")).toEqual({ width: 8, varying: true });
    expect(bitColumnShape("varbit(8)")).toEqual({ width: 8, varying: true });
    expect(bitColumnShape("varchar(8)")).toBeNull();
  });

  it("emits exactly n bits for a fixed-width column, whatever the name", () => {
    for (const columnName of ["plain_mask", "enabled_flag"]) {
      const params = defaultGeneratorParams(columnName, { dataType: "bit(8)" }, "bitmask");
      for (let row = 0; row < 20; row += 1) {
        const value = String(generateValue(columnName, "bit(8)", "bitmask", row, params));
        expect(value).toMatch(/^[01]{8}$/);
      }
    }
  });

  it("emits 1..n bits for bit varying and keeps bit(1) on the 0/1 enum", () => {
    const params = defaultGeneratorParams("flags", { dataType: "bit varying(8)" }, "bitmask");
    for (let row = 0; row < 20; row += 1) {
      const value = String(generateValue("flags", "bit varying(8)", "bitmask", row, params));
      expect(value).toMatch(/^[01]{1,8}$/);
    }
    expect(findGeneratorKey("enabled_flag", "bit(1)")).toBe("enum");
    expect(findGeneratorKey("enabled_flag", "bit")).toBe("enum");
  });

  it("generates a bit string even when the generator key is missing", () => {
    // generateValue re-derives the key from the type, so the fallback path has
    // to produce a legal width too.
    const value = String(generateValue("plain_mask", "bit(8)", undefined, 0));
    expect(value).toMatch(/^[01]{8}$/);
  });

  it("formats the bit-string literal per dialect", () => {
    expect(formatGeneratedValue("10101010", "postgres", "bit(8)")).toBe("B'10101010'");
    expect(formatGeneratedValue("10101010", "kingbase", "bit(8)")).toBe("B'10101010'");
    expect(formatGeneratedValue("10101010", "mysql", "bit(8)")).toBe("b'10101010'");
    expect(formatGeneratedValue("101", "mysql", "bit varying(8)")).toBe("b'101'");
    // Unknown dialects keep the plain quoted string rather than an unparseable literal.
    expect(formatGeneratedValue("10101010", "sqlserver", "bit(8)")).toBe("'10101010'");
    // Non-bit columns are untouched.
    expect(formatGeneratedValue("10101010", "postgres", "varchar(8)")).toBe("'10101010'");
  });
});

describe("the full generate pipeline emits writable bit literals (#13014)", () => {
  function bitTableConfig() {
    const columns = [
      { columnName: "enabled_flag", dataType: "bit(1)" },
      { columnName: "plain_mask", dataType: "bit(8)" },
      { columnName: "flags", dataType: "bit varying(8)" },
    ].map(({ columnName, dataType }) => {
      const generatorKey = findGeneratorKey(columnName, dataType);
      return {
        columnName,
        dataType,
        rowCount: 3,
        generatorKey,
        generatorParams: defaultGeneratorParams(columnName, { dataType }, generatorKey),
      };
    });
    return { tableName: "dbx_bit_gen", schema: "public", database: "postgres", rowCount: 3, columns };
  }

  it("keeps the generator selection for each bit width", () => {
    expect(bitTableConfig().columns.map((column) => column.generatorKey)).toEqual(["enum", "bitmask", "bitmask"]);
  });

  it("writes B'...' literals with the declared width for PostgreSQL", () => {
    const { sql } = generateTableData(bitTableConfig(), "postgres");
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("dbx_bit_gen");
    const rows = sql.slice(sql.indexOf("VALUES")).match(/B'[01]+'/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const literal of rows) expect(literal).toMatch(/^B'[01]+'$/);
    // Every bit(1) value is one bit and every bit(8) value is eight.
    const [flag, mask] = [rows[0], rows[1]];
    expect(flag).toMatch(/^B'[01]'$/);
    expect(mask).toMatch(/^B'[01]{8}'$/);
  });

  it("writes b'...' literals for MySQL", () => {
    const { sql } = generateTableData(bitTableConfig(), "mysql");
    const rows = sql.match(/b'[01]+'/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0]).toMatch(/^b'[01]'$/);
    expect(rows[1]).toMatch(/^b'[01]{8}'$/);
  });
});
