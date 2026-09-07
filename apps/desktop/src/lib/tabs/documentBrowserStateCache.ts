import type { DocumentFilterRule } from "@/lib/app/documentStoreProvider";

export interface DocumentBrowserStateSnapshot {
  /** Manual JSON filter text from the collection filter input. */
  filterInput: string;
  /** Manual JSON sort text from the collection sort input. */
  sortInput: string;
  /** Structured-filter contribution applied on top of the manual filter. */
  appliedDocumentFilter: Record<string, unknown> | null;
  /** Rules backing the structured filter builder. */
  documentFilterRules: DocumentFilterRule[];
  /** Zero-based page position; only meaningful for skip-based stores. */
  page: number;
}

// ContentArea renders only the active tab, so DocumentBrowser is unmounted on
// every tab switch and remounted when the user comes back. Query conditions
// survive that round trip through this session-scoped cache keyed by tab id —
// the same role tab.whereInput/tab.orderByInput play for SQL data tabs. The
// bound keeps state for long tab sessions from accumulating forever.
const MAX_ENTRIES = 32;
const cache = new Map<string, DocumentBrowserStateSnapshot>();

export function restoreDocumentBrowserState(stateKey: string): DocumentBrowserStateSnapshot | undefined {
  const snapshot = cache.get(stateKey);
  if (!snapshot) return undefined;
  // Refresh LRU recency.
  cache.delete(stateKey);
  cache.set(stateKey, snapshot);
  return snapshot;
}

export function saveDocumentBrowserState(stateKey: string, snapshot: DocumentBrowserStateSnapshot): void {
  cache.delete(stateKey);
  cache.set(stateKey, snapshot);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearDocumentBrowserState(stateKey: string): void {
  cache.delete(stateKey);
}
