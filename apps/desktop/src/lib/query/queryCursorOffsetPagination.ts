import type { QueryResult } from "@/types/database";

/** Reach an offset using a forward-only cursor, keeping only the requested page. */
export async function executeCursorOffsetPage(options: {
  offset: number;
  limit: number;
  fetchPage: (pageSize: number, sessionId?: string) => Promise<QueryResult[]>;
  closeSession: (sessionId: string) => Promise<unknown>;
  isCancelled: () => boolean;
  releaseResults?: (results: QueryResult[]) => Promise<void>;
}): Promise<QueryResult[]> {
  let sessionId: string | undefined;
  let skipped = 0;
  let pageCount = 0;
  let executionMs = 0;
  let completeTimings = true;
  let provenReadOnly: true | undefined;
  const timings: Record<string, number> = {};
  let pendingResults: QueryResult[] = [];
  const discardPending = async () => {
    const discarded = pendingResults;
    pendingResults = [];
    await options.releaseResults?.(discarded);
  };
  try {
    while (true) {
      if (options.isCancelled()) throw new Error("Query canceled");
      // The global row cap can shorten the final page. Stop exactly at the
      // offset instead of overshooting it with that shortened page size.
      const pageSize = skipped < options.offset ? Math.min(options.limit, options.offset - skipped) : options.limit;
      const results = await options.fetchPage(pageSize, sessionId);
      pendingResults = results;
      const page = results[0];
      if (!page) {
        if (sessionId) throw new Error("Result session ended before the requested page offset");
        return results;
      }
      // Keep the previous cursor available for cleanup if a malformed response
      // promises more rows without returning its session.
      sessionId = page.session_id ?? (page.has_more ? sessionId : undefined);
      if (options.isCancelled()) throw new Error("Query canceled");
      if (page.has_more && !page.session_id) throw new Error("Result session ended before the requested page offset");
      if (pageCount === 0) provenReadOnly = page.manual_transaction_proven_read_only;
      pageCount += 1;
      executionMs += page.execution_time_ms;
      if (!page.query_timings_ms) completeTimings = false;
      else for (const [key, value] of Object.entries(page.query_timings_ms)) timings[key] = (timings[key] ?? 0) + value;
      const result = {
        ...page,
        // Cursor fetches do not classify SQL; keep the initial execution's proof.
        manual_transaction_proven_read_only: provenReadOnly,
        query_timings_ms: completeTimings ? { ...timings } : undefined,
        execution_time_ms: executionMs,
        timing_page_count: pageCount,
      };
      if (skipped === options.offset && (page.rows.length > 0 || !page.has_more)) return [result];
      if (page.rows.length > pageSize) throw new Error("Result page exceeded the requested cursor page size");
      skipped += page.rows.length;
      if (!page.has_more) {
        await discardPending();
        return [{ ...result, rows: [], large_value_cells: [], large_value_refs: [] }];
      }
      await discardPending();
      // Cassandra can return empty intermediate pages with a valid next cursor.
      // Continue advancing that cursor until rows arrive or it is exhausted.
    }
  } catch (error) {
    try {
      await discardPending();
    } catch (releaseError) {
      console.warn("[DBX][offset-replay-large-value-release:error]", releaseError);
    }
    if (sessionId) {
      try {
        await options.closeSession(sessionId);
      } catch (closeError) {
        console.warn("[DBX][offset-replay-session-close:error]", { sessionId, error: closeError });
      }
    }
    throw error;
  }
}
