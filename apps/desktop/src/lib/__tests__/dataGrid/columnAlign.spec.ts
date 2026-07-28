import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNumericColumnType } from "@/lib/dataGrid/dataGridColumnType";

interface NumericColumnTypeFixture {
  backend: string;
  type: string;
}

interface NumericColumnTypeFixtures {
  numeric: NumericColumnTypeFixture[];
  nonNumeric: NumericColumnTypeFixture[];
}

const actualBackendTypeFixtures = JSON.parse(readFileSync(new URL("../../../../../../tests/fixtures/data-grid-numeric-column-types.json", import.meta.url), "utf8")) as NumericColumnTypeFixtures;

describe("isNumericColumnType", () => {
  it("recognizes core numeric types", () => {
    expect(isNumericColumnType("int")).toBe(true);
    expect(isNumericColumnType("integer")).toBe(true);
    expect(isNumericColumnType("bigint")).toBe(true);
    expect(isNumericColumnType("smallint")).toBe(true);
    expect(isNumericColumnType("decimal")).toBe(true);
    expect(isNumericColumnType("numeric")).toBe(true);
    expect(isNumericColumnType("number")).toBe(true);
    expect(isNumericColumnType("float")).toBe(true);
    expect(isNumericColumnType("double")).toBe(true);
    expect(isNumericColumnType("real")).toBe(true);
    expect(isNumericColumnType("money")).toBe(true);
    expect(isNumericColumnType("smallmoney")).toBe(true);
  });

  it("recognizes types with precision/scale suffix", () => {
    expect(isNumericColumnType("decimal(10,2)")).toBe(true);
    expect(isNumericColumnType("numeric(18,6)")).toBe(true);
    expect(isNumericColumnType("int(11)")).toBe(true);
    expect(isNumericColumnType("bigint(20)")).toBe(true);
    expect(isNumericColumnType("float(53)")).toBe(true);
  });

  it("recognizes serial, int aliases, and Oracle types", () => {
    expect(isNumericColumnType("serial")).toBe(true);
    expect(isNumericColumnType("bigserial")).toBe(true);
    expect(isNumericColumnType("int2")).toBe(true);
    expect(isNumericColumnType("int4")).toBe(true);
    expect(isNumericColumnType("int8")).toBe(true);
    expect(isNumericColumnType("binary_float")).toBe(true);
    expect(isNumericColumnType("binary_double")).toBe(true);
  });

  it("recognizes unsigned and ClickHouse types", () => {
    expect(isNumericColumnType("uint8")).toBe(true);
    expect(isNumericColumnType("uint64")).toBe(true);
    expect(isNumericColumnType("float32")).toBe(true);
    expect(isNumericColumnType("float64")).toBe(true);
  });

  it("recognizes ClickHouse big integer and decimal types", () => {
    expect(isNumericColumnType("Int128")).toBe(true);
    expect(isNumericColumnType("Int256")).toBe(true);
    expect(isNumericColumnType("UInt128")).toBe(true);
    expect(isNumericColumnType("UInt256")).toBe(true);
    expect(isNumericColumnType("Decimal32")).toBe(true);
    expect(isNumericColumnType("Decimal64")).toBe(true);
    expect(isNumericColumnType("Decimal128")).toBe(true);
    expect(isNumericColumnType("Decimal256")).toBe(true);
    expect(isNumericColumnType("Float16")).toBe(true);
  });

  it("recognizes SQL Server internal type names", () => {
    expect(isNumericColumnType("decimaln")).toBe(true);
    expect(isNumericColumnType("numericn")).toBe(true);
    expect(isNumericColumnType("intn")).toBe(true);
    expect(isNumericColumnType("floatn")).toBe(true);
    expect(isNumericColumnType("moneyn")).toBe(true);
    expect(isNumericColumnType("smallmoneyn")).toBe(true);
  });

  it("rejects non-numeric types", () => {
    expect(isNumericColumnType("varchar")).toBe(false);
    expect(isNumericColumnType("text")).toBe(false);
    expect(isNumericColumnType("date")).toBe(false);
    expect(isNumericColumnType("timestamp")).toBe(false);
    expect(isNumericColumnType("boolean")).toBe(false);
    expect(isNumericColumnType("blob")).toBe(false);
    expect(isNumericColumnType("json")).toBe(false);
    expect(isNumericColumnType("uuid")).toBe(false);
  });

  it("handles edge cases", () => {
    expect(isNumericColumnType(undefined)).toBe(false);
    expect(isNumericColumnType("")).toBe(false);
    expect(isNumericColumnType("DECIMAL")).toBe(true); // case-insensitive
    expect(isNumericColumnType("  decimal(10,2)  ")).toBe(true); // whitespace tolerant
  });

  it("recognizes dec and fixed aliases", () => {
    expect(isNumericColumnType("dec")).toBe(true);
    expect(isNumericColumnType("fixed")).toBe(true);
  });

  it("covers the full cross-database numeric whitelist used by the alignment classifier", () => {
    // Cross-database coverage matrix. Every entry here MUST stay in sync with
    // the Rust classifier in crates/dbx-core/src/xlsx_export.rs so that the
    // grid, the front-end XLSX exporter and the Rust XLSX exporter agree.
    const numericTypesByDatabase: Record<string, string[]> = {
      mysql: ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "float", "double", "decimal", "dec", "fixed"],
      postgres: ["smallint", "integer", "bigint", "serial", "smallserial", "bigserial", "int2", "int4", "int8", "real", "double precision", "money", "numeric"],
      oracle: ["number", "binary_float", "binary_double", "float"],
      dameng: ["number", "binary_float", "binary_double"],
      "sql-server": ["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real", "intn", "decimaln", "numericn", "floatn", "moneyn", "smallmoneyn"],
      clickhouse: ["Int8", "Int16", "Int32", "Int64", "Int128", "Int256", "UInt8", "UInt16", "UInt32", "UInt64", "UInt128", "UInt256", "Float32", "Float64", "Decimal32", "Decimal64", "Decimal128", "Decimal256"],
      sqlite: ["integer", "real", "numeric", "decimal"],
      hana: ["tinyint", "smallint", "integer", "bigint", "decimal", "real", "double"],
    };

    for (const types of Object.values(numericTypesByDatabase)) {
      for (const type of types) {
        expect(isNumericColumnType(type)).toBe(true);
      }
    }
  });

  it("classifies actual backend type names from the shared fixture", () => {
    for (const fixture of actualBackendTypeFixtures.numeric) {
      expect(isNumericColumnType(fixture.type), `${fixture.backend}: ${fixture.type}`).toBe(true);
    }
    for (const fixture of actualBackendTypeFixtures.nonNumeric) {
      expect(isNumericColumnType(fixture.type), `${fixture.backend}: ${fixture.type}`).toBe(false);
    }
  });

  it("keeps text/date/binary/json types left-aligned", () => {
    // Sanity check that non-numeric types stay left-aligned across databases.
    const nonNumericTypes = [
      "varchar(255)",
      "text",
      "char(10)",
      "nvarchar(100)",
      "nchar(10)",
      "clob",
      "blob",
      "binary",
      "varbinary",
      "bytea",
      "date",
      "datetime",
      "datetime2",
      "datetimeoffset",
      "timestamp",
      "timestamptz",
      "time",
      "boolean",
      "bool",
      "bit",
      "json",
      "jsonb",
      "uuid",
      "enum('a','b')",
      "inet",
      "cidr",
      "macaddr",
      "xml",
      "geometry",
      "geography",
      "hierarchyid",
      "sql_variant",
    ];
    for (const type of nonNumericTypes) {
      expect(isNumericColumnType(type)).toBe(false);
    }
  });

  it("strips precision, scale and array suffixes before classification", () => {
    expect(isNumericColumnType("decimal(18, 4)")).toBe(true);
    expect(isNumericColumnType("numeric(38)")).toBe(true);
    expect(isNumericColumnType("int(11) unsigned")).toBe(true);
    expect(isNumericColumnType("bigint(20)")).toBe(true);
    expect(isNumericColumnType("float(53)")).toBe(true);
    expect(isNumericColumnType("Decimal128(18, 2)")).toBe(true);
    expect(isNumericColumnType("varchar(255)")).toBe(false);
    expect(isNumericColumnType("decimal[]")).toBe(true);
  });
});

