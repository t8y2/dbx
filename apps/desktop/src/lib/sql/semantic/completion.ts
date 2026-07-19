import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionReferencedTable } from "@/lib/sql/sqlCompletion";
import { SQL_SEMANTIC_DIALECTS } from "@/lib/sql/semantic/dialect";
import type { SqlSemanticModel, SqlSemanticRowSource } from "@/lib/sql/semantic/types";

export type SqlSemanticCompletionScopeKind = "keyword" | "table" | "schema" | "catalog" | "routine" | "columns" | "local";

export interface SqlSemanticCompletionScope {
  kind: SqlSemanticCompletionScopeKind;
  prefix: string;
  qualifierParts: string[];
  targetSource?: SqlSemanticRowSource;
  useRemoteMetadata: boolean;
  fallbackReason?: string;
}

export function sqlSemanticReferencedTables(model: SqlSemanticModel): SqlCompletionReferencedTable[] {
  return model.rowSources
    .filter((source) => source.kind !== "unknown")
    .map((source) => ({
      name: source.name,
      schema: source.qualifierParts[source.qualifierParts.length - 1],
      alias: source.alias,
      columns: source.columns,
      columnAliases: source.columnAliases,
    }));
}

export function sqlSemanticLocalColumnsByTable(model: SqlSemanticModel): Map<string, SqlCompletionColumn[]> {
  const columnsByTable = new Map<string, SqlCompletionColumn[]>();
  for (const source of model.rowSources) {
    if (!source.columns?.length) continue;
    columnsByTable.set(
      source.name,
      source.columns.map((name) => ({
        name,
        table: source.name,
        schema: source.qualifierParts[source.qualifierParts.length - 1],
      })),
    );
  }
  return columnsByTable;
}

function activeProjectionAliasClause(model: SqlSemanticModel): "where" | "groupBy" | "having" | "orderBy" | null {
  const words = model.tokens.filter((token) => token.span.end <= model.cursor && token.kind === "word").map((token) => token.normalized);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    const previous = words[index - 1];
    if (word === "by" && previous === "order") return "orderBy";
    if (word === "by" && previous === "group") return "groupBy";
    if (word === "having") return "having";
    if (word === "where") return "where";
    if (word === "from" || word === "join" || word === "select") return null;
  }
  return null;
}

export function sqlSemanticProjectionAliasColumns(model: SqlSemanticModel): SqlCompletionColumn[] {
  const clause = activeProjectionAliasClause(model);
  if (!clause) return [];
  const adapter = SQL_SEMANTIC_DIALECTS[model.dialectId] ?? SQL_SEMANTIC_DIALECTS.generic;
  if (!adapter.projectionAliasVisibility[clause]) return [];
  return model.projections
    .filter((projection) => projection.name)
    .map((projection) => ({
      name: projection.name,
      table: "__projection__",
      comment: "Projection alias",
    }));
}

export function sqlSemanticCompletionScope(model: SqlSemanticModel): SqlSemanticCompletionScope {
  const intent = model.cursorIntent;
  const targetSource = intent.targetSourceId ? model.rowSources.find((source) => source.id === intent.targetSourceId) : undefined;
  switch (intent.kind) {
    case "table":
    case "delete_target":
      return {
        kind: "table",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        useRemoteMetadata: intent.confidence !== "low",
        fallbackReason: intent.fallbackReason,
      };
    case "schema":
      return {
        kind: "schema",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        useRemoteMetadata: intent.confidence !== "low",
        fallbackReason: intent.fallbackReason,
      };
    case "catalog":
      return {
        kind: "catalog",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        useRemoteMetadata: intent.confidence !== "low",
        fallbackReason: intent.fallbackReason,
      };
    case "routine":
      return {
        kind: "routine",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        useRemoteMetadata: intent.confidence !== "low",
        fallbackReason: intent.fallbackReason,
      };
    case "column":
    case "alias_column":
    case "insert_column":
    case "update_column":
    case "join_condition":
    case "star":
      return {
        kind: "columns",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        targetSource,
        useRemoteMetadata: intent.confidence !== "low" && (!!targetSource || model.rowSources.length > 0),
        fallbackReason: intent.fallbackReason,
      };
    case "suppressed":
      return {
        kind: "local",
        prefix: intent.prefix,
        qualifierParts: [],
        useRemoteMetadata: false,
        fallbackReason: intent.fallbackReason ?? "suppressed",
      };
    case "keyword":
      return {
        kind: "keyword",
        prefix: intent.prefix,
        qualifierParts: intent.qualifierParts,
        useRemoteMetadata: false,
        fallbackReason: intent.fallbackReason,
      };
  }
}

