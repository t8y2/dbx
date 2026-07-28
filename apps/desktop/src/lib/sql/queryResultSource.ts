import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { SqlSemanticRowSource } from "@/lib/sql/semantic/types";
import type { DatabaseType } from "@/types/database";

export interface QueryResultSourceLabelOptions {
  database?: string;
  databaseType?: DatabaseType;
}

export function queryResultNameFromPreamble(preamble: string): string | undefined {
  let name: string | undefined;
  const withoutBlockComments = preamble.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of withoutBlockComments.split(/\r?\n/)) {
    const candidate = line.match(/^\s*--\s*name\s*:\s*(.*)$/i)?.[1]?.trim();
    if (candidate) name = candidate;
  }
  return name;
}

function firstSourceOfKind(sources: SqlSemanticRowSource[], kind: SqlSemanticRowSource["kind"]): SqlSemanticRowSource | undefined {
  return sources.filter((source) => source.kind === kind).sort((left, right) => left.sourceSpan.start - right.sourceSpan.start)[0];
}

export function queryResultSourceLabel(sql: string, options: QueryResultSourceLabelOptions = {}): string | undefined {
  const statement = sql.trim();
  if (!statement) return undefined;

  const model = buildSqlSemanticModel(statement, statement.length, { databaseType: options.databaseType });
  const source = firstSourceOfKind(model.rowSources, "mutation_target") ?? firstSourceOfKind(model.rowSources, "table");
  if (!source?.name) return undefined;

  const qualifier = source.qualifierParts[source.qualifierParts.length - 1]?.trim() || options.database?.trim();
  return qualifier ? `${qualifier}.${source.name}` : source.name;
}
