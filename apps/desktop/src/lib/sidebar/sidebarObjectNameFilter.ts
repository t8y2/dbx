import type { TreeNode, TreeNodeType } from "@/types/database";

const sidebarObjectNameFilterGroupTypes: ReadonlySet<TreeNodeType> = new Set(["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions"]);

type SidebarObjectNameFilterTarget = {
  type: TreeNodeType;
  parentType?: TreeNode["parentType"];
};

export function supportsSidebarObjectNameFilter(node: SidebarObjectNameFilterTarget): boolean {
  return node.parentType !== "package" && sidebarObjectNameFilterGroupTypes.has(node.type);
}