function semanticContextKind(model: SqlSemanticModel): SqlCompletionContext["contextKind"] {
  switch (model.cursorIntent.kind) {
    case "table":
    case "schema":
    case "catalog":
    case "delete_target":
      return "table";
    case "routine":
      return "routine";
    case "alias_column":
      return "alias_column";
    case "insert_column":
    case "update_column":
    case "column":
    case "star":
      return "column";
    case "join_condition":
      return "join";
    case "keyword":
    case "suppressed":
      return "keyword";
  }
}

function semanticMutationTarget(model: SqlSemanticModel): SqlSemanticRowSource | undefined {
  const targetId = model.cursorIntent.targetSourceId;
  return targetId ? model.rowSources.find((source) => source.id === targetId) : model.rowSources.find((source) => source.kind === "mutation_target");
}

export function sqlCompletionContextFromSemantic(model: SqlSemanticModel, base: SqlCompletionContext): SqlCompletionContext {
  if (model.cursorIntent.confidence === "low" || model.cursorIntent.kind === "suppressed") {
    return base;
  }
  if ((base.suggestTables || base.exclusiveTableSuggestions) && model.cursorIntent.kind !== "table" && model.cursorIntent.kind !== "schema" && model.cursorIntent.kind !== "catalog" && model.cursorIntent.kind !== "delete_target") {
    return base;
  }

  const scope = sqlSemanticCompletionScope(model);
  const qualifier = model.cursorIntent.qualifierParts.length > 0 ? model.cursorIntent.qualifierParts.join(".") : undefined;
  const referencedTables = sqlSemanticReferencedTables(model);
  const mutationTarget = semanticMutationTarget(model);
  const mutationSchema = mutationTarget?.qualifierParts[mutationTarget.qualifierParts.length - 1];
  const suggestTables = scope.kind === "table" || scope.kind === "schema" || scope.kind === "catalog";
  const suggestColumns = scope.kind === "columns";
  const suggestRoutines = scope.kind === "routine" || (suggestColumns && base.suggestRoutines && !base.exclusiveColumnSuggestions);
  const projectionAliases = sqlSemanticProjectionAliasColumns(model).map((column) => column.name);

  return {
    ...base,
    prefix: model.cursorIntent.prefix,
    qualifier,
    qualifierParts: model.cursorIntent.qualifierParts.length > 0 ? [...model.cursorIntent.qualifierParts] : undefined,
    suggestTables,
    suggestColumns,
    suggestKeywords: scope.kind === "keyword" || (!suggestTables && !suggestColumns && !suggestRoutines),
    suggestRoutines,
    suggestJoinConditions: model.cursorIntent.kind === "join_condition",
    exclusiveTableSuggestions: suggestTables,
    exclusiveColumnSuggestions: model.cursorIntent.kind === "alias_column" || model.cursorIntent.kind === "insert_column" || model.cursorIntent.kind === "update_column",
    exclusiveRoutineSuggestions: scope.kind === "routine",
    prioritizeSelectAliases: base.prioritizeSelectAliases || projectionAliases.length > 0,
    selectAliases: projectionAliases.length > 0 ? projectionAliases : base.selectAliases,
    referencedTables: referencedTables.length > 0 ? referencedTables : base.referencedTables,
    insertTable: model.cursorIntent.kind === "insert_column" ? mutationTarget?.name : base.insertTable,
    insertSchema: model.cursorIntent.kind === "insert_column" ? mutationSchema : base.insertSchema,
    updateTarget: model.cursorIntent.kind === "update_column" && mutationTarget ? { table: mutationTarget.name, schema: mutationSchema } : base.updateTarget,
    deleteTarget: model.cursorIntent.kind === "delete_target" && mutationTarget ? { table: mutationTarget.name, schema: mutationSchema } : base.deleteTarget,
    onStar: model.cursorIntent.kind === "star" || base.onStar,
    contextKind: semanticContextKind(model),
  };
}
