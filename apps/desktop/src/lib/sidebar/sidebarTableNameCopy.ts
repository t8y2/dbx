import type { ColumnInfo, DatabaseType, TreeNode } from "@/types/database";
import { COLUMN_NAME_COPY_SEPARATOR_VALUES, type ColumnNameCopySeparator, isColumnNameCopySeparator } from "@/lib/dataGrid/dataGridColumnNameCopy";
import { copyNameForTreeNode } from "@/lib/sidebar/treeNodeClick";
import { qualifiedTableName, quoteTableIdentifier, quoteTableIdentifierIfNeeded } from "@/lib/table/tableSelectSql";
import { qualifiedRoutineName } from "@/lib/table/routineExecutionSql";

export type SidebarTableCopyTarget = TreeNode & { connectionId: string; database: string };

const TABLE_COPY_NODE_TYPES = new Set<TreeNode["type"]>(["table", "view", "materialized_view"]);

function isTableCopyTarget(node: TreeNode): node is SidebarTableCopyTarget {
  return TABLE_COPY_NODE_TYPES.has(node.type) && !!node.connectionId && !!node.database;
}

export function columnNameForSidebarDrag(node: TreeNode): string {
  if (node.type !== "column") return copyNameForTreeNode(node);
  const column = node.meta as Partial<ColumnInfo> | undefined;
  if (typeof column?.name === "string" && column.name) return column.name;
  return node.label.replace(/\s+\([^()]*\)$/, "");
}

function sameColumnTableContext(first: TreeNode, node: TreeNode): boolean {
  return node.type === "column" && !!node.connectionId && node.database != null && node.connectionId === first.connectionId && node.database === first.database && (node.schema ?? "") === (first.schema ?? "") && !!node.tableName && node.tableName === first.tableName;
}

export function resolveSidebarTableCopyTargets(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): SidebarTableCopyTarget[] {
  if (!isTableCopyTarget(activeNode)) return [];
  if (selectedNodes.length <= 1 || !selectedNodes.some((node) => node.id === activeNode.id)) return [activeNode];
  const targets = selectedNodes.filter(isTableCopyTarget);
  if (targets.length <= 1) return [activeNode];
  const first = targets[0]!;
  if (!targets.every((node) => node.connectionId === first.connectionId && node.database === first.database && (node.catalog ?? "") === (first.catalog ?? ""))) {
    return [activeNode];
  }
  return targets;
}

export function resolveSidebarColumnDragTargets(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  if (activeNode.type !== "column" || !activeNode.tableName) return [activeNode];
  if (selectedNodes.length <= 1 || !selectedNodes.some((node) => node.id === activeNode.id)) return [activeNode];
  const targets = selectedNodes.filter((node) => node.type === "column" && sameColumnTableContext(activeNode, node));
  return targets.length > 1 ? targets : [activeNode];
}

export function resolveSidebarColumnDragNames(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): string[] {
  return resolveSidebarColumnDragTargets(activeNode, selectedNodes)
    .map(columnNameForSidebarDrag)
    .filter((name) => name.length > 0);
}

export interface FormatSidebarTableNamesOptions {
  separator: ColumnNameCopySeparator;
  includeSchema: boolean;
  databaseType?: DatabaseType;
  driverProfile?: string;
  identifierQuote?: string;
}

export function formatSidebarTableNamesForCopy(targets: readonly SidebarTableCopyTarget[], options: FormatSidebarTableNamesOptions): string {
  const separator = COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator] ?? ",";
  const parts = targets.map((target) => {
    if (!options.includeSchema) return copyNameForTreeNode(target);
    return qualifiedTableName({
      databaseType: options.databaseType,
      driverProfile: options.driverProfile,
      identifierQuote: options.identifierQuote,
      schema: target.schema,
      tableName: target.label,
      database: target.database,
      catalog: target.catalog,
    });
  });
  return parts.join(separator);
}

export function normalizeSidebarCopyTableNameSeparator(value: unknown): ColumnNameCopySeparator {
  return isColumnNameCopySeparator(value) ? value : "comma";
}

export function sidebarTableCopyNodes(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  return selectedNodes.length > 1 && selectedNodes.some((node) => node.id === activeNode.id) ? [...selectedNodes] : [activeNode];
}

export function formatSidebarTableCopyText(activeNode: TreeNode, selectedNodes: readonly TreeNode[], options: FormatSidebarTableNamesOptions): string {
  const tableTargets = resolveSidebarTableCopyTargets(activeNode, selectedNodes);
  const separator = COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator] ?? ",";
  if (tableTargets.length > 0 && (tableTargets.length > 1 || options.includeSchema)) {
    return formatSidebarTableNamesForCopy(tableTargets, options);
  }
  return sidebarTableCopyNodes(activeNode, selectedNodes).map(copyNameForTreeNode).join(separator);
}

