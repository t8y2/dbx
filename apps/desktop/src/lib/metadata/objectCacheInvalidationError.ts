/**
 * Error marker for strict object-cache invalidation failures.
 *
 * Best-effort invalidation callers keep swallowing persistence errors, so the
 * only signal a strict caller (connection-node refresh) can rely on is an
 * explicitly marked error. Detection is name-based rather than instanceof so
 * duplicated module instances (tests reset modules) still match.
 */

export interface ObjectCacheInvalidationOptions {
  /** Propagate persistence deletion failures instead of swallowing them. */
  strict?: boolean;
}

const OBJECT_CACHE_INVALIDATION_ERROR_NAME = "ObjectCacheInvalidationError";

export class ObjectCacheInvalidationError extends Error {
  readonly code = "OBJECT_CACHE_INVALIDATION_FAILED";
  /** Cache prefix whose persisted deletion failed. */
  readonly scope: string;
  /** Original error thrown by the deletion. */
  readonly reason: unknown;

  constructor(message: string, scope: string, reason?: unknown) {
    super(message);
    this.name = OBJECT_CACHE_INVALIDATION_ERROR_NAME;
    this.scope = scope;
    this.reason = reason;
  }
}

export function isObjectCacheInvalidationError(value: unknown): value is ObjectCacheInvalidationError {
  return value instanceof Error && value.name === OBJECT_CACHE_INVALIDATION_ERROR_NAME;
}

/** Wrap a deletion failure, passing through an already-marked error unchanged. */
export function toObjectCacheInvalidationError(error: unknown, scope: string): ObjectCacheInvalidationError {
  if (isObjectCacheInvalidationError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ObjectCacheInvalidationError(message, scope, error);
}
