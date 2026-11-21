import type { ObjectBrowserRowsCacheScope } from "@/lib/table/objectBrowserRowsCache";

export interface ObjectBrowserRowsLoadHandle {
  epoch: number;
  scope: Readonly<ObjectBrowserRowsCacheScope>;
}

export interface ObjectBrowserRowsLoadGuard {
  invalidate: () => number;
  start: (scope: ObjectBrowserRowsCacheScope) => ObjectBrowserRowsLoadHandle;
  isEpochCurrent: (epoch: number) => boolean;
  isCurrent: (handle: ObjectBrowserRowsLoadHandle) => boolean;
  wait: <T>(epoch: number, promise: Promise<T>, timeoutMs: number) => Promise<T>;
}

export function createObjectBrowserRowsLoadGuard(): ObjectBrowserRowsLoadGuard {
  let epoch = 0;
  const pending = new Set<() => void>();
  const invalidate = () => {
    epoch++;
    for (const cancel of pending) cancel();
    return epoch;
  };
  return {
    invalidate,
    start: (scope) => ({ epoch: invalidate(), scope: Object.freeze({ ...scope }) }),
    isEpochCurrent: (capturedEpoch) => capturedEpoch === epoch,
    isCurrent: (handle) => handle.epoch === epoch,
    async wait(capturedEpoch, promise, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            cancel = () => reject(new Error("Metadata waiting cancelled locally."));
            pending.add(cancel);
            if (capturedEpoch !== epoch) cancel();
            else timer = setTimeout(() => reject(new Error(`Metadata loading timed out after ${Math.ceil(timeoutMs / 1000)}s.`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(cancel);
      }
    },
  };
}
