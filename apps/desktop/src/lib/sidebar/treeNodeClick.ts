import type { ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";

export type TreeNodeRowAction = "open-data" | "open-source" | "open-extension-details" | "toggle" | "none";
export type TreeNodeRowDoubleClickAction = "open-data" | "activate-data" | "open-object-browser" | "open-object-browser-and-expand" | "open-source" | "open-extension-details" | "open-saved-sql" | "toggle" | "none";
export type SidebarSelectionCopyAction = "copy-name" | "none";
export type SidebarActivation = "single" | "double";

const dataNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);
const documentBrowserNodeTypes = new Set<TreeNodeType>(["mongo-collection", "mongo-bucket"]);
const toggleLeafNodeTypes = new Set<TreeNodeType>([
  "redis-db",
  "mq-tenant",
  "mqtt-topic",
  "etcd-root",
  "etcd-dashboard",
  "etcd-access-control",
  "zookeeper-root",
  "consul-root",
  "consul-overview",
  "mongo-gridfs",
  "mongo-collection",
  "mongo-bucket",
  "vector-collection",
  "elasticsearch-index",
  "user-admin",
]);
// These are application entry points rather than database objects. They should
// always navigate on a single click, even when the user prefers double-click
// activation for ordinary tree objects.
const directNavigationTreeNodeTypes = new Set<TreeNodeType>(["consul-root", "consul-overview"]);

export function isDirectNavigationTreeNode(type: TreeNodeType): boolean {
  return directNavigationTreeNodeTypes.has(type);
}

export function shouldActivateTreeNodeOnSingleClick(type: TreeNodeType, activation: SidebarActivation = "single"): boolean {
  return activation !== "double" || isDirectNavigationTreeNode(type);
}
const objectBrowserNodeTypes = new Set<TreeNodeType>(["database", "schema", "object-browser"]);
const sourceNodeTypes = new Set<TreeNodeType>(["materialized_view", "procedure", "function", "trigger", "sequence", "synonym", "package", "package-body", "type", "type-body"]);
const savedSqlNodeTypes = new Set<TreeNodeType>(["saved-sql-file"]);
const tableChildGroupNodeTypes = new Set<TreeNodeType>(["group-columns", "group-indexes", "group-fkeys", "group-triggers", "group-constraints", "group-partitions", "group-table-partitions", "group-table-subpartitions"]);
const databaseChildGroupNodeTypes = new Set<TreeNodeType>(["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-sequences", "group-synonyms", "group-packages", "group-types"]);

export function objectSourceKindForTreeNode(type: TreeNodeType): ObjectSourceKind | null {
  if (type === "view") return "VIEW";
  if (type === "materialized_view") return "MATERIALIZED_VIEW";
  if (type === "procedure") return "PROCEDURE";
  if (type === "function") return "FUNCTION";
  if (type === "trigger") return "TRIGGER";
  if (type === "sequence") return "SEQUENCE";
  if (type === "synonym") return "SYNONYM";
  if (type === "package") return "PACKAGE";
  if (type === "package-body") return "PACKAGE_BODY";
  if (type === "type") return "TYPE";
  if (type === "type-body") return "TYPE_BODY";
  return null;
}

export interface TreeNodeObjectSourceTarget {
  name: string;
  schema?: string;
  objectType: ObjectSourceKind;
  signature?: string;
}

export function objectSourceTargetForTreeNode(node: TreeNode): TreeNodeObjectSourceTarget | null {
  if ((node.type === "procedure" || node.type === "function") && node.parentType === "package" && node.parentName) {
    return {
      name: node.parentName,
      schema: node.parentSchema || node.schema,
      objectType: "PACKAGE",
      signature: node.signature,
    };
  }
  const objectType = objectSourceKindForTreeNode(node.type);
  if (!objectType) return null;
  return {
    name: node.objectName || node.label,
    schema: node.schema,
    objectType,
    signature: node.signature,
  };
}

export function isDocumentBrowserTreeNode(type: TreeNodeType): boolean {
  return documentBrowserNodeTypes.has(type);
}

export function treeNodeRowAction(type: TreeNodeType, canExpand: boolean, activation: SidebarActivation = "single"): TreeNodeRowAction {
  if (!shouldActivateTreeNodeOnSingleClick(type, activation)) return "none";
  if (type === "extension") return "open-extension-details";
  if (dataNodeTypes.has(type)) return "open-data";
  if ((type === "package" || type === "type") && canExpand) return "toggle";
  if (sourceNodeTypes.has(type)) return "open-source";
  if (toggleLeafNodeTypes.has(type)) return "toggle";
  if (canExpand) return "toggle";
  return "none";
}

export function shouldRunTreeNodeRowAction(action: TreeNodeRowAction, clickDetail: number, allowRepeatedToggle = false): boolean {
  if (action === "toggle" && allowRepeatedToggle) return true;
  // Double-clicks emit a second click before dblclick; leave that event to the
  // double-click handler so expandable database rows do not toggle first.
  return action !== "none" && clickDetail <= 1;
}

export function treeNodeRowDoubleClickAction(type: TreeNodeType, canOpenObjectBrowser: boolean, activation: SidebarActivation = "single", canExpand = false): TreeNodeRowDoubleClickAction {
  // Single-click activation already handles the first click in a dblclick
  // sequence. Only double-click activation needs a second-stage table action.
  if (type === "table") return activation === "double" ? "activate-data" : "none";
  if (activation === "double") {
    if (type === "extension") return "open-extension-details";
    if (dataNodeTypes.has(type)) return "open-data";
    if (sourceNodeTypes.has(type)) return "open-source";
    if (savedSqlNodeTypes.has(type)) return "open-saved-sql";
    if (toggleLeafNodeTypes.has(type)) return "toggle";
    if (canOpenObjectBrowser && objectBrowserNodeTypes.has(type) && canExpand) return "open-object-browser-and-expand";
    if (canOpenObjectBrowser && objectBrowserNodeTypes.has(type)) return "open-object-browser";
    if (canExpand) return "toggle";
  }
  if (canOpenObjectBrowser && objectBrowserNodeTypes.has(type)) return "open-object-browser";
  return "none";
}

export function sidebarSelectionCopyAction(event: ShortcutLikeEvent, platform?: string): SidebarSelectionCopyAction {
  return matchesShortcut(event, "Mod+C", platform) ? "copy-name" : "none";
}

export function copyNameForTreeNode(node: TreeNode): string {
  if (tableChildGroupNodeTypes.has(node.type) && node.tableName) return node.tableName;
  if (databaseChildGroupNodeTypes.has(node.type)) return node.schema || node.database || node.label;
  if (node.type === "column") {
    if (node.meta && "name" in node.meta) return node.meta.name;
    return node.label.replace(/\s+\(.+\)$/, "");
  }
  return node.label;
}
