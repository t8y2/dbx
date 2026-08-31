import type { SavedSqlFile, TreeNode } from "@/types/database";
import { stripSqlExtension } from "@/lib/savedSql/savedSqlFileName";

const savedSqlNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function savedSqlCopySortKey(name: string): { base: string; copyIndex: number } {
  const base = stripSqlExtension(name);
  const copyMatch = base.match(/^(.*)_copy(\d+)$/i);
  if (!copyMatch?.[1]) return { base, copyIndex: 0 };
  return { base: copyMatch[1], copyIndex: Number(copyMatch[2]) };
}

function compareSavedSqlFiles(left: SavedSqlFile, right: SavedSqlFile): number {
  const leftKey = savedSqlCopySortKey(left.name);
  const rightKey = savedSqlCopySortKey(right.name);
  return savedSqlNameCollator.compare(leftKey.base, rightKey.base) || leftKey.copyIndex - rightKey.copyIndex || savedSqlNameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id);
}

export interface SavedSqlDatabaseScope {
  connectionId: string;
  catalog?: string;
  database: string;
}

export type SavedSqlDatabaseIndex = ReadonlyMap<string, readonly SavedSqlFile[]>;
type SavedSqlDatabaseSource = readonly SavedSqlFile[] | SavedSqlDatabaseIndex;

export function savedSqlDatabaseScopeKey(scope: SavedSqlDatabaseScope): string {
  // Null is deliberately a concrete built-in/default catalog scope, not a wildcard.
  return JSON.stringify([scope.connectionId, scope.catalog || null, scope.database]);
}

export function indexSavedSqlFilesByDatabase(files: readonly SavedSqlFile[]): SavedSqlDatabaseIndex {
  const index = new Map<string, SavedSqlFile[]>();
  for (const file of files) {
    const key = savedSqlDatabaseScopeKey(file);
    const scopedFiles = index.get(key);
    if (scopedFiles) scopedFiles.push(file);
    else index.set(key, [file]);
  }
  for (const scopedFiles of index.values()) scopedFiles.sort(compareSavedSqlFiles);
  return index;
}

export function savedSqlFilesForDatabase(source: SavedSqlDatabaseSource, scope: SavedSqlDatabaseScope): SavedSqlFile[] {
  if (!Array.isArray(source)) return [...((source as SavedSqlDatabaseIndex).get(savedSqlDatabaseScopeKey(scope)) ?? [])];
  return source.filter((file) => savedSqlDatabaseScopeKey(file) === savedSqlDatabaseScopeKey(scope)).sort(compareSavedSqlFiles);
}

function savedSqlFileNode(rootId: string, file: SavedSqlFile): TreeNode {
  return {
    id: `${rootId}:file:${file.id}`,
    label: file.name,
    type: "saved-sql-file",
    connectionId: file.connectionId,
    catalog: file.catalog,
    database: file.database,
    schema: file.schema,
    savedSqlId: file.id,
  };
}

export function buildDatabaseSavedSqlRootNode(databaseNode: Pick<TreeNode, "id" | "connectionId" | "catalog" | "database">, source: SavedSqlDatabaseSource, existingRoot?: TreeNode): TreeNode | null {
  if (!databaseNode.connectionId || databaseNode.database === undefined) return null;

  const id = `${databaseNode.id}:__queries`;
  return {
    id,
    label: "tree.queries",
    type: "saved-sql-root",
    connectionId: databaseNode.connectionId,
    catalog: databaseNode.catalog,
    database: databaseNode.database,
    isExpanded: existingRoot?.isExpanded ?? true,
    children: savedSqlFilesForDatabase(source, {
      connectionId: databaseNode.connectionId,
      catalog: databaseNode.catalog,
      database: databaseNode.database,
    }).map((file) => savedSqlFileNode(id, file)),
  };
}

export function withDatabaseSavedSqlRoot(databaseNode: Pick<TreeNode, "id" | "connectionId" | "catalog" | "database" | "children">, children: readonly TreeNode[], source: SavedSqlDatabaseSource): TreeNode[] {
  const existingRoot = databaseNode.children?.find((child) => child.type === "saved-sql-root");
  const root = buildDatabaseSavedSqlRootNode(databaseNode, source, existingRoot);
  const metadataChildren = children.filter((child) => child.type !== "saved-sql-root");
  return root ? [...metadataChildren, root] : metadataChildren;
}

export function decorateDatabaseSavedSqlTreeNodes(nodes: readonly TreeNode[], source: SavedSqlDatabaseSource, existingNodes: readonly TreeNode[] = []): TreeNode[] {
  const existingById = new Map(existingNodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const existing = existingById.get(node.id);
    const children = decorateDatabaseSavedSqlTreeNodes(node.children ?? [], source, existing?.children ?? []);
    if (node.type !== "database") {
      return node.children === undefined ? node : { ...node, children };
    }

    const databaseNode = {
      ...node,
      children: existing?.children ?? node.children,
    };
    return {
      ...node,
      children: withDatabaseSavedSqlRoot(databaseNode, children, source),
    };
  });
}

export function stripDatabaseSavedSqlTreeNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "saved-sql-root" || node.type === "saved-sql-file" || node.type === "saved-sql-folder") return [];
    const children = node.children ? stripDatabaseSavedSqlTreeNodes(node.children) : undefined;
    const hiddenChildren = node.hiddenChildren ? stripDatabaseSavedSqlTreeNodes(node.hiddenChildren) : undefined;
    if (children === node.children && hiddenChildren === node.hiddenChildren) return [node];
    return [{ ...node, children, hiddenChildren }];
  });
}
