import type { TreeNodeType } from "@/types/database";

export type TreeNodeRowAction = "open-data" | "toggle" | "none";
export type TreeNodeRowDoubleClickAction = "open-object-browser" | "none";

const dataNodeTypes = new Set<TreeNodeType>(["table", "view"]);
const toggleLeafNodeTypes = new Set<TreeNodeType>(["redis-db", "mongo-collection"]);
const objectBrowserNodeTypes = new Set<TreeNodeType>(["database", "schema", "object-browser"]);

export function treeNodeRowAction(type: TreeNodeType, canExpand: boolean): TreeNodeRowAction {
  if (dataNodeTypes.has(type)) return "open-data";
  if (toggleLeafNodeTypes.has(type)) return "toggle";
  if (canExpand) return "toggle";
  return "none";
}

export function treeNodeRowDoubleClickAction(
  type: TreeNodeType,
  canOpenObjectBrowser: boolean,
): TreeNodeRowDoubleClickAction {
  if (canOpenObjectBrowser && objectBrowserNodeTypes.has(type)) return "open-object-browser";
  return "none";
}
