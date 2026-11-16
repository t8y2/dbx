import type { TreeNode, TreeNodeType } from "@/types/database";
import { objectTypesForGroupNode } from "@/lib/table/tableTree";
import { sidebarIndexedObjectGroupTypes } from "@/lib/sidebar/sidebarGlobalSearchIndex";
import { isSidebarSearchPrunedDatabaseNode } from "@/lib/sidebar/sidebarSearchDatabaseScope";
import { nodeMatchesRegexScopeIdentity, type SidebarRegexScopeIdentity } from "@/lib/sidebar/sidebarSearchTree";
import { exactOracleTriggerNodeMetadata } from "@/lib/database/oracleTriggerIdentity";

export interface SidebarRemoteSearchResult extends SidebarRegexScopeIdentity {
  parentNodeId: string;
  children: TreeNode[];
}

const containerTypes = new Set<TreeNodeType>(["connection-group", "connection", "database", "schema", "doris-catalog", "linked-server-root", "linked-server", "linked-server-catalog", "linked-server-schema"]);

export async function collectSidebarRemoteSearchResults(options: {
  root: TreeNode;
  connectionId: string;
  databaseScope: ReadonlySet<string> | null;
  signal: AbortSignal;
  isSimpleParent: (node: TreeNode) => boolean;
  discover: (node: TreeNode) => Promise<readonly TreeNode[]>;
  search: (node: TreeNode, onProgress: (children: TreeNode[]) => void) => Promise<TreeNode[]>;
  onProgress?: (results: SidebarRemoteSearchResult[]) => void;
  onError: (error: unknown) => void;
}): Promise<SidebarRemoteSearchResult[]> {
  const results: SidebarRemoteSearchResult[] = [];
  const resultFor = (node: TreeNode, children: TreeNode[]): SidebarRemoteSearchResult => ({ parentNodeId: node.id, nodeType: node.type, connectionId: options.connectionId, database: node.database ?? "", schema: node.schema, catalog: node.catalog, children });
  const publish = (result: SidebarRemoteSearchResult) => {
    const index = results.findIndex(
      (candidate) => candidate.parentNodeId === result.parentNodeId && candidate.nodeType === result.nodeType && candidate.connectionId === result.connectionId && candidate.database === result.database && candidate.schema === result.schema && candidate.catalog === result.catalog,
    );
    if (index >= 0) results[index] = result;
    else results.push(result);
    options.onProgress?.([...results]);
  };
  const visit = async (node: TreeNode): Promise<void> => {
    if (options.signal.aborted || isSidebarSearchPrunedDatabaseNode(node, options.databaseScope)) return;
    if (node.connectionId && node.connectionId !== options.connectionId) return;
    if (sidebarIndexedObjectGroupTypes.has(node.type)) return;
    try {
      if (options.isSimpleParent(node) || (!node.tableName && objectTypesForGroupNode(node.type))) {
        let published = false;
        const children = await options.search(node, (partial) => {
          if (!options.signal.aborted) {
            published = true;
            publish(resultFor(node, partial));
          }
        });
        if (!options.signal.aborted && !published) publish(resultFor(node, children));
        return;
      }
      if (!containerTypes.has(node.type)) return;
      const children = await options.discover(node);
      for (const child of children) await visit(child);
    } catch (error) {
      if (!options.signal.aborted) options.onError(error);
    }
  };
  await visit(options.root);
  return results;
}

export function mergeSidebarRemoteSearchResults(nodes: TreeNode[], results: readonly SidebarRemoteSearchResult[]): TreeNode[] {
  if (!results.length) return nodes;
  return nodes.map((node) => {
    const children = node.children ? mergeSidebarRemoteSearchResults(node.children, results) : undefined;
    const result = results.find((candidate) => nodeMatchesRegexScopeIdentity(node, candidate.parentNodeId, candidate));
    if (!result) return children === node.children ? node : { ...node, children };
    const merged = [...(children ?? [])];
    const identities = new Set(merged.map((child) => child.id));
    for (const child of result.children) {
      if (!identities.has(child.id)) {
        merged.push(child);
        identities.add(child.id);
      }
    }
    return { ...node, children: merged };
  });
}

export function removeVerifiedSidebarTriggerSearchResult(results: readonly SidebarRemoteSearchResult[], node: TreeNode): SidebarRemoteSearchResult[] {
  const expected = exactOracleTriggerNodeMetadata(node);
  if (!expected?.objectId) return [...results];
  return results.map((result) => ({
    ...result,
    children: result.children.filter((child) => {
      const actual = exactOracleTriggerNodeMetadata(child);
      return child.connectionId !== node.connectionId || child.database !== node.database || child.catalog !== node.catalog || actual?.owner !== expected.owner || actual?.name !== expected.name || actual?.objectId !== expected.objectId;
    }),
  }));
}
