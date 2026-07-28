import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { extractIdentifierPartsAt, isSqlKeyword, sqlObjectNavigationTarget, type SqlObjectNavigationTarget, type SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import type { ActiveTabSidebarTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import type { DatabaseType, QueryTab, TreeNode } from "@/types/database";

export interface QueryCursorTableCandidate {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

export interface QueryTableCandidateAtPositionInput {
  connectionId: string;
  database: string;
  schema?: string;
  databaseType?: DatabaseType;
  sql: string;
  position: number;
}

export type QueryContextObjectAction = "view-data" | "edit-table-structure" | "edit-view" | "view-source" | "view-ddl";

export type QueryContextObjectRoute =
  | { event: "viewTableData"; payload: [target: SqlObjectNavigationTarget] }
  | { event: "editTableStructure"; payload: [target: SqlObjectNavigationTarget] }
  | { event: "openObjectSource"; payload: [target: SqlObjectNavigationTarget, initialEditing: boolean] }
  | { event: "viewTableDdl"; payload: [target: SqlObjectNavigationTarget] };

export function extractQualifiedIdentifierPartsAt(sql: string, pos: number) {
  let parts = extractIdentifierPartsAt(sql, pos);
  // CodeMirror can report the boundary immediately after the clicked token;
  // retain the legacy behavior that treats that boundary as part of the identifier.
  if (parts.length === 0 && pos > 0) parts = extractIdentifierPartsAt(sql, pos - 1);
  const last = parts[parts.length - 1];
  if (!last || (!last.quoted && isSqlKeyword(last.value))) return [];
  return parts;
}

export function queryCursorTableCandidate(tab: QueryTab | undefined | null, databaseType?: DatabaseType): QueryCursorTableCandidate | null {
  if (!tab || tab.mode !== "query" || !tab.connectionId || !tab.database) return null;

  const cursor = tab.editorSelection?.head ?? tab.editorSelection?.anchor ?? tab.sql.length;
  return queryTableCandidateAtSqlPosition({
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    databaseType,
    sql: tab.sql,
    position: cursor,
  });
}

export function queryTableCandidateAtSqlPosition(input: QueryTableCandidateAtPositionInput): QueryCursorTableCandidate | null {
  const dialect = sqlSemanticDialectFor({ databaseType: input.databaseType });
  // View-data SQL quotes resolved names, so fold only unquoted input exactly as the database does before quoting it again.
  const parts = extractQualifiedIdentifierPartsAt(input.sql, input.position).map((part) => dialect.normalizeIdentifier(part.value, part.quoted));
  if (parts.length === 0) return null;

  const tableName = parts[parts.length - 1];
  let database = input.database;
  let schema = input.schema;

  if (parts.length >= 3) {
    database = parts[parts.length - 3];
    schema = parts[parts.length - 2];
  } else if (parts.length === 2) {
    if (input.databaseType && !isSchemaAware(input.databaseType) && !isSingleDatabase(input.databaseType)) {
      database = parts[0];
      schema = undefined;
    } else {
      schema = parts[0];
    }
  }

  return { connectionId: input.connectionId, database, schema, tableName };
}

export function resolveQueryContextCandidateDatabase(candidate: QueryCursorTableCandidate, databases: readonly string[]): QueryCursorTableCandidate {
  const database = databases.find((name) => sameIdentifier(name, candidate.database));
  return database && database !== candidate.database ? { ...candidate, database } : candidate;
}

export function resolveQueryContextObjectTarget(candidate: QueryCursorTableCandidate, tables: readonly SqlCompletionTable[]): SqlObjectNavigationTarget {
  const nameMatches = tables.filter((table) => sameIdentifier(table.name, candidate.tableName));
  const match = candidate.schema ? (nameMatches.find((table) => sameIdentifier(table.schema, candidate.schema)) ?? nameMatches.find((table) => !table.schema)) : nameMatches[0];
  return sqlObjectNavigationTarget({
    name: match?.name ?? candidate.tableName,
    database: candidate.database,
    schema: match?.schema ?? candidate.schema,
    type: match?.type,
  });
}

export function queryContextObjectActions(type?: SqlObjectNavigationType): QueryContextObjectAction[] {
  if (type === "view" || type === "materialized_view") {
    return ["view-data", "edit-view", "view-source", "view-ddl"];
  }
  // Unknown metadata preserves the historical table actions instead of disabling existing entry points.
  return ["view-data", "edit-table-structure", "view-ddl"];
}

export function queryContextObjectRoute(action: QueryContextObjectAction, target: SqlObjectNavigationTarget): QueryContextObjectRoute {
  switch (action) {
    case "view-data":
      return { event: "viewTableData", payload: [target] };
    case "edit-table-structure":
      return { event: "editTableStructure", payload: [target] };
    case "edit-view":
      return { event: "openObjectSource", payload: [target, true] };
    case "view-source":
      return { event: "openObjectSource", payload: [target, false] };
    case "view-ddl":
      return { event: "viewTableDdl", payload: [target] };
  }
}

export function qualifiedTableNameAtSqlPosition(sql: string, pos: number): string | null {
  const parts = extractQualifiedIdentifierPartsAt(sql, pos).map((part) => part.value);
  if (parts.length === 0) return null;
  return parts.join(".");
}

export function queryContextTargetFromCandidate(tab: QueryTab | undefined | null, candidate?: QueryCursorTableCandidate | null): ActiveTabSidebarTarget | null {
  if (!tab || tab.mode !== "query" || !tab.connectionId || !tab.database) return null;
  return {
    type: "query-context",
    connectionId: tab.connectionId,
    database: candidate?.database || tab.database,
    schema: candidate?.schema ?? tab.schema,
  };
}

function sameIdentifier(left: string | undefined, right: string | undefined): boolean {
  return (left || "").toLowerCase() === (right || "").toLowerCase();
}

function nodeMatchesCandidate(node: TreeNode, candidate: QueryCursorTableCandidate): boolean {
  if (node.type !== "table" && node.type !== "view" && node.type !== "materialized_view") return false;
  if (node.connectionId !== candidate.connectionId) return false;
  if (!sameIdentifier(node.database, candidate.database)) return false;
  if (candidate.schema && !sameIdentifier(node.schema, candidate.schema)) return false;
  return sameIdentifier(node.label, candidate.tableName);
}

export function findLoadedTableTargetForCandidate(nodes: readonly TreeNode[], candidate: QueryCursorTableCandidate): ActiveTabSidebarTarget | null {
  for (const node of nodes) {
    if (nodeMatchesCandidate(node, candidate)) {
      return {
        type: "table",
        connectionId: candidate.connectionId,
        database: node.database || candidate.database,
        schema: node.schema || candidate.schema,
        tableName: node.label,
      };
    }

    if (node.children) {
      const found = findLoadedTableTargetForCandidate(node.children, candidate);
      if (found) return found;
    }
  }

  return null;
}
