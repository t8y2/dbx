/**
 * Editor completion reads table and column metadata through the same backend
 * gate as the sidebar. While a large schema is loading, `getColumns` can lose
 * the race for a pooled connection and fail after the gate's checkout timeout
 * with `DBX metadata pool is busy; please retry`. The completion path used to
 * give up on that first failure, so one busy window left the editor without
 * table or column suggestions until the user typed something else (dbx#14075).
 *
 * The gate is transient by design, so retry the same read a couple of times
 * with a short backoff instead of surfacing an empty candidate list. Retries
 * stay bounded: a genuinely unavailable connection (or a non-busy error) is
 * rethrown on the first attempt, and callers still drop a late result when the
 * request revision has moved on.
 */
export const COMPLETION_METADATA_RETRY_DELAYS_MS = [800, 2400] as const;

function metadataErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return message == null ? "" : String(message);
  }
  return error == null ? "" : String(error);
}

/**
 * The backend gate reports a busy pool either as the translated
 * `DBX metadata pool is busy; please retry` or, before translation, as the
 * driver's `connection pool checkout timed out` text. Both mean "try again
 * once the current metadata work drains", never "this table does not exist".
 */
export function isCompletionMetadataBusyError(error: unknown): boolean {
  const message = metadataErrorMessage(error).toLowerCase();
  return message.includes("dbx metadata pool is busy") || message.includes("connection pool checkout timed out");
}

export interface CompletionMetadataRetryEvent {
  kind: string;
  attempt: number;
  delayMs: number;
  error: string;
}

export interface CompletionMetadataRetryOptions {
  kind: string;
  delaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: CompletionMetadataRetryEvent) => void;
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryCompletionMetadata<T>(load: () => Promise<T>, options: CompletionMetadataRetryOptions): Promise<T> {
  const delays = options.delaysMs ?? COMPLETION_METADATA_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepFor;
  let attempt = 0;

  for (;;) {
    try {
      return await load();
    } catch (error) {
      const delayMs = delays[attempt];
      if (delayMs === undefined || !isCompletionMetadataBusyError(error)) throw error;
      attempt += 1;
      options.onRetry?.({ kind: options.kind, attempt, delayMs, error: metadataErrorMessage(error) });
      await sleep(delayMs);
    }
  }
}
