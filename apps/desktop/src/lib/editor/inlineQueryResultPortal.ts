import { shallowReactive } from "vue";
import type { QueryResult, QueryTab } from "@/types/database";
import type { InlineQueryResult } from "./inlineQueryResults";

export const INLINE_QUERY_RESULT_PORTAL = "dbx-inline-query-result-portal";
export function createInlineQueryResultPortal() {
  const targets = shallowReactive(new Map<string, Map<QueryResult, HTMLElement>>());
  const available = shallowReactive(new Map<string, QueryResult[]>());
  return {
    targets,
    available,
    anchors: new Map<string, InlineQueryResult[]>(),
    states: new WeakMap<QueryResult, Partial<QueryTab>>(),
    sync(tabId: string, results: QueryResult[]) {
      available.set(tabId, results);
    },
    mount(tabId: string, result: QueryResult, target: HTMLElement) {
      const next = new Map(targets.get(tabId));
      next.set(result, target);
      targets.set(tabId, next);
    },
    unmount(tabId: string, result: QueryResult, target: HTMLElement) {
      const current = targets.get(tabId);
      if (current?.get(result) !== target) return;
      const next = new Map(current);
      next.delete(result);
      if (next.size) targets.set(tabId, next);
      else targets.delete(tabId);
    },
  };
}
export type InlineQueryResultPortal = ReturnType<typeof createInlineQueryResultPortal>;
