import { describe, expect, it } from "vitest";
import { isActiveResultLoading, type QueryResultLoadingStateLike } from "@/lib/sql/queryExecutionState";

function state(overrides: Partial<QueryResultLoadingStateLike> = {}): QueryResultLoadingStateLike {
  return {
    isExecuting: false,
    ...overrides,
  };
}

describe("active query result loading", () => {
  it("keeps the single-result execution loading", () => {
    expect(isActiveResultLoading(state({ isExecuting: true, executingResultRunId: null }))).toBe(true);
  });

  it("keeps the result run being updated loading", () => {
    expect(isActiveResultLoading(state({ isExecuting: true, activeResultRunId: "run-b", executingResultRunId: "run-b" }))).toBe(true);
  });

  it("does not load a completed result while a new run is executing", () => {
    expect(isActiveResultLoading(state({ isExecuting: true, activeResultRunId: "run-a", executingResultRunId: null }))).toBe(false);
  });

  it("loads again when the user switches back to the executing run", () => {
    expect(isActiveResultLoading(state({ isExecuting: true, activeResultRunId: "run-b", executingResultRunId: "run-b" }))).toBe(true);
  });

  it("clears loading after execution finishes", () => {
    expect(isActiveResultLoading(state({ isExecuting: false, activeResultRunId: "run-b", executingResultRunId: "run-b" }))).toBe(false);
  });

  it("keeps legacy unscoped executions conservative", () => {
    expect(isActiveResultLoading(state({ isExecuting: true, activeResultRunId: "run-a" }))).toBe(true);
  });
});
