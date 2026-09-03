import type { TreeNodeType } from "@/types/database";

const treeGroupNodeTypes = new Set<TreeNodeType>([
  "group-columns",
  "group-indexes",
  "group-fkeys",
  "group-triggers",
  "group-events",
  "group-constraints",
  "group-table-partitions",
  "group-table-subpartitions",
  "group-tables",
  "group-dolt-system-tables",
  "group-views",
  "group-materialized-views",
  "group-procedures",
  "group-functions",
  "group-sequences",
  "group-synonyms",
  "group-jobs",
  "group-packages",
  "group-types",
  "group-partitions",
  "group-extensions",
  "group-tablespaces",
  "group-datafiles",
  "type-attributes",
  "type-methods",
]);

export function isTreeGroupNodeType(type: TreeNodeType): boolean {
  return treeGroupNodeTypes.has(type);
}
