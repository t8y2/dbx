import type { TableInfo, TreeNode } from "@/types/database";

export function buildTableTreeNodes({
  nodeId,
  connectionId,
  database,
  schema,
  tables,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  tables: TableInfo[];
}): TreeNode[] {
  return tables.map((table) => ({
    id: `${nodeId}:${table.name}`,
    label: table.name,
    type: table.table_type === "VIEW" ? "view" : "table",
    connectionId,
    database,
    schema,
    isExpanded: false,
    children: [],
  }));
}

export function expandCachedObjectBrowserNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "object-browser") return node.hiddenChildren ?? [];

    if (!node.children) return [node];

    return [
      {
        ...node,
        children: expandCachedObjectBrowserNodes(node.children),
      },
    ];
  });
}
