import type { DatabaseType, ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import { customTypeCapabilities, supportsTypeObjectSource } from "@/lib/database/databaseObjectCapabilities";
import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";

export type TreeNodeRowAction = "open-data" | "open-source" | "open-extension-details" | "open-saved-sql" | "open-object-browser" | "open-object-browser-and-expand" | "toggle" | "none";
export type TreeNodeRowDoubleClickAction = "open-data" | "activate-data" | "open-database-browser" | "open-object-browser" | "open-object-browser-and-expand" | "open-source" | "open-extension-details" | "open-saved-sql" | "toggle" | "none";
export type SidebarSelectionCopyAction = "copy-name" | "none";
export type SidebarActivation = "single" | "double";

const dataNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);
const documentBrowserNodeTypes = new Set<TreeNodeType>(["mongo-collection", "mongo-bucket", "dynamodb-table"]);
const toggleLeafNodeTypes = new Set<TreeNodeType>([
  "redis-db",
  "mq-tenant",
  "mqtt-topic",
  "etcd-root",
  "etcd-dashboard",
  "etcd-access-control",
  "nacos-namespace",
  "nacos-access-control",
  "zookeeper-root",
  "consul-root",
  "consul-overview",
  "mongo-gridfs",
  "mongo-collection",
  "mongo-bucket",
  "dynamodb-table",
  "vector-collection",
  "elasticsearch-index",
  "meilisearch-system",
  "user-admin",
  "dameng-users",
  "dameng-roles",
]);
// These are application entry points rather than database objects. They should
// always navigate on a single click, even when the user prefers double-click
// activation for ordinary tree objects.
const directNavigationTreeNodeTypes = new Set<TreeNodeType>(["consul-root", "consul-overview", "nacos-namespace", "nacos-access-control", "meilisearch-system"]);
const repeatableNavigationTreeNodeTypes = new Set<TreeNodeType>(["nacos-namespace", "nacos-access-control"]);

export function isDirectNavigationTreeNode(type: TreeNodeType): boolean {
  return directNavigationTreeNodeTypes.has(type);
}

export function isRepeatableNavigationTreeNode(type: TreeNodeType): boolean {
  return repeatableNavigationTreeNodeTypes.has(type);
}

export function shouldActivateTreeNodeOnSingleClick(type: TreeNodeType, activation: SidebarActivation = "single"): boolean {
  return activation !== "double" || isDirectNavigationTreeNode(type);
}
const objectBrowserNodeTypes = new Set<TreeNodeType>(["database", "schema", "object-browser", "mongo-db"]);

/** 开关“单击数据库同时打开数据库项目”命中时，单击数据库类节点直接打开对象浏览器标签页。 */
export function shouldOpenObjectBrowserOnSingleClick(type: TreeNodeType, enabled: boolean): boolean {
  return enabled && objectBrowserNodeTypes.has(type);
}
const sourceNodeTypes = new Set<TreeNodeType>(["materialized_view", "procedure", "function", "trigger", "event", "sequence", "synonym", "package", "package-body", "type", "type-body"]);
const savedSqlNodeTypes = new Set<TreeNodeType>(["saved-sql-file"]);
const tableChildGroupNodeTypes = new Set<TreeNodeType>(["group-columns", "group-indexes", "group-fkeys", "group-triggers", "group-constraints", "group-partitions", "group-table-partitions", "group-table-subpartitions"]);
const databaseChildGroupNodeTypes = new Set<TreeNodeType>(["group-tables", "group-dolt-system-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-events", "group-sequences", "group-synonyms", "group-packages", "group-types"]);
const displayPathObjectNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "procedure", "function", "trigger", "event"]);

export function objectSourceKindForTreeNode(type: TreeNodeType): ObjectSourceKind | null {
  if (type === "view") return "VIEW";
  if (type === "materialized_view") return "MATERIALIZED_VIEW";
  if (type === "procedure") return "PROCEDURE";
  if (type === "function") return "FUNCTION";
  if (type === "trigger") return "TRIGGER";
  if (type === "event") return "EVENT";
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

/**
 * Whether a tree node type may open an object source dialog for the given
 * connection type. TYPE/TYPE_BODY only have a real source implementation on
 * Xugu; other databases list types without a DDL getter this cycle.
 */
function canOpenTreeNodeSource(type: TreeNodeType, dbType?: DatabaseType): boolean {
  if (type === "type" || type === "type-body") return supportsTypeObjectSource(dbType);
  return true;
}

export function treeNodeRowAction(type: TreeNodeType, canExpand: boolean, activation: SidebarActivation = "single", dbType?: DatabaseType, openDatabaseOnSingleClick = false, canOpenObjectBrowser = false): TreeNodeRowAction {
  // “单击数据库同时打开数据库项目”开关优先于激活方式：单击即等效双击的打开行为。
  if (openDatabaseOnSingleClick && canOpenObjectBrowser && shouldOpenObjectBrowserOnSingleClick(type, true)) {
    return canExpand ? "open-object-browser-and-expand" : "open-object-browser";
  }
  if (!shouldActivateTreeNodeOnSingleClick(type, activation)) return "none";
  if (type === "extension") return "open-extension-details";
  if (savedSqlNodeTypes.has(type)) return "open-saved-sql";
  if (dataNodeTypes.has(type)) return "open-data";
  // PostgreSQL-family custom types: open read-only details (toggle when expandable).
  if (type === "type" && customTypeCapabilities(dbType).details) return canExpand ? "toggle" : "none";
  // Xugu and other databases: expandable package/type nodes toggle their members.
  if ((type === "package" || type === "type") && canExpand) return "toggle";
  if (sourceNodeTypes.has(type) && canOpenTreeNodeSource(type, dbType)) return "open-source";
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

export function treeNodeRowDoubleClickAction(type: TreeNodeType, canOpenObjectBrowser: boolean, activation: SidebarActivation = "single", canExpand = false, dbType?: DatabaseType, canOpenDatabaseBrowser = false, openDatabaseOnSingleClick = false): TreeNodeRowDoubleClickAction {
  // Single-click activation already handles the first click in a dblclick
  // sequence. Only double-click activation needs a second-stage table action.
  if (type === "table") return activation === "double" ? "activate-data" : "none";
  if (openDatabaseOnSingleClick && canOpenObjectBrowser && shouldOpenObjectBrowserOnSingleClick(type, true)) return "none";
  // 双击激活模式下，双击连接节点应当展开树（与单击模式下单击展开一致），
  // “打开数据库浏览”只保留给单击激活模式下的双击手势。
  if (type === "connection" && canOpenDatabaseBrowser && activation !== "double") return "open-database-browser";
  if (activation === "double") {
    if (type === "extension") return "open-extension-details";
    if (dataNodeTypes.has(type)) return "open-data";
    if (type === "type" && customTypeCapabilities(dbType).details) return canExpand ? "toggle" : "none";
    if (sourceNodeTypes.has(type) && canOpenTreeNodeSource(type, dbType)) return "open-source";
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

export function copyDisplayPathForTreeNode(node: TreeNode, connectionName: string): string | null {
  const connection = connectionName.trim();
  const database = node.database?.trim();
  if (!connection || !database) return null;
  if (node.type === "database") return `${connection}.${database}`;
  if (!displayPathObjectNodeTypes.has(node.type)) return null;
  const objectName = (node.objectName || (node.type === "table" ? node.tableName : undefined) || node.label).trim();
  return objectName ? `${connection}.${database}.${objectName}` : null;
}
