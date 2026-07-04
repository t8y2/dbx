import type { FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode, TreeNodeType } from "@/types/database";

const simpleObjectParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema"]);
const simpleObjectChildTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "procedure", "function", "sequence", "package", "package-body", "load-more"]);

export function isSidebarTableSearchControlNode(node: TreeNode): boolean {
  return node.type === "table-search-control";
}

function tableSearchControlId(parentId: string): string {
  return `${parentId}:__table_search`;
}

function parentHasDirectTableList(node: TreeNode): boolean {
  return !!node.children?.some((child) => simpleObjectChildTypes.has(child.type));
}

function shouldInsertTableSearchControl(item: FlatTreeNode, sidebarObjectDisplay: "simple" | "grouped", activeQueries: Readonly<Record<string, string | undefined>>): boolean {
  const node = item.node;
  if (!node.isExpanded) return false;
  if (sidebarObjectDisplay === "grouped") {
    return node.type === "group-tables";
  }
  if (!simpleObjectParentTypes.has(node.type)) return false;
  return parentHasDirectTableList(node) || !!activeQueries[node.id]?.trim();
}

function buildTableSearchControlNode(parent: TreeNode): TreeNode {
  return {
    id: tableSearchControlId(parent.id),
    label: "sidebar.searchTablesInCurrentScope",
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
    activeQueries: Readonly<Record<string, string | undefined>>;
  },
): FlatTreeNode[] {
  if (!options.enabled) return [...flatNodes];

  const result: FlatTreeNode[] = [];
  for (const item of flatNodes) {
    result.push(item);
    if (!shouldInsertTableSearchControl(item, options.sidebarObjectDisplay, options.activeQueries)) continue;

    const node = buildTableSearchControlNode(item.node);
    result.push({
      node,
      depth: item.depth + 1,
      id: node.id,
      type: node.type,
      poolType: `${node.type}:${node.id}`,
    });
  }
  return result;
}
