import { ref } from "vue";

/**
 * Quick-open connection scope: the set of connection ids included in a search.
 * An empty set means "search every connection", which is the default.
 *
 * Deliberately in-memory only: the choice survives closing and reopening the search dialog,
 * but a fresh app launch starts from "all connections" again.
 */
export const quickOpenScopeIds = ref<string[]>([]);

/** True when the user narrowed the search to specific connections. */
export function isQuickOpenScopeActive(ids: readonly string[] = quickOpenScopeIds.value): boolean {
  return ids.length > 0;
}

/** Whether `connectionId` passes the active scope (everything passes when no scope is set). */
export function quickOpenScopeIncludes(connectionId: string, ids: readonly string[] = quickOpenScopeIds.value): boolean {
  return ids.length === 0 || ids.includes(connectionId);
}

export function setQuickOpenScopeIds(ids: string[]): void {
  quickOpenScopeIds.value = [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
}

/** Drop stored ids whose connection no longer exists, so a stale scope cannot hide everything. */
export function pruneQuickOpenScope(knownConnectionIds: readonly string[]): void {
  if (!isQuickOpenScopeActive()) return;
  const known = new Set(knownConnectionIds);
  const next = quickOpenScopeIds.value.filter((id) => known.has(id));
  if (next.length !== quickOpenScopeIds.value.length) setQuickOpenScopeIds(next);
}
