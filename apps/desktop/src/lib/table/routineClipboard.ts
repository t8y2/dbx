import type { DatabaseType, TreeNode } from "@/types/database";

export interface RoutineClipboardContext {
  connectionId: string;
  database: string;
  schema?: string;
}

export interface RoutineClipboardEntry extends RoutineClipboardContext {
  name: string;
  objectType: "PROCEDURE" | "FUNCTION";
  signature?: string;
}

const routineClipboardDatabases = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "oracle", "oceanbase-oracle"]);

/** Keep clipboard actions aligned with the databases covered by routine-copy SQL generation. */
export function supportsRoutineClipboardDatabase(databaseType: DatabaseType | undefined): boolean {
  return databaseType !== undefined && routineClipboardDatabases.has(databaseType);
}

function isStandaloneRoutine(node: TreeNode): boolean {
  return (node.type === "procedure" || node.type === "function") && node.parentType !== "package" && node.parentType !== "package-body" && node.parentType !== "type" && node.parentType !== "type-body";
}

function defaultNodeSchema(node: TreeNode): string | undefined {
  return node.schema || (node.type === "schema" ? node.label : undefined);
}

/** A single routine carries its metadata identity, not its signature-decorated display label. */
export function routineClipboardEntryForSelection(nodes: readonly TreeNode[], databaseTypeForNode: (node: TreeNode) => DatabaseType | undefined, schemaForNode: (node: TreeNode) => string | undefined = defaultNodeSchema): RoutineClipboardEntry | null {
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  if (!isStandaloneRoutine(node) || !node.connectionId || !node.database || node.linkedServer || !supportsRoutineClipboardDatabase(databaseTypeForNode(node))) return null;
  const displaySignature = node.signature ? `(${node.signature})` : "";
  const name = node.objectName || (displaySignature && node.label.endsWith(displaySignature) ? node.label.slice(0, -displaySignature.length) : node.label);
  if (!name.trim()) return null;
  return {
    connectionId: node.connectionId,
    database: node.database,
    schema: schemaForNode(node),
    name,
    objectType: node.type === "procedure" ? "PROCEDURE" : "FUNCTION",
    ...(node.signature !== undefined ? { signature: node.signature } : {}),
  };
}

/** Paste stays within the source scope; cross-database transfer is a separate workflow. */
export function routineClipboardPasteTarget(routine: RoutineClipboardEntry, node: TreeNode, schemaForNode: (node: TreeNode) => string | undefined = defaultNodeSchema): RoutineClipboardContext | null {
  if (!node.connectionId || !node.database || node.linkedServer) return null;
  const routineType = routine.objectType === "PROCEDURE" ? "procedure" : "function";
  const groupType = routine.objectType === "PROCEDURE" ? "group-procedures" : "group-functions";
  if (node.type !== "database" && node.type !== "schema" && node.type !== groupType && !(node.type === routineType && isStandaloneRoutine(node))) return null;
  // A database row has no selected schema. Keep the copied routine's explicit
  // source schema instead of silently choosing a different default schema.
  const schema = node.type === "database" && !node.schema ? routine.schema : schemaForNode(node);
  const target = { connectionId: node.connectionId, database: node.database, schema };
  if (target.connectionId !== routine.connectionId || target.database !== routine.database || (target.schema ?? "") !== (routine.schema ?? "")) return null;
  return target;
}
