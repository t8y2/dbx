import type { TreeNodeType } from "@/types/database";

export type TreeNodeRowAction = "open-data" | "toggle" | "none";

const dataNodeTypes = new Set<TreeNodeType>(["table", "view"]);
const toggleLeafNodeTypes = new Set<TreeNodeType>(["redis-db", "mongo-collection"]);

export function treeNodeRowAction(type: TreeNodeType, canExpand: boolean): TreeNodeRowAction {
  if (dataNodeTypes.has(type)) return "open-data";
  if (toggleLeafNodeTypes.has(type)) return "toggle";
  if (canExpand) return "toggle";
  return "none";
}
