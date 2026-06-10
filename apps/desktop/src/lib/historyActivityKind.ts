export type HistoryActivityKind = "query" | "data_change" | "schema_change" | "import" | "transfer" | "redis_command";

export type HistoryActivitySource = {
  activity_kind?: HistoryActivityKind;
  operation?: string;
  sql?: string;
};

const READ_RE = /^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE)\b/i;
const SCHEMA_RE = /^\s*(CREATE|ALTER|DROP|RENAME)\b/i;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

function statementsFor(sql: string): string[] {
  return stripSqlComments(sql)
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

export function classifySqlActivityKind(sql: string): "query" | "data_change" | "schema_change" {
  const statements = statementsFor(sql);
  if (statements.some((stmt) => SCHEMA_RE.test(stmt))) return "schema_change";
  if (statements.some((stmt) => WRITE_RE.test(stmt))) return "data_change";
  if (statements.every((stmt) => READ_RE.test(stmt))) return "query";
  return "query";
}

export function resolveHistoryActivityKind(entry: HistoryActivitySource): HistoryActivityKind {
  if (entry.activity_kind && entry.activity_kind !== "query") return entry.activity_kind;

  const operation = entry.operation?.trim();
  if (operation && SCHEMA_RE.test(operation)) return "schema_change";
  if (operation && WRITE_RE.test(operation)) return "data_change";

  return entry.sql ? classifySqlActivityKind(entry.sql) : "query";
}
