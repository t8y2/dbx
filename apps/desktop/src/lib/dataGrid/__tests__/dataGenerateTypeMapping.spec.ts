import { describe, expect, it } from "vitest";
import { defaultGeneratorParams, findGeneratorKey, generateValue, isBooleanColumnType, normalizeColumnDataType } from "@/lib/dataGrid/dataGenerate";

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
    ["bit(8)", "enum"],
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
