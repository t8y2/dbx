import { describe, expect, it } from "vitest";
import { createSnowflakeIdGenerator, generateCellValues } from "@/lib/dataGrid/cellValueGeneration";

describe("generateCellValues", () => {
  it("generates empty strings and nulls", () => {
    expect(generateCellValues("empty", 2)).toEqual(["", ""]);
    expect(generateCellValues("null", 2)).toEqual([null, null]);
  });

  it("uses one local timestamp for the whole selection", () => {
    const now = new Date(2026, 6, 16, 9, 8, 7);
    expect(generateCellValues("datetime", 2, { now })).toEqual(["2026-07-16 09:08:07", "2026-07-16 09:08:07"]);
    expect(generateCellValues("date", 2, { now })).toEqual(["2026-07-16", "2026-07-16"]);
  });

  it("generates one UUID per cell", () => {
    let index = 0;
    expect(generateCellValues("uuid", 3, { uuidFactory: () => `uuid-${++index}` })).toEqual(["uuid-1", "uuid-2", "uuid-3"]);
  });

  it("increments values without losing bigint precision", () => {
    expect(generateCellValues("increment", 3, { startValue: 9_007_199_254_740_993n })).toEqual(["9007199254740993", "9007199254740994", "9007199254740995"]);
  });

  it("keeps snowflake IDs unique and ordered beyond one sequence window", () => {
    const generator = createSnowflakeIdGenerator({ workerId: 7, now: () => 1_800_000_000_000 });
    const values = generateCellValues("snowflake", 5000, { now: new Date(1_800_000_000_000), snowflakeGenerator: generator }) as string[];
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value, index) => index === 0 || BigInt(value) > BigInt(values[index - 1]))).toBe(true);
  });
});
