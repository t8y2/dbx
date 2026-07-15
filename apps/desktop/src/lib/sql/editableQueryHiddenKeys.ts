import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

const HIDDEN_PRIMARY_KEY_ALIAS_PREFIX = "__DBX_PK_";

export interface HiddenPrimaryKeyProjection {
  sourceName: string;
  alias: string;
}

export interface HiddenPrimaryKeyQuery {
  sql: string;
  projections: HiddenPrimaryKeyProjection[];
}

export function buildQueryWithHiddenPrimaryKeys(options: { sql: string; databaseType: DatabaseType; primaryKeys: string[]; existingResultNames: string[]; sourceExpressions?: Record<string, string> }): HiddenPrimaryKeyQuery | undefined {
  if (options.primaryKeys.length === 0) return undefined;

  const dialect = sqlSemanticDialectFor({ databaseType: options.databaseType });
  const usedNames = new Set(options.existingResultNames.map((name) => name.toLowerCase()));
  const projections = options.primaryKeys.map((sourceName, index) => {
    let suffix = index;
    let alias = `${HIDDEN_PRIMARY_KEY_ALIAS_PREFIX}${suffix}`;
    while (usedNames.has(alias.toLowerCase())) {
      suffix += 1;
      alias = `${HIDDEN_PRIMARY_KEY_ALIAS_PREFIX}${suffix}`;
    }
    usedNames.add(alias.toLowerCase());
    return { sourceName, alias };
  });
  const expressions = projections.map(({ sourceName, alias }) => `${options.sourceExpressions?.[sourceName] ?? dialect.quoteIdentifier(sourceName)} AS ${dialect.quoteIdentifier(alias)}`);
  const sql = appendSelectProjections(options.sql, expressions, options.databaseType);
  return sql ? { sql, projections } : undefined;
}

export function hiddenResultColumnIndexes(columns: string[], projections: HiddenPrimaryKeyProjection[]): number[] {
  return projections.flatMap((projection) => {
    const index = columns.findIndex((column) => column.toLowerCase() === projection.alias.toLowerCase());
    return index < 0 ? [] : [index];
  });
}

function appendSelectProjections(sql: string, expressions: string[], databaseType: DatabaseType): string | undefined {
  if (expressions.length === 0) return sql;
  const tokens = tokenizeSqlSemantic(sql);
  const selectIndex = tokens.findIndex((token) => token.kind === "word" && token.depth === 0 && token.normalized === "select");
  if (selectIndex < 0) return undefined;
  const fromIndex = tokens.findIndex((token, index) => index > selectIndex && token.kind === "word" && token.depth === 0 && token.normalized === "from");
  if (fromIndex < 0) return undefined;

  let projectionEnd: number | undefined;
  for (let index = fromIndex - 1; index > selectIndex; index -= 1) {
    const token = tokens[index];
    if (token?.kind === "comment") continue;
    projectionEnd = token?.span.end;
    break;
  }
  if (projectionEnd === undefined) return undefined;

  const projectionTokens = tokens.slice(selectIndex + 1, fromIndex).filter((token) => token.kind !== "comment");
  const bareWildcard = projectionTokens.length === 1 && projectionTokens[0]?.text === "*" ? projectionTokens[0] : undefined;
  const sourceReference = bareWildcard && databaseType === "oracle" ? singleOracleSourceReference(sql, bareWildcard.span.start) : undefined;
  if (!sourceReference || !bareWildcard) {
    return `${sql.slice(0, projectionEnd)}, ${expressions.join(", ")}${sql.slice(projectionEnd)}`;
  }

  const qualifiedWildcard = `${sourceReference}.*`;
  const qualifiedSql = `${sql.slice(0, bareWildcard.span.start)}${qualifiedWildcard}${sql.slice(bareWildcard.span.end)}`;
  const qualifiedProjectionEnd = projectionEnd + qualifiedWildcard.length - bareWildcard.text.length;
  return `${qualifiedSql.slice(0, qualifiedProjectionEnd)}, ${expressions.join(", ")}${qualifiedSql.slice(qualifiedProjectionEnd)}`;
}

function singleOracleSourceReference(sql: string, cursor: number): string | undefined {
  const model = buildSqlSemanticModel(sql, cursor, { databaseType: "oracle" });
  const sources = model.rowSources.filter((source) => source.kind === "table");
  if (sources.length !== 1) return undefined;

  const source = sources[0]!;
  if (source.aliasSpan) return sql.slice(source.aliasSpan.start, source.aliasSpan.end);
  return source.qualifiedName?.parts[source.qualifiedName.parts.length - 1]?.raw;
}
