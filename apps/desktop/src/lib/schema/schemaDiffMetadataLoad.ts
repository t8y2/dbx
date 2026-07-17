const MYSQL_LARGE_SCHEMA_DIFF_METADATA_CONCURRENCY = 2;
const MYSQL_SMALL_SCHEMA_DIFF_METADATA_CONCURRENCY = 4;
const MYSQL_SMALL_SCHEMA_TABLE_LIMIT = 30;
const DEFAULT_SCHEMA_DIFF_METADATA_CONCURRENCY = 6;

function normalizeConcurrencyLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

export function schemaDiffMetadataConcurrency(dbType: string | null | undefined, tableCount?: number): number {
  const normalizedDbType = (dbType || "").toLowerCase();
  if (normalizedDbType === "mysql" || normalizedDbType === "mariadb") {
    if (typeof tableCount === "number" && tableCount <= MYSQL_SMALL_SCHEMA_TABLE_LIMIT) {
      return MYSQL_SMALL_SCHEMA_DIFF_METADATA_CONCURRENCY;
    }
    return MYSQL_LARGE_SCHEMA_DIFF_METADATA_CONCURRENCY;
  }
  return DEFAULT_SCHEMA_DIFF_METADATA_CONCURRENCY;
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const workerCount = Math.min(normalizeConcurrencyLimit(limit), items.length);
  if (workerCount === 0) return [];

  const results: R[] = [];
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  async function runWorker() {
    while (!hasError) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        hasError = true;
        firstError = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (hasError) throw firstError;
  return results;
}

export function createConcurrencyLimiter(limit: number) {
  const maxActive = normalizeConcurrencyLimit(limit);
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire() {
    if (active < maxActive) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  }

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
