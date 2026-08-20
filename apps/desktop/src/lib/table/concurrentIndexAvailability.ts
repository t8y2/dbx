/**
 * Pure decision helper for the PostgreSQL `CREATE INDEX CONCURRENTLY` checkbox
 * in the table structure editor (PR #6361).
 *
 * Concurrent builds are scoped to *new* indexes on *non-partitioned* tables:
 * editing an existing index would require a `DROP INDEX CONCURRENTLY` +
 * `CREATE INDEX CONCURRENTLY` replace flow (not implemented), and PostgreSQL
 * rejects `CREATE INDEX CONCURRENTLY` on partitioned parent tables. The core
 * SQL builder enforces the same scope as a hard error, so this only decides
 * whether the option is actionable in the UI.
 */
export type ConcurrentIndexUnavailableReason = "existing" | "partitioned" | "unknown" | "primary" | "markedForDrop" | "unsupported";

export interface ConcurrentIndexAvailability {
  enabled: boolean;
  reason?: ConcurrentIndexUnavailableReason;
}

export interface ConcurrentIndexAvailabilityInput {
  /** The draft edits an index that already exists on the table. */
  hasOriginal: boolean;
  isPrimary: boolean;
  markedForDrop: boolean;
  /** `relkind = 'p'` partitioned parent table. */
  isPartitionedParent: boolean;
  /**
   * The partition status could not be verified (probe failed). Fail closed:
   * do not offer Concurrent when we cannot rule out a partitioned parent.
   */
  partitionStatusKnown: boolean;
  supportsIndexConcurrent: boolean;
  supportsCreateIndex: boolean;
}

export function getConcurrentIndexAvailability(input: ConcurrentIndexAvailabilityInput): ConcurrentIndexAvailability {
  if (input.markedForDrop) return { enabled: false, reason: "markedForDrop" };
  if (input.isPrimary) return { enabled: false, reason: "primary" };
  if (input.hasOriginal) return { enabled: false, reason: "existing" };
  if (input.isPartitionedParent) return { enabled: false, reason: "partitioned" };
  if (!input.partitionStatusKnown) return { enabled: false, reason: "unknown" };
  if (!input.supportsIndexConcurrent || !input.supportsCreateIndex) return { enabled: false, reason: "unsupported" };
  return { enabled: true };
}

/**
 * Unquoted index names referenced by `CREATE [UNIQUE] INDEX CONCURRENTLY`
 * statements, used to detect same-name INVALID leftovers before applying a
 * concurrent build. The PG builder emits the index name as a single
 * double-quoted identifier (optionally schema-qualified).
 */
export function concurrentIndexNamesInStatements(statements: string[]): string[] {
  const names: string[] = [];
  for (const sql of statements) {
    const match = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:(?:"[^"]+")\s*\.\s*)?"([^"]+)"/i);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/**
 * Report index drafts whose Concurrent availability is no longer `enabled`.
 * Definitive states (partitioned parent, existing index, capability loss, ...)
 * clear the stale flag. A transiently unknown partition status preserves the
 * user's intent so a later successful probe can restore the concurrent SQL.
 * Callers must gate save/SQL generation on every reported invalidation.
 */
export function normalizeUnsupportedConcurrentIndexes<IIndex extends { id: string; concurrently?: boolean }>(indexes: readonly IIndex[], availabilityResolver: (index: IIndex) => ConcurrentIndexAvailability): { indexes: IIndex[]; invalidatedIds: string[] } {
  const invalidatedIds: string[] = [];
  const normalized = indexes.map((index) => {
    if (!index.concurrently) return index;
    const availability = availabilityResolver(index);
    if (availability.enabled) return index;
    invalidatedIds.push(index.id);
    if (availability.reason === "unknown") return index;
    return { ...index, concurrently: false };
  });
  return { indexes: normalized, invalidatedIds };
}
