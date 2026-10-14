/**
 * Side panel async request guard.
 *
 * Prevents stale async results (from a previous object or database context)
 * from overwriting the current panel state. Each context change bumps the
 * epoch; in-flight requests capture the epoch at start and compare before
 * writing results.
 */
import { waitForMetadata } from "@/lib/metadata/metadataLoadBudget";

export interface SidePanelRequestGuard {
  /** Bump the epoch, invalidating all previously captured epochs. */
  bump: () => void;
  /** Start a new request context and return its epoch. */
  start: () => number;
  /** Capture the current epoch for later staleness comparison. */
  capture: () => number;
  /** Returns true if the captured epoch is no longer current (request is stale). */
  isStale: (capturedEpoch: number) => boolean;
  /** Returns true if the captured epoch is still current (request is fresh). */
  isFresh: (capturedEpoch: number) => boolean;
  wait: <T>(capturedEpoch: number, promise: Promise<T>, timeoutMs: number) => Promise<T>;
}

export function createSidePanelRequestGuard(): SidePanelRequestGuard {
  let epoch = 0;
  let controller = new AbortController();
  const start = () => {
    epoch++;
    controller.abort(new Error("Metadata waiting cancelled locally."));
    controller = new AbortController();
    return epoch;
  };
  return {
    bump: start,
    start,
    capture: () => epoch,
    isStale: (capturedEpoch: number) => capturedEpoch !== epoch,
    isFresh: (capturedEpoch: number) => capturedEpoch === epoch,
    wait: (capturedEpoch, promise, timeoutMs) => {
      if (capturedEpoch !== epoch) {
        void promise.catch(() => undefined);
        return Promise.reject(new Error("Metadata waiting cancelled locally."));
      }
      return waitForMetadata(promise, timeoutMs, controller.signal);
    },
  };
}
