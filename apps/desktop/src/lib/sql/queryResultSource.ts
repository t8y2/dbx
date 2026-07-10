import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { SqlSemanticRowSource } from "@/lib/sql/semantic/types";
import type { DatabaseType } from "@/types/database";

export interface QueryResultSourceLabelOptions {
  database?: string;
  databaseType?: DatabaseType;
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
