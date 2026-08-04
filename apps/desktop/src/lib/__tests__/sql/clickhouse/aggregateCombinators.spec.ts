import { describe, expect, it } from "vitest";
import { generateAggregateCombinatorCandidates } from "@/lib/sql/clickhouse/aggregateCombinators";
import { CLICKHOUSE_FUNCTION_REGISTRY } from "@/lib/sql/clickhouse/functionRegistry";

describe("ClickHouse aggregate combinators", () => {
  it("generates If with an appended condition argument", () => {
    const sumIf = generateAggregateCombinatorCandidates("sumIf", 20).find((item) => item.name === "sumIf");
    expect(sumIf?.signatures[0].parameterGroups).toEqual([["value", "condition"]]);
  });

  it("allows Array before If and rejects the reverse order", () => {
    expect(generateAggregateCombinatorCandidates("uniqArrayIf", 20).some((item) => item.name === "uniqArrayIf")).toBe(true);
    expect(generateAggregateCombinatorCandidates("uniqIfArray", 20).some((item) => item.name === "uniqIfArray")).toBe(false);
  });

  it("preserves parametric aggregate groups for State", () => {
    const state = generateAggregateCombinatorCandidates("quantilesTDigestState", 20).find((item) => item.name === "quantilesTDigestState");
    expect(state?.signatures[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
  });

  it("bounds generated results", () => {
    expect(generateAggregateCombinatorCandidates("", 7)).toHaveLength(7);
  });

  it("does not generate aggregate combinators for window functions", () => {
    for (const name of ["rankIf", "denseRankState", "percentRankIf", "cume_distState", "ntileIf"] as const) {
      expect(generateAggregateCombinatorCandidates(name, 20).some((item) => item.name === name)).toBe(false);
    }
  });
});

it("contains ordinary and parametric aggregate definitions", () => {
  expect(CLICKHOUSE_FUNCTION_REGISTRY.get("uniqExact")).toMatchObject({ kind: "aggregate" });
  expect(CLICKHOUSE_FUNCTION_REGISTRY.get("quantilesTDigest")?.signatures[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
});
