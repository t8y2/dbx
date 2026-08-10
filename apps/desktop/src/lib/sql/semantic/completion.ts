import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionReferencedTable } from "@/lib/sql/sqlCompletion";
import { SQL_SEMANTIC_DIALECTS } from "@/lib/sql/semantic/dialect";
import type { SqlSemanticModel, SqlSemanticRowSource, SqlSemanticToken } from "@/lib/sql/semantic/types";

export type SqlSemanticCompletionScopeKind = "keyword" | "table" | "schema" | "catalog" | "routine" | "columns" | "local";

export interface SqlSemanticCompletionScope {
  kind: SqlSemanticCompletionScopeKind;
  prefix: string;
  qualifierParts: string[];
  targetSource?: SqlSemanticRowSource;
  useRemoteMetadata: boolean;
  fallbackReason?: string;
}

function isSemanticIdentifier(token: SqlSemanticToken | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted_identifier";
}

function selectStarToken(model: SqlSemanticModel): SqlSemanticToken | undefined {
  const range = model.cursorIntent.replacementRange;
  if (model.cursorIntent.kind !== "star") return undefined;
  return model.tokens.find((token) => token.text === "*" && token.span.start === range.start && token.span.end === range.end);
}

export function sqlSemanticSelectStarTableSources(model: SqlSemanticModel): SqlSemanticRowSource[] {
  const star = selectStarToken(model);
  if (!star) return [];

  if (model.cursorIntent.targetSourceId) {
    const target = model.rowSources.find((source) => source.id === model.cursorIntent.targetSourceId);
    return target?.kind === "table" ? [target] : [];
  }
  if (model.cursorIntent.qualifierParts.length > 0) return [];

  let selectStart = -1;
  for (let index = model.tokens.length - 1; index >= 0; index -= 1) {
    const token = model.tokens[index];
    if (!token || token.span.end > star.span.start || token.depth !== star.depth) continue;
    if (token.kind === "word" && token.normalized === "select") {
      selectStart = token.span.start;
      break;
    }
  }
  if (selectStart < 0) return [];

  const blockSources = model.rowSources.filter((source) => {
    if (source.sourceSpan.start < selectStart) return false;
    const sourceToken = model.tokens.find((token) => token.span.start === source.sourceSpan.start);
    return sourceToken?.depth === star.depth;
  });
  return blockSources.every((source) => source.kind === "table") ? blockSources : [];
}

export function sqlSemanticSelectStarTableSource(model: SqlSemanticModel): SqlSemanticRowSource | undefined {
  const sources = sqlSemanticSelectStarTableSources(model);
  return sources.length === 1 ? sources[0] : undefined;
}

export function sqlSemanticSelectStarQualifierSql(model: SqlSemanticModel): string | undefined {
  const star = selectStarToken(model);
  if (!star) return undefined;
  const starIndex = model.tokens.indexOf(star);
  let index = starIndex - 1;
  if (model.tokens[index]?.text !== ".") return undefined;
  const qualifierEnd = model.tokens[index]!.span.start;
  index -= 1;
  if (!isSemanticIdentifier(model.tokens[index])) return undefined;
  let qualifierStart = model.tokens[index]!.span.start;
  while (index >= 2 && model.tokens[index - 1]?.text === "." && isSemanticIdentifier(model.tokens[index - 2])) {
    index -= 2;
    qualifierStart = model.tokens[index]!.span.start;
  }
  return model.sql.slice(qualifierStart, qualifierEnd).trim() || undefined;
}

