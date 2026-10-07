import { describe, expect, it } from "vitest";
import { hasStaleQueuedRun, isHighRiskAcknowledged, rememberHighRiskAcknowledgement, resetHighRiskAcknowledgementsForTests, STALE_QUEUED_RUN_MS, workerNeedsAttention } from "./schedulerDraft";
import type { TaskRunStatus } from "./schedulerTypes";

function run(status: TaskRunStatus, ageMs: number) {
  return { status, createdAt: new Date(Date.now() - ageMs).toISOString() };
}

describe("hasStaleQueuedRun", () => {
  it("ignores fresh pre-running runs and terminal states", () => {
    const runs = [run("queued", 1000), run("starting", 2000), run("running", STALE_QUEUED_RUN_MS * 10), run("failed", STALE_QUEUED_RUN_MS * 10)];
    expect(hasStaleQueuedRun(runs)).toBe(false);
  });

  it("flags a queued or starting run past the claim window", () => {
    expect(hasStaleQueuedRun([run("queued", STALE_QUEUED_RUN_MS + 1)])).toBe(true);
    expect(hasStaleQueuedRun([run("starting", STALE_QUEUED_RUN_MS + 1)])).toBe(true);
    expect(hasStaleQueuedRun([run("running", STALE_QUEUED_RUN_MS + 1)])).toBe(false);
  });

  it("tolerates unparseable timestamps", () => {
    expect(hasStaleQueuedRun([{ status: "queued", createdAt: "not-a-date" }])).toBe(false);
  });
});

describe("workerNeedsAttention", () => {
  it("stays quiet without a worker report or a stale queue", () => {
    expect(workerNeedsAttention(null, true)).toBe(false);
    expect(workerNeedsAttention({ enabled: false, workerAlive: false }, false)).toBe(false);
  });

  it("warns when a disabled or dead worker should be claiming a stale run", () => {
    expect(workerNeedsAttention({ enabled: false, workerAlive: true }, true)).toBe(true);
    expect(workerNeedsAttention({ enabled: true, workerAlive: false }, true)).toBe(true);
    expect(workerNeedsAttention({ enabled: true, workerAlive: true }, true)).toBe(false);
  });
});

describe("high-risk acknowledgement memory", () => {
  it("remembers per task id and ignores blank ids", () => {
    resetHighRiskAcknowledgementsForTests();
    expect(isHighRiskAcknowledged("task-1")).toBe(false);
    rememberHighRiskAcknowledgement("task-1");
    rememberHighRiskAcknowledgement("");
    expect(isHighRiskAcknowledged("task-1")).toBe(true);
    expect(isHighRiskAcknowledged("task-2")).toBe(false);
    resetHighRiskAcknowledgementsForTests();
    expect(isHighRiskAcknowledged("task-1")).toBe(false);
  });
});
