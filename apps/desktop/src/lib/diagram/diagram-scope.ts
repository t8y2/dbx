import { inject, provide, type InjectionKey } from "vue";
import { defineStore } from "pinia";
import { graphStoreSetup, useGraphStore } from "./graph-store";
import { layerStoreSetup, useLayerStore } from "./layer-store";
import { DEFAULT_DIAGRAM_SCOPE, diagramScopeStoreIds, disposeDiagramScope } from "./diagram-scope-dispose";

/**
 * Scopes the diagram stores per workspace: each dialog/tab instance gets its
 * own Pinia store ids (`diagram-graph:<scope>` / `diagram-layer:<scope>`), so
 * two simultaneously open diagrams never share nodes, edges, or layers.
 * The unscoped default ids keep the singleton call sites (and tests) working.
 *
 * Disposal lives in ./diagram-scope-dispose (zero store dependencies) so
 * queryStore can call it without importing the elkjs-backed graph store.
 */

export { DEFAULT_DIAGRAM_SCOPE, diagramScopeStoreIds, disposeDiagramScope };

const DIAGRAM_SCOPE: InjectionKey<string> = Symbol("diagram-scope");

/** Call once at the diagram root (dialog shell / tab panel) before children mount. */
export function provideDiagramScope(scopeId: string): void {
  provide(DIAGRAM_SCOPE, scopeId);
}

function currentScope(): string {
  return inject(DIAGRAM_SCOPE, DEFAULT_DIAGRAM_SCOPE);
}

type ScopedGraphStore = ReturnType<typeof useGraphStore>;
type ScopedLayerStore = ReturnType<typeof useLayerStore>;

/** defineStore is idempotent: the same id resolves to the same registered store. The double cast bridges the dynamic-id store to the default id's literal-typed store shape. */
function useScopedStore<TSetup extends () => unknown, TStore>(idPrefix: string, setup: TSetup): TStore {
  const id = `${idPrefix}:${currentScope()}`;
  return defineStore(id, setup)() as unknown as TStore;
}

/** Graph store (nodes/edges/history) for the current diagram scope. */
export function useScopedGraphStore(): ScopedGraphStore {
  return useScopedStore("diagram-graph", graphStoreSetup);
}

/** Layer store for the current diagram scope. */
export function useScopedLayerStore(): ScopedLayerStore {
  return useScopedStore("diagram-layer", layerStoreSetup);
}
