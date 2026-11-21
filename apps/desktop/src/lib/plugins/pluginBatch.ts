// Pure, testable helpers for batch plugin operations (install / update / uninstall).
// The component owns selection state and UI; this module owns the sequential execution
// and result aggregation so partial failures can be reported without aborting the batch.

export interface BatchItemOutcome {
  // Item identity, kept alongside the label so a caller can map a failure back to the item it came
  // from (retire a stale per-item banner, for instance) instead of string-matching the name.
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

export interface BatchOutcome {
  results: BatchItemOutcome[];
  succeeded: string[];
  failed: { id: string; name: string; error: string }[];
}

/**
 * Run `action` over `items` sequentially, recording per-item success/failure. A failing item is
 * captured and the batch continues; nothing is rolled back. `nameOf` supplies a human label used
 * in the summary and `idOf` the machine identity of the item. `onProgress` fires after every item
 * (success or failure) so callers can render live "(current/total)" progress. Empty input yields
 * an empty outcome.
 */
export async function runBatch<T>(items: readonly T[], nameOf: (item: T) => string, action: (item: T) => Promise<void>, idOf: (item: T) => string, onProgress?: (completed: number, total: number) => void): Promise<BatchOutcome> {
  const results: BatchItemOutcome[] = [];
  let completed = 0;
  for (const item of items) {
    // Identity (and label) are read before the action runs: a failed action may leave the item in a
    // state it can no longer be identified from, and the failure still has to name its own item.
    const id = idOf(item);
    const name = nameOf(item);
    try {
      await action(item);
      results.push({ id, name, ok: true });
    } catch (cause) {
      results.push({ id, name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
    completed += 1;
    onProgress?.(completed, items.length);
  }
  return {
    results,
    succeeded: results.filter((result) => result.ok).map((result) => result.name),
    failed: results.filter((result) => !result.ok).map((result) => ({ id: result.id, name: result.name, error: result.error ?? "" })),
  };
}

/**
 * Which marketplace listing statuses are actionable in a batch (a selectable plugin that is not yet
 * installed, or has an update). Installed / unsupported listings are not batch-selectable.
 */
export function isBatchSelectableListing(status: string): boolean {
  return status === "install" || status === "update";
}
