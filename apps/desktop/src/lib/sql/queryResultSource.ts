import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { SqlSemanticRowSource } from "@/lib/sql/semantic/types";
import type { DatabaseType } from "@/types/database";

export interface QueryResultSourceLabelOptions {
  database?: string;
  databaseType?: DatabaseType;
}

const HASH_COMMENT_DATABASE_TYPES = new Set<DatabaseType>(["mysql"]);

export function queryResultNameFromPreamble(preamble: string, options: Pick<QueryResultSourceLabelOptions, "databaseType"> = {}): string | undefined {
  const beforeStatementLine = preamble.replace(/[ \t]*$/, "");
  const previousLine =
    beforeStatementLine
      .replace(/\r?\n$/, "")
      .split(/\r?\n/)
      .pop() ?? "";
  const commentMatch = previousLine.match(/^\s*(--|#)\s*(.*)$/);
  if (commentMatch?.[1] === "#" && !HASH_COMMENT_DATABASE_TYPES.has(options.databaseType!)) return undefined;
  const comment = commentMatch?.[2]?.trim();
  if (!comment) return undefined;

  const nameMatch = comment.match(/^name\s*:\s*(.*)$/i);
  return nameMatch ? nameMatch[1]?.trim() || undefined : comment;
}

function firstSourceOfKind(sources: SqlSemanticRowSource[], kind: SqlSemanticRowSource["kind"]): SqlSemanticRowSource | undefined {
  return sources.filter((source) => source.kind === kind).sort((left, right) => left.sourceSpan.start - right.sourceSpan.start)[0];
}

export interface QueryResultSourceNameParts {
  /** 库名 / schema 等限定名；SQL 未显式限定时由当前库补齐 */
  qualifier?: string;
  /** 表名或写入目标对象名 */
  name: string;
}

/**
 * 解析结果集来源的限定名与对象名。结果集页签需要按设置决定是否展示限定名，
 * 而库名本身可能包含点（例如 `cosimulation2.0`），所以不能对拼好的标签做字符串切割。
 */
export function queryResultSourceNameParts(sql: string, options: QueryResultSourceLabelOptions = {}): QueryResultSourceNameParts | undefined {
  const statement = sql.trim();
  if (!statement) return undefined;

  const model = buildSqlSemanticModel(statement, statement.length, { databaseType: options.databaseType });
  const source = firstSourceOfKind(model.rowSources, "mutation_target") ?? firstSourceOfKind(model.rowSources, "table");
  if (!source?.name) return undefined;

  const qualifier = source.qualifierParts[source.qualifierParts.length - 1]?.trim() || options.database?.trim();
  return { qualifier: qualifier || undefined, name: source.name };
}

export function queryResultSourceLabel(sql: string, options: QueryResultSourceLabelOptions = {}): string | undefined {
  const parts = queryResultSourceNameParts(sql, options);
  if (!parts) return undefined;
  return parts.qualifier ? `${parts.qualifier}.${parts.name}` : parts.name;
}
