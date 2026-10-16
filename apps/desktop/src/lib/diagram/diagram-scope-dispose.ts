import type { Pinia } from "pinia";

/**
 * Scope id arithmetic + disposal, isolated from the store factories so that
 * non-diagram modules (queryStore.closeTab) can dispose a scope without
 * dragging the graph-store -> elkjs worker chain into their import graph.
 */

export const DEFAULT_DIAGRAM_SCOPE = "default";

/** Store ids owned by a scope (used for disposal). */
export function diagramScopeStoreIds(scopeId: string): [string, string] {
  return [`diagram-graph:${scopeId}`, `diagram-layer:${scopeId}`];
}

/**
 * Releases a scope's store instances. Pinia keeps dynamically-id'd stores
 * alive until deleted, and `pinia.state.value[id]` hydrates a recreated store
 * with the old state — both must go, or a closed tab's diagram state leaks
 * (and survives a remount of the same scope id).
 */
export function disposeDiagramScope(scopeId: string, pinia: Pinia): void {
  if (scopeId === DEFAULT_DIAGRAM_SCOPE) return;
  const internals = pinia as unknown as { _s: Map<string, unknown>; state: { value: Record<string, unknown> } };
  for (const id of diagramScopeStoreIds(scopeId)) {
    internals._s.delete(id);
    delete internals.state.value[id];
  }
}
