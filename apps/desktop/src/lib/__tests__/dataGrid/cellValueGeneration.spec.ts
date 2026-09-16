import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnowflakeIdGenerator, generateCellValues } from "@/lib/dataGrid/cellValueGeneration";

describe("generateCellValues", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it.each([
    ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["uuid-v7", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
  ] as const)("generates distinct %s values for cells in the same millisecond", (kind, pattern) => {
    const values = generateCellValues(kind, 5000, { now: new Date(1_645_557_742_000) });

    expect(values).toHaveLength(5000);
    expect(values.every((value) => typeof value === "string" && pattern.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it("encodes the UUID v7 timestamp and random fields from the RFC 9562 test vector", () => {
    const values = generateCellValues("uuid-v7", 1, {
      now: new Date(1_645_557_742_000),
      uuidFactory: () => "11111111-2222-4cc3-98c4-dc0c0c07398f",
    });

    expect(values).toEqual(["017f22e2-79b0-7cc3-98c4-dc0c0c07398f"]);
  });

  it("pads early UUID v7 timestamps to 48 bits", () => {
    expect(
      generateCellValues("uuid-v7", 1, {
        now: new Date(1),
        uuidFactory: () => "11111111-2222-4cc3-98c4-dc0c0c07398f",
      }),
    ).toEqual(["00000000-0001-7cc3-98c4-dc0c0c07398f"]);
  });

  it("orders UUID v7 values by millisecond across a timestamp field boundary", () => {
    const [earlier] = generateCellValues("uuid-v7", 1, {
      now: new Date(0xffff_ffff),
      uuidFactory: () => "ffffffff-ffff-4fff-bfff-ffffffffffff",
    });
    const [later] = generateCellValues("uuid-v7", 1, {
      now: new Date(0x1_0000_0000),
      uuidFactory: () => "00000000-0000-4000-8000-000000000000",
    });

    expect(earlier).toBe("0000ffff-ffff-7fff-bfff-ffffffffffff");
    expect(later).toBe("00010000-0000-7000-8000-000000000000");
    expect(earlier! < later!).toBe(true);
  });

  it("generates UUID v7 values when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const values = generateCellValues("uuid-v7", 20, { now: new Date(1_645_557_742_000) });

    expect(values.every((value) => /^017f22e2-79b0-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value!))).toBe(true);
    expect(new Set(values).size).toBe(20);
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
