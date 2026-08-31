import type { DatabaseType } from "@/types/database";
import type { ElasticsearchDeleteByQueryResult } from "@/lib/backend/tauri";

/**
 * `elasticsearch-index` tree nodes are also used for Meilisearch indexes, which
 * speak a different API. Only true Elasticsearch-protocol connections expose the
 * mapping/settings/stats and clear-index actions.
 */
export function isElasticsearchProtocolIndex(nodeType: string, dbType: DatabaseType | undefined): boolean {
  return nodeType === "elasticsearch-index" && (dbType === "elasticsearch" || dbType === "easysearch");
}

/**
 * With an `index_grouping` regex configured, a sidebar index node is a collapsed
 * pattern (`logs-2026.08.*`) rather than one index, and clearing it hits every
 * index the pattern matches. `*` and `?` are illegal in real Elasticsearch index
 * names, so their presence identifies a pattern node unambiguously — the clear
 * confirmation must spell that blast radius out instead of naming "an index".
 */
export function isElasticsearchIndexPattern(index: string): boolean {
  return index.includes("*") || index.includes("?");
}

/**
 * Whether a concrete index name falls under a grouped node's pattern, so
 * surfaces open on that index (e.g. document tabs) know a wildcard clear
 * touched their data too. `*` matches any run of characters and `?` exactly
 * one, mirroring the sidebar grouping semantics.
 */
export function matchesElasticsearchIndexPattern(pattern: string, index: string): boolean {
  const match = (patternOffset: number, indexOffset: number): boolean => {
    while (patternOffset < pattern.length) {
      const character = pattern[patternOffset]!;
      if (character === "*") {
        for (let next = indexOffset; next <= index.length; next++) {
          if (match(patternOffset + 1, next)) return true;
        }
        return false;
      }
      if (character !== "?" && character !== index[indexOffset]) return false;
      if (indexOffset >= index.length) return false;
      patternOffset++;
      indexOffset++;
    }
    return indexOffset === index.length;
  };
  return match(0, 0);
}

/**
 * Whether the operator has cleared the extra hurdle a wildcard node imposes.
 *
 * A concrete index name confirms with the button alone. A pattern node clears
 * every index it matches, so it additionally requires the pattern to be typed
 * back verbatim — the same stance Elasticsearch takes with its own
 * `action.destructive_requires_name` default. Surrounding whitespace is
 * forgiven because it is invisible in the input; nothing else is.
 */
export function isElasticsearchClearConfirmed(index: string, typedName: string): boolean {
  if (!isElasticsearchIndexPattern(index)) return true;
  return typedName.trim() === index;
}

/**
 * The request the clear action sends, shown verbatim in the confirmation dialog
 * so the reviewer can see it deletes documents rather than the index itself.
 */
export function elasticsearchClearIndexPreview(index: string): string {
  return `POST /${index}/_delete_by_query?conflicts=proceed&refresh=true\n{ "query": { "match_all": {} } }`;
}

export const ELASTICSEARCH_INDEX_CLEARED_EVENT = "dbx-elasticsearch-index-cleared";

export interface ElasticsearchIndexClearedDetail {
  connectionId: string;
  index: string;
}

/**
 * Tells an open document browser for this index that its rows are gone. Best
 * effort: the clear itself already succeeded by the time this runs, so a
 * missing DOM (non-browser host) must not turn into a reported failure.
 */
export function notifyElasticsearchIndexCleared(connectionId: string, index: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ElasticsearchIndexClearedDetail>(ELASTICSEARCH_INDEX_CLEARED_EVENT, { detail: { connectionId, index } }));
}

/** Returns an unsubscribe function, so callers cannot leak the listener by unregistering a different closure. */
export function subscribeElasticsearchIndexCleared(listener: (detail: ElasticsearchIndexClearedDetail) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleEvent = (event: Event) => listener((event as CustomEvent<ElasticsearchIndexClearedDetail>).detail);
  window.addEventListener(ELASTICSEARCH_INDEX_CLEARED_EVENT, handleEvent);
  return () => window.removeEventListener(ELASTICSEARCH_INDEX_CLEARED_EVENT, handleEvent);
}

/**
 * `_delete_by_query` returns HTTP 200 even when shards failed or documents were
 * skipped on a version conflict, so a plain "cleared" toast can be wrong. Report
 * a partial outcome whenever the run did not delete every matched document.
 */
export function isPartialElasticsearchClear(result: ElasticsearchDeleteByQueryResult): boolean {
  return result.timedOut || result.failures.length > 0 || result.versionConflicts > 0 || result.deleted < result.total;
}
