import { isSchemaAware, isSingleDatabase } from "@/lib/databaseFeatureSupport";
import { isSqlKeyword } from "@/lib/sqlNavigation";
import type { ActiveTabSidebarTarget } from "@/lib/sidebarActiveTabTarget";
import type { DatabaseType, QueryTab, TreeNode } from "@/types/database";

export interface QueryCursorTableCandidate {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

export interface IdentifierPart {
  value: string;
  quoted: boolean;
}

function identifierChar(ch: string | undefined): boolean {
  return !!ch && (/[A-Za-z0-9_$."`-]/.test(ch) || ch === "[" || ch === "]");
}

function readIdentifierWindow(sql: string, pos: number): string {
  const clamped = Math.max(0, Math.min(pos, sql.length));
  let from = clamped;
  let to = clamped;

  if (!identifierChar(sql[from]) && identifierChar(sql[from - 1])) {
    from -= 1;
    to = from + 1;
  }

  if (!identifierChar(sql[from])) return "";

  while (from > 0 && identifierChar(sql[from - 1])) from -= 1;
  while (to < sql.length && identifierChar(sql[to])) to += 1;
  return sql.slice(from, to).replace(/^\.+|\.+$/g, "");
}

function splitQualifiedIdentifier(text: string): IdentifierPart[] {
  const parts: IdentifierPart[] = [];
  let current = "";
  let quoted = false;
  let quote: "`" | '"' | "]" | null = null;

  function pushPart() {
    const value = current.trim();
    if (value) parts.push({ value, quoted });
    current = "";
    quoted = false;
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (quote === "]" && ch === "]") {
        if (text[i + 1] === "]") {
          current += "]";
          i += 1;
        } else {
          quote = null;
        }
        continue;
      }
      if ((quote === "`" || quote === '"') && ch === quote) {
        if (text[i + 1] === quote) {
          current += ch;
          i += 1;
        } else {
          quote = null;
        }
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === ".") {
      pushPart();
      continue;
    }

    if (ch === "`" || ch === '"') {
      quoted = true;
      quote = ch;
      continue;
    }

    if (ch === "[") {
      quoted = true;
      quote = "]";
      continue;
    }

    current += ch;
  }

  pushPart();
  return parts;
}

export function extractQualifiedIdentifierPartsAt(sql: string, pos: number): IdentifierPart[] {
  const text = readIdentifierWindow(sql, pos);
  if (!text) return [];
  const parts = splitQualifiedIdentifier(text);
  const last = parts[parts.length - 1];
  if (!last || (!last.quoted && isSqlKeyword(last.value))) return [];
  return parts;
}

export function queryCursorTableCandidate(tab: QueryTab | undefined | null, databaseType?: DatabaseType): QueryCursorTableCandidate | null {
  if (!tab || tab.mode !== "query" || !tab.connectionId || !tab.database) return null;

  const cursor = tab.editorSelection?.head ?? tab.editorSelection?.anchor ?? tab.sql.length;
  const parts = extractQualifiedIdentifierPartsAt(tab.sql, cursor).map((part) => part.value);
  if (parts.length === 0) return null;

  const tableName = parts[parts.length - 1];
  let database = tab.database;
  let schema = tab.schema;

  if (parts.length >= 3) {
    database = parts[parts.length - 3];
    schema = parts[parts.length - 2];
  } else if (parts.length === 2) {
    if (databaseType && !isSchemaAware(databaseType) && !isSingleDatabase(databaseType)) {
      database = parts[0];
      schema = undefined;
    } else {
      schema = parts[0];
    }
  }

  return { connectionId: tab.connectionId, database, schema, tableName };
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