const QUALIFIED_NODE_TYPES = new Set<TreeNode["type"]>(["table", "view", "materialized_view", "column", "procedure", "function", "trigger", "event", "sequence", "synonym", "package", "package-body", "type", "type-body", "type-member", "type-attribute", "type-method", "index"]);

/** Resolve SQL identity from node metadata; never use the rendered tree path. */
export function qualifiedNameForSidebarNode(node: TreeNode, options: Omit<FormatSidebarTableNamesOptions, "separator" | "includeSchema">): string | null {
  if (!QUALIFIED_NODE_TYPES.has(node.type) || !node.database || !node.connectionId || !options.databaseType) return null;
  const dbType = options.databaseType;
  const schema = node.parentSchema || node.schema;
  if (!schema && !["mysql", "clickhouse", "doris", "starrocks", "goldendb"].includes(dbType)) return null;
  const quote = (part: string) => (dbType === "jdbc" ? quoteTableIdentifierIfNeeded(dbType, part, options.identifierQuote) : quoteTableIdentifier(dbType, part));
  if (node.type === "table" || node.type === "view" || node.type === "materialized_view") {
    return qualifiedTableName({ ...options, schema: node.schema, tableName: node.objectName || node.tableName || node.label, database: node.database, catalog: node.catalog, includeDatabaseName: true });
  }
  if (node.type === "column") {
    const column = node.meta as Partial<ColumnInfo> | undefined;
    const parent = node.tableName;
    const name = column?.name;
    if (!parent || !name) return null;
    const qualifiedParent = qualifiedTableName({ ...options, schema, tableName: parent, database: node.database, catalog: node.catalog, includeDatabaseName: true });
    return `${qualifiedParent}.${quote(name)}`;
  }
  if (node.type === "procedure" || node.type === "function") {
    const name = node.objectName;
    if (!name) return null;
    const qualifiedRoutine = (routineName: string) => {
      if (dbType === "mysql") return qualifiedTableName({ ...options, schema, tableName: routineName, database: node.database, includeDatabaseName: true });
      if (dbType === "jdbc") {
        const parts = [schema, routineName].filter((part): part is string => !!part);
        return parts.map((part) => quoteTableIdentifierIfNeeded(dbType, part, options.identifierQuote)).join(".");
      }
      return qualifiedRoutineName({ databaseType: dbType, schema, routineName });
    };
    const routine = qualifiedRoutine(name);
    if (node.parentName && node.parentType === "package") {
      const qualifiedPackage = qualifiedRoutine(node.parentName);
      return `${qualifiedPackage}.${quote(name)}`;
    }
    return routine;
  }
  if (node.type === "trigger") {
    if (!["sqlserver", "oracle", "oceanbase-oracle"].includes(dbType)) return null;
    const trigger = node.meta as { name?: string } | undefined;
    const name = node.objectName || trigger?.name;
    if (!name || !schema) return null;
    return qualifiedRoutineName({ databaseType: dbType, schema, routineName: name });
  }
  if (node.type === "event") {
    if (!["mysql", "mariadb"].includes(dbType)) return null;
    const event = node.meta as { name?: string } | undefined;
    const name = node.objectName || event?.name;
    return name ? qualifiedTableName({ ...options, schema, tableName: name, database: node.database, catalog: node.catalog, includeDatabaseName: true }) : null;
  }
  if (node.type === "package-body" || node.type === "type-body") {
    if (!node.objectName) return null;
    return qualifiedRoutineName({ databaseType: dbType, schema, routineName: node.objectName });
  }
  if (node.type === "index") {
    if (!["postgres", "oracle", "oceanbase-oracle"].includes(dbType)) return null;
    const index = node.meta as { name?: string } | undefined;
    const name = index?.name;
    return name ? qualifiedTableName({ ...options, schema, tableName: name, database: node.database, catalog: node.catalog, includeDatabaseName: true }) : null;
  }
  if (["type-member", "type-attribute", "type-method"].includes(node.type)) {
    if (!["oracle", "oceanbase-oracle"].includes(dbType) || !node.parentName || !["package", "type"].includes(node.parentType ?? "")) return null;
  }
  const name = node.objectName || node.label;
  if (!name) return null;
  const namespace = node.parentName && ["package", "type"].includes(node.parentType ?? "") ? node.parentName : name;
  const qualifiedNamespace = qualifiedTableName({ ...options, schema, tableName: namespace, database: node.database, catalog: node.catalog, includeDatabaseName: true });
  if (node.parentName && ["package", "type"].includes(node.parentType ?? "")) return `${qualifiedNamespace}.${quote(name)}`;
  return qualifiedNamespace;
}
