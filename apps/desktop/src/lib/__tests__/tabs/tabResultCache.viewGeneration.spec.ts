import { describe, expect, it } from "vitest";
import { decodeTabResultSnapshot, encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import type { QueryResult } from "@/types/database";

function sampleResult(): QueryResult {
  return {
    columns: ["id", "name"],
    rows: [[1, "a"]],
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

describe("tab result cache view generation", () => {
  it("round-trips the tab-level view generation for a data tab with no runs", () => {
    const restored = decodeTabResultSnapshot(
      encodeTabResultSnapshot({
        result: sampleResult(),
        resultViewGeneration: "gen-data-tab",
        cachedAt: 1,
      }),
    );

    expect(restored?.resultViewGeneration).toBe("gen-data-tab");
  });

  it("round-trips the per-run view generation", () => {
    const restored = decodeTabResultSnapshot(
      encodeTabResultSnapshot({
        resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result: sampleResult(), resultViewGeneration: "gen-run" }],
        activeResultRunId: "run-1",
        cachedAt: 1,
      }),
    );

    expect(restored?.resultRuns?.[0]?.resultViewGeneration).toBe("gen-run");
  });
});
