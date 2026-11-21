import { describe, expect, it } from "vitest";
import { resolveDataGridBusyStartedAt } from "@/lib/dataGrid/dataGridBusyElapsed";

describe("resolveDataGridBusyStartedAt", () => {
  it("re-bases a remounted grid on the running query instead of the mount time", () => {
    // Issue #12821: switching the result view unmounts the grid mid-execution,
    // so the fresh instance has no baseline of its own. The tab's execution
    // start must win over "the surface became busy just now".
    const executionStartedAt = 1_000;
    const now = 5_000;
    expect(resolveDataGridBusyStartedAt({ now, reset: true, currentStartedAt: 0, executionStartedAt })).toBe(executionStartedAt);
  });

  it("keeps the query start when the surface stays busy across a re-base", () => {
    const executionStartedAt = 1_000;
    expect(resolveDataGridBusyStartedAt({ now: 9_000, reset: false, currentStartedAt: 8_500, executionStartedAt })).toBe(executionStartedAt);
  });

  it("starts a busy period that no query execution drives at the current time", () => {
    expect(resolveDataGridBusyStartedAt({ now: 4_200, reset: true, currentStartedAt: 0 })).toBe(4_200);
  });

  it("preserves an in-flight non-query busy period when the grid resumes", () => {
    expect(resolveDataGridBusyStartedAt({ now: 4_200, reset: false, currentStartedAt: 3_000 })).toBe(3_000);
  });

  it("starts a non-query busy period now when no baseline was captured yet", () => {
    expect(resolveDataGridBusyStartedAt({ now: 4_200, reset: false, currentStartedAt: 0 })).toBe(4_200);
  });

  it("clamps a future execution start so the elapsed pill never goes negative", () => {
    expect(resolveDataGridBusyStartedAt({ now: 4_200, reset: true, currentStartedAt: 0, executionStartedAt: 9_000 })).toBe(4_200);
  });

  it("ignores a non-finite execution start", () => {
    expect(resolveDataGridBusyStartedAt({ now: 4_200, reset: true, currentStartedAt: 0, executionStartedAt: Number.NaN })).toBe(4_200);
  });
});
