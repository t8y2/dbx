import type { TreeNodeType } from "@/types/database";

const treeGroupNodeTypes = new Set<TreeNodeType>([
  "group-columns",
  "group-indexes",
  "group-fkeys",
  "group-triggers",
  "group-constraints",
  "group-table-partitions",
  "group-table-subpartitions",
  "group-tables",
  "group-views",
  "group-materialized-views",
  "group-procedures",
  "group-functions",
  "group-sequences",
  "group-packages",
  "group-types",
  "group-partitions",
  "group-extensions",
]);

export function isTreeGroupNodeType(type: TreeNodeType): boolean {
  return treeGroupNodeTypes.has(type);
}
