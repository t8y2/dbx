import { ensureSqlExtension, stripSqlExtension } from "@/lib/savedSql/savedSqlFileName";
import type { TreeNode } from "@/types/database";

export interface SavedSqlPasteTarget {
  connectionId: string;
  catalog?: string;
  database: string;
  schema?: string;
}

export function savedSqlClipboardFileIds(nodes: readonly TreeNode[]): string[] {
  return [...new Set(nodes.filter((node) => node.type === "saved-sql-file" && !!node.savedSqlId).map((node) => node.savedSqlId!))];
}

export function savedSqlPasteTargetForNode(node: Pick<TreeNode, "type" | "connectionId" | "catalog" | "database" | "schema">): SavedSqlPasteTarget | null {
  if (node.type !== "database" && node.type !== "saved-sql-root" && node.type !== "saved-sql-file") return null;
  if (!node.connectionId || node.database === undefined) return null;
  return {
    connectionId: node.connectionId,
    catalog: node.catalog,
    database: node.database,
    schema: node.schema,
  };
}

export function nextSavedSqlCopyName(sourceName: string, takenNames: ReadonlySet<string>): string {
  const normalizedSource = ensureSqlExtension(sourceName);
  const sourceBase = stripSqlExtension(normalizedSource);
  const copyBase = sourceBase.replace(/_copy\d+$/i, "") || sourceBase;
  const normalizedTakenNames = new Set([...takenNames].map((name) => ensureSqlExtension(name).toLocaleLowerCase()));

  let index = 1;
  while (normalizedTakenNames.has(`${copyBase}_copy${index}.sql`.toLocaleLowerCase())) index++;
  return `${copyBase}_copy${index}.sql`;
}
