// Pure, testable helpers for batch plugin operations (install / update / uninstall).
// The component owns selection state and UI; this module owns the sequential execution
// and result aggregation so partial failures can be reported without aborting the batch.

export interface BatchItemOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface BatchOutcome {
  results: BatchItemOutcome[];
  succeeded: string[];
  failed: { name: string; error: string }[];
}

/**
 * Run `action` over `items` sequentially, recording per-item success/failure. A failing item is
 * captured and the batch continues; nothing is rolled back. `nameOf` supplies a human label used
 * in the summary. Empty input yields an empty outcome.
 */
export async function runBatch<T>(items: readonly T[], nameOf: (item: T) => string, action: (item: T) => Promise<void>): Promise<BatchOutcome> {
  const results: BatchItemOutcome[] = [];
  for (const item of items) {
    const name = nameOf(item);
    try {
      await action(item);
      results.push({ name, ok: true });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return {
    results,
    succeeded: results.filter((result) => result.ok).map((result) => result.name),
    failed: results.filter((result) => !result.ok).map((result) => ({ name: result.name, error: result.error ?? "" })),
  };
}

/**
 * Which marketplace listing statuses are actionable in a batch (a selectable plugin that is not yet
 * installed, or has an update). Installed / unsupported listings are not batch-selectable.
 */
export function isBatchSelectableListing(status: string): boolean {
  return status === "install" || status === "update";
}
