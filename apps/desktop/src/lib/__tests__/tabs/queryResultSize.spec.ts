import { describe, expect, it } from "vitest";
import { estimateQueryResultBytes, estimateQueryResultsBytes, selectInactiveResultEvictions } from "@/lib/tabs/queryResultSize";

function result(rows: unknown[][]) {
  return { columns: ["value"], rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("query result size estimation", () => {
  it("grows with string and binary payloads", () => {
    const small = estimateQueryResultBytes(result([["a"]]));
    const large = estimateQueryResultBytes(result([["a".repeat(10_000)], [new Uint8Array(20_000)]]));
    expect(large).toBeGreaterThan(small + 30_000);
  });

  it("counts multiple results and tolerates cyclic document values", () => {
    const document: Record<string, unknown> = { name: "node" };
    document.self = document;
    const first = result([[document]]);
    const second = result(Array.from({ length: 100 }, (_, index) => [index]));
    expect(estimateQueryResultsBytes(undefined, [first, second])).toBeGreaterThan(estimateQueryResultBytes(first));
  });
});

describe("inactive result byte budgets", () => {
  it("evicts oldest small results to the count limit", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({ id: `${index}`, estimatedBytes: 10, accessedAt: index }));
    expect(selectInactiveResultEvictions(entries, 1_000, 5)).toEqual(["0", "1", "2"]);
  });

  it("evicts least-recently-used large results to the byte limit", () => {
    const entries = [
      { id: "old", estimatedBytes: 80, accessedAt: 1 },
      { id: "middle", estimatedBytes: 70, accessedAt: 2 },
      { id: "new", estimatedBytes: 60, accessedAt: 3 },
    ];
    expect(selectInactiveResultEvictions(entries, 100, 10)).toEqual(["old", "middle"]);
  });

  it("does not consider the active result even when it exceeds the budget", () => {
    const inactive = [{ id: "inactive", estimatedBytes: 10, accessedAt: 1 }];
    expect(selectInactiveResultEvictions(inactive, 100, 5)).toEqual([]);
  });
});
