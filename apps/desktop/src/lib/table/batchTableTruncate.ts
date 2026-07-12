export async function runBatchTableTruncate<T>(targets: readonly T[], execute: (target: T) => Promise<boolean | void>, refreshSucceeded: (targets: readonly T[]) => Promise<void>): Promise<void> {
  const succeeded: T[] = [];
  try {
    for (const target of targets) {
      if ((await execute(target)) !== false) succeeded.push(target);
    }
  } finally {
    // A later failure must not leave tabs for already truncated tables showing stale rows.
    if (succeeded.length > 0) await refreshSucceeded(succeeded);
  }
}
