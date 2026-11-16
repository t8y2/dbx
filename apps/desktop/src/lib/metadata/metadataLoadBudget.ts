/** Local metadata waiting stays bounded even when server query timeouts are disabled. */
export function metadataLoadBudgetMs(queryTimeoutSecs?: number): number {
  const seconds = Number(queryTimeoutSecs);
  if (seconds === 0) return 60_000;
  return Math.max(15_000, (Number.isFinite(seconds) && seconds > 0 ? seconds + 5 : 35) * 1000);
}

/** Ends local waiting; this does not assert that the server stopped its statement. */
export async function waitForMetadata<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason ?? new Error("Metadata waiting cancelled locally."));
        if (signal?.aborted) abort();
        else {
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new Error(`Metadata loading timed out after ${Math.ceil(timeoutMs / 1000)}s.`)), timeoutMs);
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
