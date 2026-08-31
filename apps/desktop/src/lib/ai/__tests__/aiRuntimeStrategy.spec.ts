import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDesktopAiRunSlot,
  activeDesktopAiRuns,
  blockingDesktopAiRunsForQuit,
  bumpDesktopAiRunSeq,
  cancelQueuedDesktopAiRun,
  desktopAiRun,
  finishDesktopAiRun,
  hasActiveDesktopAiRun,
  isTerminalDesktopAiRunStatus,
  registerDesktopAiRun,
  releaseDesktopAiRunSlot,
  resetDesktopAiRunRegistryForTests,
} from "@/lib/ai/desktopAiRunRegistry";
import { resolveAiRuntimeStrategy, supportsBackgroundAiRuns } from "@/lib/ai/aiRuntimeStrategy";

describe("AI runtime platform strategy", () => {
  afterEach(() => resetDesktopAiRunRegistryForTests());

  it("enables detached runs only for the Tauri desktop runtime", () => {
    expect(resolveAiRuntimeStrategy(true)).toBe("desktop-background");
    expect(supportsBackgroundAiRuns("desktop-background")).toBe(true);
    expect(resolveAiRuntimeStrategy(false)).toBe("web-cancel-on-navigation");
    expect(supportsBackgroundAiRuns("web-cancel-on-navigation")).toBe(false);
  });

  it("keeps a desktop run addressable by conversation until terminal", () => {
    const run = registerDesktopAiRun({
      runId: "run-1",
      conversationId: "conversation-1",
      sessionIds: ["session-1"],
      currentSessionId: "session-1",
      status: "running",
      messages: [{ content: "partial" }],
      assistantMessageIndex: 0,
      connectionId: "connection-1",
      connectionName: "local",
      database: "db",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      cancelRequested: false,
    });

    expect(desktopAiRun("conversation-1")).toBe(run);
    expect(activeDesktopAiRuns()).toEqual([run]);

    finishDesktopAiRun(run, "completed");
    expect(desktopAiRun("conversation-1")?.status).toBe("completed");
    expect(activeDesktopAiRuns()).toEqual([]);
  });

  it("admits at most three runs and lets a queued run be cancelled", async () => {
    const makeRun = (index: number) =>
      registerDesktopAiRun({
        runId: `run-${index}`,
        conversationId: `conversation-${index}`,
        sessionIds: [],
        currentSessionId: "",
        status: "preparing" as const,
        messages: [],
        assistantMessageIndex: -1,
        connectionId: `connection-${index}`,
        connectionName: "local",
        database: "db",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        cancelRequested: false,
      });

    const runs = [1, 2, 3, 4].map(makeRun);
    await Promise.all(runs.slice(0, 3).map(acquireDesktopAiRunSlot));
    const fourthAdmission = acquireDesktopAiRunSlot(runs[3]);
    expect(runs[3].status).toBe("queued");
    expect(cancelQueuedDesktopAiRun(runs[3])).toBe(true);
    await expect(fourthAdmission).resolves.toBe(false);

    runs.slice(0, 3).forEach((run) => releaseDesktopAiRunSlot(run.runId));
  });

  it("keeps a recovered pending-input run addressable without consuming a slot or blocking quit", async () => {
    const run = registerDesktopAiRun({
      runId: "run-recovered",
      conversationId: "conversation-1",
      sessionIds: [],
      currentSessionId: "",
      status: "pending_recoverable",
      messages: [],
      assistantMessageIndex: -1,
      connectionId: "connection-1",
      connectionName: "local",
      database: "db",
      pendingInput: "select * from orders",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      cancelRequested: false,
    });

    // Addressable (so the row can render "pending input"), but neither an
    // active run nor a quit-blocking one.
    expect(desktopAiRun("conversation-1")).toBe(run);
    expect(activeDesktopAiRuns()).toEqual([]);
    expect(blockingDesktopAiRunsForQuit()).toEqual([]);

    // It also does not consume a global concurrency slot: a fresh preparing run
    // is admitted immediately even though the recovered run is registered.
    const fresh = registerDesktopAiRun({
      runId: "run-fresh",
      conversationId: "conversation-2",
      sessionIds: [],
      currentSessionId: "",
      status: "preparing",
      messages: [],
      assistantMessageIndex: -1,
      connectionId: "connection-2",
      connectionName: "local",
      database: "db",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      cancelRequested: false,
    });
    const admission = acquireDesktopAiRunSlot(fresh);
    expect(fresh.status).toBe("preparing");
    await expect(admission).resolves.toBe(true);
    releaseDesktopAiRunSlot(fresh.runId);
  });

  it("assigns strictly increasing event seqs that persist on the run", () => {
    const run = registerDesktopAiRun({
      runId: "run-seq",
      conversationId: "conversation-1",
      sessionIds: ["session-1", "session-2"],
      currentSessionId: "session-2",
      status: "running",
      messages: [],
      assistantMessageIndex: -1,
      connectionId: "connection-1",
      connectionName: "local",
      database: "db",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      cancelRequested: false,
    });

    // Parent PRD §8: seq starts at 1 and strictly increases across sessions.
    expect(bumpDesktopAiRunSeq(run)).toBe(1);
    expect(bumpDesktopAiRunSeq(run)).toBe(2);
    expect(run.maxSeq).toBe(2);

    // A recovered run with a persisted maxSeq continues from there.
    run.maxSeq = 40;
    expect(bumpDesktopAiRunSeq(run)).toBe(41);
    expect(desktopAiRun("conversation-1")?.maxSeq).toBe(41);
  });

  it("treats every non-terminal status as active for queue-send, including pending_recoverable", () => {
    const statuses = ["preparing", "queued", "running", "awaiting_write_confirmation", "pending_recoverable"] as const;
    for (const status of statuses) {
      registerDesktopAiRun({
        runId: `run-${status}`,
        conversationId: `conversation-${status}`,
        sessionIds: [],
        currentSessionId: "",
        status,
        messages: [],
        assistantMessageIndex: -1,
        connectionId: "connection-1",
        connectionName: "local",
        database: "db",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        cancelRequested: false,
      });
      expect(hasActiveDesktopAiRun(`conversation-${status}`)).toBe(true);
    }
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      const run = registerDesktopAiRun({
        runId: `run-${status}`,
        conversationId: `conversation-${status}`,
        sessionIds: [],
        currentSessionId: "",
        status,
        messages: [],
        assistantMessageIndex: -1,
        connectionId: "connection-1",
        connectionName: "local",
        database: "db",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        cancelRequested: false,
      });
      expect(hasActiveDesktopAiRun(`conversation-${status}`)).toBe(false);
      finishDesktopAiRun(run, "completed");
    }
  });

  it("classifies terminal statuses for the stop-wait logic (isTerminalDesktopAiRunStatus)", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalDesktopAiRunStatus(status)).toBe(true);
    }
    // `interrupted` is a persisted-row-only pseudo status, never a runtime one.
    for (const status of ["preparing", "queued", "running", "awaiting_write_confirmation", "pending_recoverable"] as const) {
      expect(isTerminalDesktopAiRunStatus(status)).toBe(false);
    }
  });
});
