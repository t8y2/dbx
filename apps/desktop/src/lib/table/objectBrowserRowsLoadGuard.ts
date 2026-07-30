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
}

export function createObjectBrowserRowsLoadGuard(): ObjectBrowserRowsLoadGuard {
  let epoch = 0;
  return {
    invalidate: () => ++epoch,
    start: (scope) => ({ epoch: ++epoch, scope: Object.freeze({ ...scope }) }),
    isEpochCurrent: (capturedEpoch) => capturedEpoch === epoch,
    isCurrent: (handle) => handle.epoch === epoch,
  };
}