export function sqlSemanticSelectStarIsOnlyProjection(model: SqlSemanticModel): boolean {
  const star = selectStarToken(model);
  if (!star) return false;
  let selectIndex = -1;
  for (let index = model.tokens.length - 1; index >= 0; index -= 1) {
    const token = model.tokens[index];
    if (!token || token.span.end > star.span.start || token.depth !== star.depth) continue;
    if (token.kind === "word" && token.normalized === "select") {
      selectIndex = index;
      break;
    }
  }
  if (selectIndex < 0) return false;
  const fromIndex = model.tokens.findIndex((token, index) => index > selectIndex && token.span.start >= star.span.end && token.depth === star.depth && token.kind === "word" && token.normalized === "from");
  const projectionEnd = fromIndex >= 0 ? model.tokens[fromIndex]!.span.start : model.statement.span.end;
  const projectionTokens = model.tokens.filter((token) => token.span.start >= model.tokens[selectIndex]!.span.end && token.span.end <= projectionEnd && token.kind !== "comment");
  if (projectionTokens[0]?.kind === "word" && (projectionTokens[0].normalized === "all" || projectionTokens[0].normalized === "distinct")) projectionTokens.shift();
  if (projectionTokens.pop() !== star) return false;
  if (projectionTokens.length === 0) return true;
  return projectionTokens.length % 2 === 0 && projectionTokens.every((token, index) => (index % 2 === 0 ? isSemanticIdentifier(token) : token.text === "."));
}

export function sqlSemanticReferencedTables(model: SqlSemanticModel): SqlCompletionReferencedTable[] {
  return model.rowSources
    .filter((source) => source.kind !== "unknown")
    .map((source) => {
      const identifierParts = source.qualifiedName?.parts ?? [];
      return {
        name: source.name,
        nameQuoted: !!identifierParts[identifierParts.length - 1]?.quote,
        database: source.metadataTarget?.database,
        schema: source.qualifierParts[source.qualifierParts.length - 1],
        schemaQuoted: source.qualifierParts.length > 0 ? !!identifierParts[identifierParts.length - 2]?.quote : undefined,
        alias: source.alias,
        aliasSql: source.aliasSpan ? model.sql.slice(source.aliasSpan.start, source.aliasSpan.end) : source.alias,
        columns: source.columns,
        columnAliases: source.columnAliases,
      };
    });
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
  const contextKind = semanticContextKind(model);
  const basePrefixHasNonAscii = Array.from(base.prefix).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
  const useBaseTrailingIdentifier = basePrefixHasNonAscii && model.cursorIntent.prefix.length === 0 && model.cursorIntent.replacementRange.start === model.cursorIntent.replacementRange.end && base.contextKind === contextKind;
  const prefix = useBaseTrailingIdentifier ? base.prefix : model.cursorIntent.prefix;
  const qualifierParts = model.cursorIntent.qualifierParts.length > 0 ? [...model.cursorIntent.qualifierParts] : useBaseTrailingIdentifier ? base.qualifierParts : undefined;
  const qualifier = qualifierParts?.join(".");
  const referencedTables = sqlSemanticReferencedTables(model);
  const mutationTarget = semanticMutationTarget(model);
  const mutationDatabase = mutationTarget?.metadataTarget?.database;
  const mutationSchema = mutationTarget?.qualifierParts[mutationTarget.qualifierParts.length - 1];
  const suggestTables = scope.kind === "table" || scope.kind === "schema" || scope.kind === "catalog";
  const suggestColumns = scope.kind === "columns";
  const suggestRoutines = scope.kind === "routine" || (suggestColumns && base.suggestRoutines && !base.exclusiveColumnSuggestions);
  const projectionAliases = sqlSemanticProjectionAliasColumns(model).map((column) => column.name);

  return {
    ...base,
    prefix,
    qualifier,
    qualifierParts,
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
    insertDatabase: model.cursorIntent.kind === "insert_column" ? mutationDatabase : base.insertDatabase,
    insertSchema: model.cursorIntent.kind === "insert_column" ? mutationSchema : base.insertSchema,
    updateTarget: model.cursorIntent.kind === "update_column" && mutationTarget ? { table: mutationTarget.name, schema: mutationSchema } : base.updateTarget,
    deleteTarget: model.cursorIntent.kind === "delete_target" && mutationTarget ? { table: mutationTarget.name, schema: mutationSchema } : base.deleteTarget,
    onStar: model.cursorIntent.kind === "star" || base.onStar,
    contextKind,
  };
}
