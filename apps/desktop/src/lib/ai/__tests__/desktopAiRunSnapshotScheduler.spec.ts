import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopAiRunSnapshotScheduler } from "@/lib/ai/desktopAiRunSnapshotScheduler";
import type { DesktopAiRunRuntime } from "@/lib/ai/desktopAiRunRegistry";

function makeRun(overrides: Partial<DesktopAiRunRuntime> = {}): DesktopAiRunRuntime {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    sessionIds: [],
    currentSessionId: "",
    status: "running",
    messages: [],
    assistantMessageIndex: -1,
    connectionId: "connection-1",
    connectionName: "local",
    database: "db",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    cancelRequested: false,
    ...overrides,
  };
}

// Finding 1 regression coverage: detached streaming deltas used to live only
// in memory (a crash/quit mid-response lost everything after the last
// pre-stream snapshot). The scheduler persists snapshots incrementally from
// the delta flush path - throttled to keep writes cheap, serialized per run so
// a slow write can never let an older snapshot overwrite a newer one.
describe("desktop AI run snapshot scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("throttles streaming flushes to one durable save per interval, capturing state at fire time", async () => {
    const persistedContentLengths: number[] = [];
    const run = makeRun();
    const scheduler = createDesktopAiRunSnapshotScheduler({
      persist: async () => {
        persistedContentLengths.push(run.messages.length);
      },
      intervalMs: 2000,
    });

    run.messages.push({ content: "a" });
    scheduler.schedule(run);
    // Further flushes inside the window must not stack extra timers.
    run.messages.push({ content: "b" });
    scheduler.schedule(run);
    run.messages.push({ content: "c" });
    scheduler.schedule(run);

    await vi.advanceTimersByTimeAsync(1999);
    expect(persistedContentLengths).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The save reads the run's state when the timer fires (3 messages), not at
    // schedule time - so a crash after the first flush still persists the tail.
    expect(persistedContentLengths).toEqual([3]);
  });

  it("re-arms after each save so a long stream keeps snapshotting", async () => {
    const persisted: number[] = [];
    const run = makeRun();
    const scheduler = createDesktopAiRunSnapshotScheduler({
      persist: async () => {
        persisted.push(run.messages.length);
      },
      intervalMs: 2000,
    });

    scheduler.schedule(run);
    await vi.advanceTimersByTimeAsync(2000);
    expect(persisted).toEqual([0]);
    run.messages.push({ content: "late" });
    scheduler.schedule(run);
    await vi.advanceTimersByTimeAsync(2000);
    expect(persisted).toEqual([0, 1]);
  });

  it("serializes saves so an older in-flight snapshot can never overwrite a newer one", async () => {
    const callOrder: number[] = [];
    let resolveFirst!: () => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(() => {
        callOrder.push(1);
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce(() => {
        callOrder.push(2);
        return Promise.resolve();
      });
    const scheduler = createDesktopAiRunSnapshotScheduler({ persist, intervalMs: 2000 });
    const run = makeRun();

    const first = scheduler.save(run);
    run.status = "completed";
    const second = scheduler.save(run);

    // The newer save must not start (let alone finish) before the older one
    // resolves - saves are INSERT OR REPLACEs keyed by the same run row.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(persist).toHaveBeenCalledTimes(1);
    resolveFirst();
    await Promise.all([first, second]);
    expect(callOrder).toEqual([1, 2]);
  });

  it("skips a queued save if the run is deleted while a prior write is still in flight", async () => {
    // Reviewed finding (delete-resurrection race): a save() that was enqueued
    // behind a slow in-flight write was NOT re-checked for discardOnFinish at
    // execution time. The delete path commits its DELETE first, so the queued
    // save firing afterwards recreated the just-deleted conversation via
    // INSERT OR REPLACE. The discard marker must be checked at the actual
    // execution point, not just at enqueue time.
    const persist = vi.fn(async () => {});
    let resolveFirst!: () => void;
    persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const scheduler = createDesktopAiRunSnapshotScheduler({ persist, intervalMs: 2000 });
    const run = makeRun();

    // First save: flush the microtask so the write actually starts (and blocks
    // on the pending mock) BEFORE the second is enqueued behind it.
    const first = scheduler.save(run);
    await Promise.resolve();
    const second = scheduler.save(run);
    // The user deletes the conversation while the first write is still running.
    run.discardOnFinish = true;
    resolveFirst();

    await Promise.all([first, second]);
    // Only the already-executing first write persisted; the queued one skipped.
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("never persists a run the user deleted (discardOnFinish), even through the ordered path", async () => {
    const persist = vi.fn(async () => {});
    const scheduler = createDesktopAiRunSnapshotScheduler({ persist, intervalMs: 2000 });

    scheduler.schedule(makeRun({ discardOnFinish: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(persist).not.toHaveBeenCalled();

    // A run deleted after scheduling must be skipped when the timer fires.
    const run = makeRun();
    scheduler.schedule(run);
    run.discardOnFinish = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(persist).not.toHaveBeenCalled();

    // save() on a discarded run is also a no-op (delete-resurrection guard).
    await scheduler.save(makeRun({ discardOnFinish: true }));
    expect(persist).not.toHaveBeenCalled();
  });

  it("cancel() drops a pending throttled save so a late fire cannot write stale state", async () => {
    const persist = vi.fn(async () => {});
    const scheduler = createDesktopAiRunSnapshotScheduler({ persist, intervalMs: 2000 });

    const run = makeRun();
    scheduler.schedule(run);
    scheduler.cancel(run.runId);
    await vi.advanceTimersByTimeAsync(5000);
    expect(persist).not.toHaveBeenCalled();
  });
});
