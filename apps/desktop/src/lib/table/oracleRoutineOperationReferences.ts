import * as api from "@/lib/backend/api";

// Serialize ownership changes so a delayed release cannot undo a later retain.
let updates: Promise<void> = Promise.resolve();
const pendingReleases = new Set<string>();

function enqueue(update: () => Promise<void>): Promise<void> {
  const result = updates.then(update);
  updates = result.catch(() => {});
  return result;
}

async function flushReleases(): Promise<void> {
  while (pendingReleases.size) {
    const ids = [...pendingReleases].slice(0, 1024);
    await api.updateOracleRoutineOperationReferences([], ids);
    ids.forEach((id) => pendingReleases.delete(id));
  }
}

export function retainOracleRoutineOperations(ids: string[]): Promise<void> {
  return enqueue(async () => {
    ids.forEach((id) => pendingReleases.delete(id));
    // Failed cleanup is retried on normal lifecycle actions, never by a timer.
    await flushReleases().catch(() => {});
    if (ids.length) await api.updateOracleRoutineOperationReferences([...new Set(ids)], []);
  });
}

export function releaseOracleRoutineOperations(ids: string[]): Promise<void> {
  return enqueue(async () => {
    ids.forEach((id) => pendingReleases.add(id));
    await flushReleases();
  }).catch(() => {});
}
