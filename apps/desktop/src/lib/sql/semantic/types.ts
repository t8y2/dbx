import type { EditorState } from "@codemirror/state";
import type { DatabaseType } from "@/types/database";

export interface SqlSemanticSpan {
  start: number;
  end: number;
}

export type SqlSemanticConfidence = "high" | "medium" | "low";

export type SqlSemanticStatementKind = "select" | "insert" | "update" | "delete" | "call" | "unknown";

export type SqlSemanticTokenKind = "word" | "quoted_identifier" | "string" | "number" | "comment" | "parameter" | "punctuation" | "operator";

export interface SqlSemanticToken {
  kind: SqlSemanticTokenKind;
  text: string;
  normalized: string;
  span: SqlSemanticSpan;
  depth: number;
  quote?: string;
  closed?: boolean;
}

export interface SqlSemanticIdentifierPart {
  raw: string;
  name: string;
  span: SqlSemanticSpan;
  quote?: string;
}

export interface SqlSemanticQualifiedName {
  parts: SqlSemanticIdentifierPart[];
  span: SqlSemanticSpan;
}

export type SqlSemanticRowSourceKind = "table" | "cte" | "subquery" | "table_function" | "mutation_target" | "unknown";

export interface SqlSemanticMetadataTarget {
  database?: string;
  schema?: string;
  table?: string;
  packageName?: string;
}

export interface SqlSemanticProjection {
  name: string;
  sourceExpression: string;
  span: SqlSemanticSpan;
  alias?: string;
  aliasSpan?: SqlSemanticSpan;
}

/**
 * Traceable origin of a CTE output column that is a plain column reference
 * (`col` or `q.col`) in the CTE body. Expression/alias outputs carry no origin.
 */
export interface SqlSemanticCteColumnOrigin {
  /** Qualifier chain before the column, e.g. `t` for `t.id`; empty for a bare `id`. */
  qualifierParts: string[];
  /** Referenced column name inside the CTE body. */
  column: string;
}

/** A named column produced by a CTE (`WITH c(a,b)` list item or SELECT projection). */
export interface SqlSemanticCteOutputColumn {
  /** Output column name as seen by the outer query. */
  name: string;
  /** Editor span to select when navigating to this output column inside the CTE body. */
  jumpSpan: SqlSemanticSpan;
  /** Present only when the body projection is a traceable plain column reference. */
  origin?: SqlSemanticCteColumnOrigin;
}

/** A star projection (`*` or `q.*`) inside a CTE body. */
export interface SqlSemanticCteStar {
  /** Span of the `*` token itself (navigation target). */
  starSpan: SqlSemanticSpan;
  /** Qualifier chain for `q.*`; empty for a bare `*`. */
  qualifierParts: string[];
}

export interface SqlSemanticRowSource {
  id: string;
  kind: SqlSemanticRowSourceKind;
  name: string;
  qualifiedName?: SqlSemanticQualifiedName;
  qualifierParts: string[];
  alias?: string;
  aliasSpan?: SqlSemanticSpan;
  sourceSpan: SqlSemanticSpan;
  columns?: string[];
  columnAliases?: string[];
  metadataTarget?: SqlSemanticMetadataTarget;
  unresolved?: boolean;
  /** CTE name token span — only populated on `cte:` definition row sources. */
  nameSpan?: SqlSemanticSpan;
  /** CTE body parentheses span — only populated on `cte:` definition row sources. */
  bodySpan?: SqlSemanticSpan;
  /**
   * Named output columns with in-body navigation/trace metadata. Populated on `cte:` definitions,
   * and — reusing the same shape — on derived tables (`kind: "subquery"`) directly inside a CTE
   * body, so lineage can continue through `FROM (SELECT ...) x` to the tables inside it.
   */
  cteOutputs?: SqlSemanticCteOutputColumn[];
  /** Star projections of the body (CTE definitions and enriched derived tables). */
  cteStars?: SqlSemanticCteStar[];
  /** Row sources visible inside the body (physical tables + upstream CTEs) — same two owners. */
  bodySources?: SqlSemanticRowSource[];
}

export interface SqlSemanticClauseSpans {
  select?: SqlSemanticSpan;
  from?: SqlSemanticSpan;
  where?: SqlSemanticSpan;
  groupBy?: SqlSemanticSpan;
  having?: SqlSemanticSpan;
  orderBy?: SqlSemanticSpan;
  limit?: SqlSemanticSpan;
  insertColumns?: SqlSemanticSpan;
  updateSet?: SqlSemanticSpan;
}

export interface SqlSemanticScope {
  id: string;
  kind: SqlSemanticStatementKind | "subquery" | "cte";
  span: SqlSemanticSpan;
  parentId?: string;
  rowSources: SqlSemanticRowSource[];
  projections: SqlSemanticProjection[];
  clauseSpans: SqlSemanticClauseSpans;
}

export type SqlSemanticCursorKind = "table" | "schema" | "catalog" | "routine" | "column" | "alias_column" | "insert_column" | "update_column" | "delete_target" | "join_condition" | "star" | "keyword" | "suppressed";

export interface SqlSemanticCursorIntent {
  kind: SqlSemanticCursorKind;
  prefix: string;
  replacementRange: SqlSemanticSpan;
  qualifierParts: string[];
  targetSourceId?: string;
  expectedObjectKinds: Array<"database" | "schema" | "table" | "view" | "routine" | "procedure" | "function" | "column">;
  confidence: SqlSemanticConfidence;
  fallbackReason?: string;
}

export interface SqlSemanticStatement {
  kind: SqlSemanticStatementKind;
  span: SqlSemanticSpan;
  text: string;
}

export interface SqlSemanticDiagnostic {
  message: string;
  span: SqlSemanticSpan;
  severity: "info" | "warning" | "error";
}

export interface SqlSemanticModel {
  databaseType?: DatabaseType;
  dialectId: string;
  sql: string;
  cursor: number;
  statement: SqlSemanticStatement;
  tokens: SqlSemanticToken[];
  scopes: SqlSemanticScope[];
  rowSources: SqlSemanticRowSource[];
  projections: SqlSemanticProjection[];
  cursorIntent: SqlSemanticCursorIntent;
  diagnostics: SqlSemanticDiagnostic[];
}

export interface SqlSemanticBuildOptions {
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver" | "clickhouse" | "doris";
  /**
   * Live CodeMirror state for the document being edited, when the caller has one (i.e. this is a
   * real editor completion request, not a pure-string test/utility call). When present and its
   * doc length matches the `sql` string being scanned, boundary-sensitive lookups prefer resolving
   * against its already-incrementally-parsed syntax tree (see sqlSyntaxTreeWindow.ts) instead of
   * the bounded heuristic scanner in insertValueHints.ts, which remains the fallback.
   */
  editorState?: EditorState;
}
