import { appendFlatTreeRenderKey, type FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode, TreeNodeType } from "@/types/database";

const simpleObjectParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema"]);
const tableSearchableChildTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "load-more"]);
// Grouped views and materialized views get the same in-group search box as
// tables (#12901): their index scope, local filter and remote search plumbing
// are already object-type generic.
const searchableObjectGroupTypes = new Set<TreeNodeType>(["group-tables", "group-views", "group-materialized-views"]);

export function sidebarSearchableObjectGroupTypes(): ReadonlySet<TreeNodeType> {
  return searchableObjectGroupTypes;
}

export function isSidebarTableSearchControlNode(node: TreeNode): boolean {
  return node.type === "table-search-control";
}

export function tableSearchControlId(parentId: string): string {
  return `${parentId}:__table_search`;
}

export const localTableSearchParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema", "group-tables", "group-views", "group-materialized-views"]);

export function parentHasSearchableTableList(node: TreeNode): boolean {
  // Routine-only schemas should not show a table-specific search box.
  return !!node.children?.some((child) => tableSearchableChildTypes.has(child.type));
}

export function findNodePathById(nodes: readonly TreeNode[], targetNodeId: string, ancestors: readonly TreeNode[] = []): readonly TreeNode[] | undefined {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.id === targetNodeId) return path;
    if (node.children) {
      const childPath = findNodePathById(node.children, targetNodeId, path);
      if (childPath) return childPath;
    }
  }
  return undefined;
}

export function resolveLocalTableSearchParent(nodes: readonly TreeNode[], activeNodeId: string | null | undefined, sidebarObjectDisplay: "simple" | "grouped" = "simple"): TreeNode | null {
  if (!activeNodeId) return null;
  const path = findNodePathById(nodes, activeNodeId);
  if (!path || path.length === 0) return null;

  if (sidebarObjectDisplay === "grouped") {
    for (let i = path.length - 1; i >= 0; i--) {
      if (searchableObjectGroupTypes.has(path[i]!.type)) {
        const group = path[i]!;
        if (group.children === undefined || parentHasSearchableTableList(group)) {
          return group;
        }
        return null;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const candidate = path[i]!;
      if (simpleObjectParentTypes.has(candidate.type)) {
        if (candidate.children !== undefined) {
          const tableGroup = candidate.children.find((child) => child.type === "group-tables");
          if (tableGroup && (tableGroup.children === undefined || parentHasSearchableTableList(tableGroup))) {
            return tableGroup;
          }
          return null;
        }
        return candidate;
      }
    }
    return null;
  }

  for (let i = path.length - 1; i >= 0; i--) {
    const candidate = path[i]!;
    if (simpleObjectParentTypes.has(candidate.type)) {
      if (candidate.children !== undefined) {
        if (parentHasSearchableTableList(candidate)) {
          return candidate;
        }
        continue;
      }
      return candidate;
    }
  }
  return null;
}

function shouldInsertTableSearchControl(item: FlatTreeNode, sidebarObjectDisplay: "simple" | "grouped", activeQueries: Readonly<Record<string, string | undefined>>): boolean {
  const node = item.node;
  if (!node.isExpanded) return false;
  if (sidebarObjectDisplay === "grouped") {
    return searchableObjectGroupTypes.has(node.type) && (parentHasSearchableTableList(node) || !!activeQueries[node.id]?.trim());
  }
  if (!simpleObjectParentTypes.has(node.type)) return false;
  return parentHasSearchableTableList(node) || !!activeQueries[node.id]?.trim();
}

const tableSearchControlLabels: Partial<Record<TreeNodeType, string>> = {
  "group-views": "sidebar.searchViewsInCurrentScope",
  "group-materialized-views": "sidebar.searchMaterializedViewsInCurrentScope",
};

function buildTableSearchControlNode(parent: TreeNode): TreeNode {
  return {
    id: tableSearchControlId(parent.id),
    label: tableSearchControlLabels[parent.type] ?? "sidebar.searchTablesInCurrentScope",
    type: "table-search-control",
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
    tableSearchParentId: parent.id,
  };
}

export function insertSidebarTableSearchControls(
  flatNodes: readonly FlatTreeNode[],
  options: {
    enabled: boolean;
    sidebarObjectDisplay: "simple" | "grouped";
    resolveDisplay?: (node: TreeNode) => "simple" | "grouped";
    activeQueries: Readonly<Record<string, string | undefined>>;
  },
): FlatTreeNode[] {
  if (!options.enabled) return [...flatNodes];

  const result: FlatTreeNode[] = [];
  for (const item of flatNodes) {
    result.push(item);
    if (!shouldInsertTableSearchControl(item, options.resolveDisplay?.(item.node) ?? options.sidebarObjectDisplay, options.activeQueries)) continue;

    const node = buildTableSearchControlNode(item.node);
    result.push({
      node,
      depth: item.depth + 1,
      id: node.id,
      renderKey: appendFlatTreeRenderKey(item.renderKey, node),
      type: node.type,
      poolType: `${node.type}:${node.id}`,
    });
  }
  return result;
}
