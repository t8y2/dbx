import type { DesktopAiRunRuntime } from "@/lib/ai/desktopAiRunRegistry";

export interface DesktopAiRunSnapshotSchedulerOptions<TMessage> {
  /** Durable save for one run. Runs while the previous save for the same run
   *  is still in flight are deferred, so call order equals write order.
   *  Rejections are swallowed by the scheduler - a failed save must never
   *  break the chain for the saves behind it. */
  persist: (run: DesktopAiRunRuntime<TMessage>) => Promise<void>;
  /** Minimum spacing between throttled saves for one run. Bounds how much
   *  streamed output a crash/quit can lose relative to the last durable
   *  snapshot. */
  intervalMs: number;
}

export interface DesktopAiRunSnapshotScheduler<TMessage = unknown> {
  /** Schedules a throttled save for a streaming run: at most one save per
   *  intervalMs, capturing whatever the run's state is when the timer fires
   *  (not when the flush that scheduled it happened). */
  schedule(run: DesktopAiRunRuntime<TMessage>): void;
  /** Saves immediately, strictly ordered after any save already queued or in
   *  flight for the run, so an older snapshot can never overwrite a newer
   *  one (saves are INSERT OR REPLACEs keyed by the same row). */
  save(run: DesktopAiRunRuntime<TMessage>): Promise<void>;
  /** Drops a pending throttled save - call when the run settles or is deleted,
   *  so a late fire cannot write stale state over the authoritative final
   *  save (or resurrect a deleted conversation). */
  cancel(runId: string): void;
}

// Streaming deltas used to live only in memory: a crash or quit mid-response
// lost everything after the last pre-stream snapshot. The scheduler persists
// snapshots incrementally from the delta flush path while keeping the writes
// cheap (throttled) and ordered (serialized per run).
export function createDesktopAiRunSnapshotScheduler<TMessage>(options: DesktopAiRunSnapshotSchedulerOptions<TMessage>): DesktopAiRunSnapshotScheduler<TMessage> {
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const chains = new Map<string, Promise<void>>();

  const enqueue = (run: DesktopAiRunRuntime<TMessage>): Promise<void> => {
    const chain = (chains.get(run.runId) ?? Promise.resolve())
      .then(() => {
        // Re-check discard at the actual execution point, not just at enqueue
        // time: the run may have been deleted while an earlier write in this
        // chain was still in flight. Without this re-check the queued save
        // would persist anyway and resurrect the deleted conversation via
        // INSERT OR REPLACE.
        if (run.discardOnFinish) return;
        return options.persist(run);
      })
      .catch(() => {})
      .finally(() => {
        if (chains.get(run.runId) === chain) chains.delete(run.runId);
      });
    chains.set(run.runId, chain);
    return chain;
  };

  return {
    schedule(run) {
      // A run the user deleted must never be written back - INSERT OR REPLACE
      // would resurrect the just-deleted conversation.
      if (run.discardOnFinish) return;
      if (pendingTimers.has(run.runId)) return;
      const timer = setTimeout(() => {
        pendingTimers.delete(run.runId);
        if (run.discardOnFinish) return;
        void enqueue(run);
      }, options.intervalMs);
      pendingTimers.set(run.runId, timer);
    },
    save(run) {
      // Same delete-resurrection guard as schedule(): no caller may persist a
      // discarded run, not even through the ordered path.
      if (run.discardOnFinish) return Promise.resolve();
      return enqueue(run);
    },
    cancel(runId) {
      const timer = pendingTimers.get(runId);
      if (timer === undefined) return;
      clearTimeout(timer);
      pendingTimers.delete(runId);
    },
  };
}
