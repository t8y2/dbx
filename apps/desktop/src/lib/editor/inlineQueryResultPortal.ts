import { shallowReactive } from "vue";
import type { QueryResult, QueryTab } from "@/types/database";
import type { InlineQueryResult } from "./inlineQueryResults";

export const INLINE_QUERY_RESULT_PORTAL = "dbx-inline-query-result-portal";
export function createInlineQueryResultPortal() {
  const targets = shallowReactive(new Map<string, Map<QueryResult, HTMLElement>>());
  const available = shallowReactive(new Map<string, QueryResult[]>());
  // Weak ownership: closing one grid neither deletes a Run nor retains its
  // payload forever. A newly executed result has a new identity and reopens.
  const dismissed = shallowReactive(new WeakMap<QueryResult, Set<string>>());
  return {
    targets,
    available,
    anchors: new Map<string, InlineQueryResult[]>(),
    states: new WeakMap<QueryResult, Partial<QueryTab>>(),
    isDismissed(tabId: string, result: QueryResult) {
      return dismissed.get(result)?.has(tabId) ?? false;
    },
    dismiss(tabId: string, result: QueryResult) {
      dismissed.set(result, new Set([...(dismissed.get(result) ?? []), tabId]));
    },
    reopen(tabId: string, result: QueryResult) {
      const tabs = new Set(dismissed.get(result));
      tabs.delete(tabId);
      if (tabs.size) dismissed.set(result, tabs);
      else dismissed.delete(result);
    },
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
