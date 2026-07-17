export type SqlMetadataRefreshScope = "none" | "connection" | "database";
export type SqlMetadataRefreshTarget = { scope: "none" } | { scope: "connection" } | { scope: "database"; schema?: string };

const DATABASE_DDL_RE = /\b(CREATE|DROP)\s+DATABASE\b/i;
const SCHEMA_DDL_RE = /\b(CREATE|DROP)\s+SCHEMA\b/i;
const OBJECT_DDL_RE = /\b(CREATE|ALTER|DROP|RENAME)\s+(OR\s+REPLACE\s+)?(((GLOBAL|LOCAL)\s+)?TEMP(ORARY)?\s+)?(MATERIALIZED\s+)?(TABLE|VIEW|INDEX|SEQUENCE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\b/i;
const OBJECT_NAME_DDL_RE =
  /\b(?:CREATE|ALTER|DROP|RENAME)\s+(?:OR\s+REPLACE\s+)?(?:(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW|SEQUENCE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))/i;
const INDEX_TABLE_DDL_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s+ON\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))/i;

function stripSqlMetadataComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

export function sqlMetadataRefreshScope(sql: string): SqlMetadataRefreshScope {
  return sqlMetadataRefreshTarget(sql).scope;
}

function splitSqlMetadataStatements(sql: string): string[] {
  return stripSqlMetadataComments(sql)
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function schemaFromQualifiedName(qualifiedName: string): string | undefined {
  const schema = qualifiedName.split(".")[0]?.trim();
  return schema ? unquoteIdentifier(schema) : undefined;
}

function schemaFromObjectDdl(statement: string): string | undefined {
  const match = statement.match(INDEX_TABLE_DDL_RE) || statement.match(OBJECT_NAME_DDL_RE);
  return match?.[1] ? schemaFromQualifiedName(match[1]) : undefined;
}

export function sqlMetadataRefreshTarget(sql: string, activeSchema?: string): SqlMetadataRefreshTarget {
  const statements = splitSqlMetadataStatements(sql);
  if (statements.some((stmt) => DATABASE_DDL_RE.test(stmt))) return { scope: "connection" };

  const schemaTargets = new Set<string>();
  let hasDatabaseRefresh = false;

  for (const statement of statements) {
    if (SCHEMA_DDL_RE.test(statement)) {
      hasDatabaseRefresh = true;
      continue;
    }
    if (!OBJECT_DDL_RE.test(statement)) continue;
    hasDatabaseRefresh = true;
    const schema = schemaFromObjectDdl(statement) || activeSchema;
    if (schema) schemaTargets.add(schema);
  }

  if (!hasDatabaseRefresh) return { scope: "none" };
  if (schemaTargets.size === 1) return { scope: "database", schema: [...schemaTargets][0] };
  return { scope: "database" };
}
