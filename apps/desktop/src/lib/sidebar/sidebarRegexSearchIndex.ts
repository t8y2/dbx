import type { TableInfo, TreeNode, TreeNodeType } from "@/types/database";
import type { SidebarRegexIndexScope, SidebarRegexScopeIdentity } from "@/lib/sidebar/sidebarSearchTree";

export const regexLocalTableParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema", "group-tables"]);

export function regexTableSearchParents(nodes: readonly TreeNode[], result: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    if (regexLocalTableParentTypes.has(node.type)) result.push(node);
    if (node.children) regexTableSearchParents(node.children, result);
  }
  return result;
}

/** Scope metadata plus its complete index entries. */
export interface SidebarRegexIndexScopeResult {
  scope: Omit<SidebarRegexIndexScope, "entries">;
  entries: TableInfo[];
}

/**
 * Read-only local index access used by the regex search dispatch.
 *
 * The parent is addressed by its composite identity, never by the bare id:
 * TreeNode ids are not unique across the whole tree, and the store must find
 * the right cache key even when a same-id node exists in another branch.
 */
export interface SidebarRegexIndexReader {
  loadSidebarTableSearchIndexScopes(): Promise<SidebarRegexIndexScopeResult[]>;
  loadSidebarTableSearchIndex(parent: SidebarRegexScopeIdentity & { parentNodeId: string }): Promise<TableInfo[] | null>;
}

function sidebarRegexIndexScopeKey(scope: SidebarRegexScopeIdentity & { parentNodeId: string }): string {
  return JSON.stringify([scope.parentNodeId, scope.connectionId, scope.database, scope.schema ?? null, scope.catalog ?? null, scope.nodeType]);
}

/**
 * The search state exposed to remote tree loading while regex mode is active.
 *
 * The regex source is a client-side projection and must never leak into the
 * store's remote-search query or a remote searchFilter; explicit user
 * expansion may still connect and load, but only without the regex filter.
 */
export function resolveSidebarRemoteSearchQuery(regexMode: boolean, query: string): string {
  return regexMode ? "" : query;
}

/**
 * Assemble the complete local table indexes a regex search can consult.
 *
 * Only the two read methods above are ever invoked: this path cannot connect
 * data sources or refresh remote metadata. Manifest scopes keep their recorded
 * ancestor path; indexes that predate the manifest are discovered through the
 * live tree and returned without a path so the merge layer anchors them to the
 * live parent node. Reads are sequential so a large workspace never fans out
 * one storage request per database for every keypress.
 */
export async function collectSidebarRegexIndexScopes(reader: SidebarRegexIndexReader, liveNodes: readonly TreeNode[], shouldCancel: () => boolean): Promise<SidebarRegexIndexScope[]> {
  const loadedScopeKeys = new Set<string>();
  const manifestScopes = await reader.loadSidebarTableSearchIndexScopes();
  const loadedScopes: SidebarRegexIndexScope[] = [];
  for (const { scope, entries } of manifestScopes) {
    if (shouldCancel()) return loadedScopes;
    loadedScopeKeys.add(sidebarRegexIndexScopeKey(scope));
    loadedScopes.push({ ...scope, entries });
  }
  for (const parent of regexTableSearchParents(liveNodes)) {
    if (shouldCancel()) return loadedScopes;
    const parentScope = {
      parentNodeId: parent.id,
      connectionId: parent.connectionId || "",
      database: parent.database || "",
      schema: parent.schema,
      catalog: parent.catalog,
      nodeType: parent.type,
    };
    const scopeKey = sidebarRegexIndexScopeKey(parentScope);
    if (loadedScopeKeys.has(scopeKey)) continue;
    const entries = await reader.loadSidebarTableSearchIndex(parentScope);
    loadedScopeKeys.add(scopeKey);
    if (entries) {
      loadedScopes.push({ ...parentScope, path: undefined, entries });
    }
  }
  return loadedScopes;
}

export type SidebarSearchDispatchMode = "regex" | "none" | "ordinary";

export interface SidebarSearchTransition {
  query: string;
  regexMode: boolean;
  wasRegexMode: boolean;
}

/**
 * Pick the sidebar global-search dispatch branch for a query/mode transition.
 *
 * Regex mode always short-circuits to the local index projection regardless of
 * the local-search setting. Ordinary remote refresh runs whenever regex is off,
 * a non-empty query remains, and local search is disabled, including an
 * explicit transition out of regex mode.
 */
export function resolveSidebarSearchDispatchMode(transition: SidebarSearchTransition, options: { localSearchEnabled: boolean }): SidebarSearchDispatchMode {
  if (transition.regexMode) return "regex";
  if (options.localSearchEnabled) return "none";
  if (transition.wasRegexMode && !transition.query) return "none";
  return "ordinary";
}