describe("columnAligns derivation (mirrors DataGrid.vue)", () => {
  // Replicates the columnAligns computed property in DataGrid.vue:
  //   - empty array when numeric right alignment is disabled (or transpose on)
  //   - "right" for numeric types, "left" otherwise
  function deriveColumnAligns(visibleColumnTypes: Array<string | undefined>, numericRightAlign: boolean): Array<"left" | "right"> {
    if (!numericRightAlign) return [];
    return visibleColumnTypes.map((type) => (isNumericColumnType(type) ? "right" : "left"));
  }

  it("returns an empty array when numeric right alignment is disabled", () => {
    expect(deriveColumnAligns(["int", "varchar"], false)).toEqual([]);
  });

  it("right-aligns numeric columns and left-aligns the rest", () => {
    expect(deriveColumnAligns(["int", "varchar", "decimal(10,2)", "date", "bigint"], true)).toEqual(["right", "left", "right", "left", "right"]);
  });

  it("handles undefined types as left-aligned", () => {
    expect(deriveColumnAligns([undefined, "int", undefined], true)).toEqual(["left", "right", "left"]);
  });

  it("keeps every column left-aligned when only text types are present", () => {
    expect(deriveColumnAligns(["varchar", "text", "json"], true)).toEqual(["left", "left", "left"]);
  });

  it("keeps every column right-aligned when only numeric types are present", () => {
    expect(deriveColumnAligns(["int", "decimal", "bigint"], true)).toEqual(["right", "right", "right"]);
  });

  it("treats cross-database numeric types consistently with the classifier", () => {
    const aligns = deriveColumnAligns(["Int128", "UInt256", "Decimal128(18, 2)", "BINARY_FLOAT", "BINARY_DOUBLE", "decimaln", "varchar"], true);
    expect(aligns).toEqual(["right", "right", "right", "right", "right", "right", "left"]);
  });
});
