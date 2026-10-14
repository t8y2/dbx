import type { QueryResult, QueryResultRun, QueryTab } from "@/types/database";
import { inlineQueryResultSnapshots, type InlineQueryResult } from "./inlineQueryResults";

export interface InlineQueryResultEntry extends InlineQueryResult {
  index: number;
  run?: QueryResultRun;
}
/** New executions replace overlapping statement slots, not the whole editor. */
export function inlineQueryResultEntries(tab: QueryTab, previous: InlineQueryResult[] = []): InlineQueryResultEntry[] {
  let entries: InlineQueryResultEntry[] = [];
  function add(results: QueryResult[], run?: QueryResultRun) {
    results.forEach((result, index) => {
      const snapshot = inlineQueryResultSnapshots(tab.sql, [result], previous)[0];
      if (!snapshot) return;
      entries = entries.filter((old) => old.to <= snapshot.from || old.from >= snapshot.to);
      entries.push({ ...snapshot, index, run });
    });
  }
  for (const run of [...(tab.resultRuns ?? [])].sort((a, b) => a.sequence - b.sequence)) {
    // During execution the tab receives the incoming payload before its new
    // run is captured. It must not overwrite the previous active run's slots.
    add(run.id === tab.activeResultRunId && !tab.isExecuting ? (tab.results ?? (tab.result ? [tab.result] : [])) : (run.results ?? (run.result ? [run.result] : [])), run);
  }
  if (!tab.activeResultRunId) add(tab.results ?? (tab.result ? [tab.result] : []));
  return entries.sort((a, b) => a.from - b.from);
}
