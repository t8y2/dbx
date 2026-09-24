import { onBeforeUnmount, type ShallowRef, type ComputedRef } from "vue";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { QueryEditorProps, CompletionMetadataScope } from "./queryEditorTypes";
import * as api from "@/lib/backend/api";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";

import type { EditorView as EditorViewType } from "@codemirror/view";
import { type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeCacheForDoc, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { mergeSqlSemanticReferenceAnalysis } from "@/lib/sql/semantic/references";
import { sqlServerUseDatabaseBeforeCursor } from "@/lib/sql/sqlCompletionLookupTarget";
import { lineColumnToOffset, sqlErrorDecorationRange as resolveSqlErrorDecorationRange, sqlErrorSqlMatchesEditor } from "@/lib/sql/sqlDiagnostics";
import { analyzeMysqlRoutineSyntax, supportsMysqlRoutineSyntaxDiagnostics } from "@/lib/sql/mysqlRoutineSyntaxDiagnostics";
import { buildOracleSyntaxDiagnostics } from "@/lib/sql/oracleSyntaxDiagnostics";
import { buildSqlServerRoutineSyntaxDiagnostics } from "@/lib/sql/sqlServerRoutineSyntaxDiagnostics";
import { needsDiagnosticCaretReanchor } from "@/lib/editor/queryEditorDiagnosticCaretAnchor";
import { metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import {
  areSqlSemanticDiagnosticsEqual,
  buildSqlParserErrorDiagnostic,
  buildSqlSemanticDiagnostics,
  isSqlSemanticDiagnosticInputContext,
  isSqlVirtualTableReference,
  shouldRunSqlSemanticDiagnostics,
  sqlSemanticDiagnosticRangesForViewport,
  sqlServerRoutineDefinitionRangesForViewport,
  tableReferenceKey,
  type SqlSemanticDiagnostic,
} from "@/lib/sql/semantic/diagnostics";
import { sqlReferenceAnalysisDialectFor } from "@/lib/sql/semantic/dialect";
import { buildRedisSyntaxDiagnostics, shouldRunRedisDiagnostics } from "@/lib/redis/redisSyntaxDiagnostics";
import { buildMongoSyntaxDiagnostics } from "@/lib/mongo/mongoSyntaxDiagnostics";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

interface QueryEditorDiagnosticsRuntime {
  setSqlDiagnosticsEffect: import("@codemirror/state").StateEffectType<SqlSemanticDiagnostic[]> | null;
  diagnosticComp: import("@codemirror/state").Compartment | null;
  buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null;
  codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null;
  executableStatementRangeCache: ExecutableStatementRangeCache | null;
  editorIsActive: boolean;
}

interface QueryEditorDiagnosticMetadata {
  readonly cachedTables: SqlCompletionTable[];
  cachedColumnsByTable: Map<string, SqlCompletionColumn[]>;
  loadedColumnsByTable: Set<string>;
  usesOracleSessionCompletionColumns: (schema?: string | null) => boolean;
  findExactSemanticDiagnosticTable: (table: SqlTableReference, scope?: CompletionMetadataScope) => Promise<SqlCompletionTable | null>;
  completionCacheKey: (table: SqlTableReference, scope?: CompletionMetadataScope) => string;
  ensureColumnsForTable: (table: SqlTableReference, reference: undefined, scope?: CompletionMetadataScope) => Promise<boolean>;
  isMissingTableMetadataError: (error: unknown) => boolean;
}

interface QueryEditorDiagnosticsOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  sqlDriverProfile: ComputedRef<string | undefined>;
  sqlStatementParameterOptions: () => SqlParameterOptions;
  sqlBehaviorDialect: () => QueryEditorProps["dialect"];
  semanticCompletionEnabled: boolean;
  maxCompletionTables: number;
  runtime: QueryEditorDiagnosticsRuntime;
  metadata: QueryEditorDiagnosticMetadata;
}

export function useQueryEditorDiagnostics(options: QueryEditorDiagnosticsOptions) {
  const { props, view, settingsStore, connectionStore, sqlDriverProfile, sqlStatementParameterOptions, sqlBehaviorDialect, runtime, metadata } = options;
  const SEMANTIC_SQL_COMPLETION_ENABLED = options.semanticCompletionEnabled;
  const MAX_COMPLETION_TABLES = options.maxCompletionTables;
  const MAX_SEMANTIC_DIAGNOSTIC_COLUMN_TABLES = 4;
  let semanticDiagnostics: SqlSemanticDiagnostic[] = [];
  let semanticDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let semanticDiagnosticRunId = 0;
  let pendingSemanticDiagnosticPreserveOutsideRanges = false;

  function sqlErrorDecorationRange(currentState: import("@codemirror/state").EditorState) {
    if (!props.executionError) return [];
    if (!props.executionErrorSql || !sqlErrorSqlMatchesEditor(currentState.doc.toString(), props.executionErrorSql)) return [];
    const range = resolveSqlErrorDecorationRange(currentState.doc.toString(), props.executionError);
    if (!range) return [];
    return [
      {
        ...range,
        message: props.executionError,
      },
    ];
  }

  function sqlTextSpanToRange(sql: string, span: SqlTextSpan): { from: number; to: number } | null {
    if (!span.start_line || !span.start_column) return null;
    const from = lineColumnToOffset(sql, {
      line: span.start_line - 1,
      column: span.start_column - 1,
    });
    const to = lineColumnToOffset(sql, {
      line: Math.max(span.end_line - 1, span.start_line - 1),
      column: Math.max(span.end_column, span.start_column),
    });
    if (from == null || to == null || to <= from) return null;
    return { from, to };
  }

  function sqlSemanticDecorationRanges(currentState: import("@codemirror/state").EditorState) {
    const sql = currentState.doc.toString();
    return semanticDiagnostics
      .map((diagnostic) => {
        const range = sqlTextSpanToRange(sql, diagnostic.span);
        return range
          ? {
              ...range,
              message: diagnostic.message,
              severity: diagnostic.severity,
            }
          : null;
      })
      .filter(
        (
          range,
        ): range is {
          from: number;
          to: number;
          message: string;
          severity: "error" | "warning";
        } => !!range,
      );
  }

  // Mirrors CodeMirror's own root handling: shadow roots only expose
  // `getSelection` on some browsers, otherwise the owner document holds it.
  function editorRootSelection(currentView: EditorViewType): Selection | null {
    const root = currentView.root as unknown as ShadowRoot & { getSelection?: () => Selection | null };
    if (root.nodeType !== 11) return (root as unknown as Document).getSelection();
    if (typeof root.getSelection === "function") return root.getSelection() ?? null;
    return root.ownerDocument?.getSelection() ?? null;
  }

  // See queryEditorDiagnosticCaretAnchor.ts for why the browser caret needs re-anchoring.
  function reanchorCaretAfterDiagnostics(currentView: EditorViewType) {
    const selection = currentView.state.selection;
    const target = selection.ranges.length === 1 && selection.main.empty ? currentView.domAtPos(selection.main.head) : null;
    const domSelection = editorRootSelection(currentView);
    const reanchor = needsDiagnosticCaretReanchor({
      hasFocus: currentView.hasFocus,
      composing: currentView.composing,
      domRangeCount: domSelection?.rangeCount ?? 0,
      currentAnchorNode: domSelection?.anchorNode ?? null,
      currentAnchorOffset: domSelection?.anchorOffset ?? 0,
      targetNode: target?.node ?? null,
      targetOffset: target?.offset ?? 0,
    });
    if (!reanchor || !domSelection || !target) return;
    domSelection.collapse(target.node, target.offset);
  }

  function reconfigureDiagnostics() {
    const currentView = view.value;
    if (!currentView) return;
    if (runtime.setSqlDiagnosticsEffect) {
      currentView.dispatch({
        effects: runtime.setSqlDiagnosticsEffect.of(semanticDiagnostics),
      });
    } else {
      if (!runtime.diagnosticComp || !runtime.buildSqlDiagnosticExtension) return;
      currentView.dispatch({
        effects: runtime.diagnosticComp.reconfigure(runtime.buildSqlDiagnosticExtension()),
      });
    }
    // Diagnostic decorations re-parent the DOM text nodes around the caret; put the
    // browser's insertion point back on the caret before the next keystroke (#9480).
    reanchorCaretAfterDiagnostics(currentView);
  }

  function setSemanticDiagnostics(next: SqlSemanticDiagnostic[]) {
    if (areSqlSemanticDiagnosticsEqual(semanticDiagnostics, next)) return;
    semanticDiagnostics = next;
    reconfigureDiagnostics();
  }

  function clearScheduledSemanticDiagnostics() {
    semanticDiagnosticRunId++;
    if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
    semanticDiagnosticTimer = null;
    pendingSemanticDiagnosticPreserveOutsideRanges = false;
  }

  function invalidateSemanticDiagnosticsForDocumentChange() {
    semanticDiagnosticRunId++;
    semanticDiagnostics = [];
  }

  function shouldSkipSqlSemanticDiagnostics() {
    return props.databaseType === "victoriametrics" || (props.databaseType !== "redis" && props.databaseType !== "mongodb" && !settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled);
  }

  function rangesOverlap(left: { from: number; to: number }, right: { from: number; to: number }): boolean {
    return left.from < right.to && right.from < left.to;
  }

  function sqlLineColumnAtOffset(sql: string, offset: number): { line: number; column: number } {
    const safeOffset = Math.max(0, Math.min(offset, sql.length));
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < safeOffset; index += 1) {
      if (sql[index] === "\n") {
        line += 1;
        lineStart = index + 1;
      }
    }
    return { line, column: safeOffset - lineStart + 1 };
  }

  function offsetSqlTextSpan(span: SqlTextSpan, rangeStart: { line: number; column: number }): SqlTextSpan {
    const offsetLine = (line: number) => rangeStart.line + line - 1;
    const offsetColumn = (line: number, column: number) => (line === 1 ? rangeStart.column + column - 1 : column);
    return {
      start_line: offsetLine(span.start_line),
      start_column: offsetColumn(span.start_line, span.start_column),
      end_line: offsetLine(span.end_line),
      end_column: offsetColumn(span.end_line, span.end_column),
    };
  }

  function offsetSqlSemanticDiagnostics(diagnostics: readonly SqlSemanticDiagnostic[], range: SqlTextRange, fullSql: string): SqlSemanticDiagnostic[] {
    const rangeStart = sqlLineColumnAtOffset(fullSql, range.from);
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      span: offsetSqlTextSpan(diagnostic.span, rangeStart),
    }));
  }

  function replaceSemanticDiagnosticsInRanges(next: SqlSemanticDiagnostic[], ranges: readonly SqlTextRange[], fullSql: string) {
    const retained = semanticDiagnostics.filter((diagnostic) => {
      const diagnosticRange = sqlTextSpanToRange(fullSql, diagnostic.span);
      return !diagnosticRange || !ranges.some((range) => rangesOverlap(diagnosticRange, range));
    });
    setSemanticDiagnostics([...retained, ...next].sort(compareSqlSemanticDiagnostics));
  }

  function compareSqlSemanticDiagnostics(left: SqlSemanticDiagnostic, right: SqlSemanticDiagnostic): number {
    return left.span.start_line - right.span.start_line || left.span.start_column - right.span.start_column || left.span.end_line - right.span.end_line || left.span.end_column - right.span.end_column || left.message.localeCompare(right.message);
  }

  function semanticDiagnosticMetadataScope(sql: string, range: SqlTextRange): CompletionMetadataScope {
    const selectedDatabase = props.database!;
    const parsedDatabase = props.databaseType === "sqlserver" ? sqlServerUseDatabaseBeforeCursor(sql, range.from) : undefined;
    if (!parsedDatabase || !props.connectionId) return { database: selectedDatabase, schema: props.schema };
    const database = connectionStore.lookupLocalCompletionDatabases(props.connectionId, parsedDatabase, MAX_COMPLETION_TABLES).find((candidate) => candidate.toLowerCase() === parsedDatabase.toLowerCase()) ?? parsedDatabase;
    return {
      database,
      schema: metadataSchemaForConnection(connectionStore.getConfig(props.connectionId), database, undefined),
    };
  }

  function semanticDiagnosticTablesForScope(tables: SqlTableReference[], scope: CompletionMetadataScope): SqlTableReference[] {
    if (props.databaseType !== "sqlserver" || scope.database === props.database) return tables;
    return tables.map((table) => (table.database ? table : { ...table, database: scope.database, schema: table.schema ?? scope.schema }));
  }

  async function enrichSemanticDiagnosticTables(tables: SqlTableReference[], scope?: CompletionMetadataScope): Promise<{ tables: SqlTableReference[]; missingTables: Set<string> }> {
    if (!props.connectionId || props.database == null) return { tables, missingTables: new Set() };

    const enriched: SqlTableReference[] = [];
    const missingTables = new Set<string>();
    for (const table of tables) {
      if (isStatementLocalSemanticTable(table) || isSqlVirtualTableReference(table, props.databaseType)) {
        enriched.push(table);
        continue;
      }
      if (metadata.usesOracleSessionCompletionColumns(table.schema)) {
        enriched.push(table);
        continue;
      }
      try {
        const match = await metadata.findExactSemanticDiagnosticTable(table, scope);
        if (!match) missingTables.add(tableReferenceKey(table));
        enriched.push(match?.schema ? { ...table, schema: match.schema } : table);
      } catch {
        enriched.push(table);
      }
    }
    return { tables: enriched, missingTables };
  }

  async function ensureColumnsForSemanticDiagnostics(tables: SqlTableReference[], scope?: CompletionMetadataScope): Promise<Set<string>> {
    const missingTables = new Set<string>();
    const seen = new Set<string>();
    const targets: SqlTableReference[] = [];
    for (const table of tables) {
      if (isStatementLocalSemanticTable(table) || isSqlVirtualTableReference(table, props.databaseType)) continue;
      const tableWithInlineColumns = table as SqlTableReference & {
        columns?: string[];
      };
      if (tableWithInlineColumns.columns && tableWithInlineColumns.columns.length > 0) continue;
      const cacheKey = metadata.completionCacheKey(table, scope);
      if (metadata.cachedColumnsByTable.has(cacheKey)) continue;
      const normalizedKey = cacheKey.toLowerCase();
      if (seen.has(normalizedKey)) continue;
      seen.add(normalizedKey);
      targets.push(table);
      if (targets.length >= MAX_SEMANTIC_DIAGNOSTIC_COLUMN_TABLES) break;
    }
    await Promise.all(
      targets.map(async (table) => {
        try {
          await metadata.ensureColumnsForTable(table, undefined, scope);
        } catch (error) {
          if (metadata.isMissingTableMetadataError(error)) {
            missingTables.add(tableReferenceKey(table));
          }
        }
      }),
    );
    return missingTables;
  }

  function isStatementLocalSemanticTable(table: SqlTableReference): boolean {
    const kind = (table as SqlTableReference & { semanticSourceKind?: string }).semanticSourceKind;
    return kind === "cte" || kind === "subquery" || kind === "table_function";
  }

  async function refreshSemanticDiagnostics(options: { preserveOutsideRanges?: boolean } = {}) {
    const currentView = view.value;
    const runId = ++semanticDiagnosticRunId;
    if (!currentView || !props.connectionId || props.database == null) {
      setSemanticDiagnostics([]);
      return;
    }

    const sql = currentView.state.doc.toString();
    if (!sql.trim()) {
      setSemanticDiagnostics([]);
      return;
    }
    if (props.databaseType === "elasticsearch" || props.databaseType === "easysearch" || props.databaseType === "meilisearch" || props.databaseType === "solr" || props.databaseType === "victoriametrics") {
      setSemanticDiagnostics([]);
      return;
    }
    if (props.databaseType === "mongodb") {
      // Shell commands have no SQL semantics; surface the parser's own diagnosis instead of waiting for Run.
      const cursor = currentView.state.selection.main.head;
      setSemanticDiagnostics(buildMongoSyntaxDiagnostics(sql, cursor));
      return;
    }
    if (props.databaseType === "redis") {
      // Redis has no SQL semantics; run command-name / arity / quote / danger checks instead.
      if (!shouldRunRedisDiagnostics(sql, currentView.state.selection.main.head)) {
        scheduleSemanticDiagnostics(900, {
          preserveOutsideRanges: options.preserveOutsideRanges,
        });
        return;
      }
      setSemanticDiagnostics(buildRedisSyntaxDiagnostics(sql));
      return;
    }
    if (shouldSkipSqlSemanticDiagnostics()) {
      setSemanticDiagnostics([]);
      return;
    }
    if (!shouldRunSqlSemanticDiagnostics(sql, currentView.state.selection.main.head, { databaseType: props.databaseType })) {
      scheduleSemanticDiagnostics(1200, {
        preserveOutsideRanges: options.preserveOutsideRanges,
      });
      return;
    }
    if (runtime.codeMirrorCompletionStatus?.(currentView.state) && isSqlSemanticDiagnosticInputContext(sql, currentView.state.selection.main.head, { databaseType: props.databaseType })) {
      scheduleSemanticDiagnostics(900, {
        preserveOutsideRanges: options.preserveOutsideRanges,
      });
      return;
    }

    const visibleRanges = currentView.visibleRanges.length > 0 ? currentView.visibleRanges : [currentView.viewport];
    if (props.databaseType !== "sqlserver") {
      runtime.executableStatementRangeCache = executableStatementRangeCacheForDoc(runtime.executableStatementRangeCache, currentView.state.doc, props.databaseType, sqlStatementParameterOptions());
    }
    const diagnosticRanges = sqlSemanticDiagnosticRangesForViewport(sql, visibleRanges, props.databaseType, props.databaseType === "sqlserver" ? undefined : runtime.executableStatementRangeCache?.ranges, sqlStatementParameterOptions());
    // SQL Server routine batches are excluded from `diagnosticRanges` (see
    // `sqlServerRoutineDefinitionRangesForViewport`), so they are recomputed here
    // and stay part of the replaced range set below.
    const sqlServerRoutineRanges = props.databaseType === "sqlserver" ? sqlServerRoutineDefinitionRangesForViewport(sql, visibleRanges) : [];
    if (diagnosticRanges.length === 0 && sqlServerRoutineRanges.length === 0) {
      if (!options.preserveOutsideRanges) setSemanticDiagnostics([]);
      return;
    }

    const nextDiagnostics: SqlSemanticDiagnostic[] = [];
    const oracleSyntaxDiagnostics = buildOracleSyntaxDiagnostics(sql, props.databaseType);
    nextDiagnostics.push(
      ...oracleSyntaxDiagnostics.filter((diagnostic) => {
        const diagnosticRange = sqlTextSpanToRange(sql, diagnostic.span);
        return !!diagnosticRange && diagnosticRanges.some((range) => rangesOverlap(diagnosticRange, range));
      }),
    );
    // The analyzer never sees routine batches (the MsSql grammar cannot parse their
    // parameter list), so run the token-based routine syntax rules instead of leaving
    // a stored procedure without any check at all (dbx#9315).
    for (const range of sqlServerRoutineRanges) {
      nextDiagnostics.push(...offsetSqlSemanticDiagnostics(buildSqlServerRoutineSyntaxDiagnostics(range.sql, props.databaseType), range, sql));
    }
    const mysqlRoutineAnalysis = props.databaseType === "mysql" && supportsMysqlRoutineSyntaxDiagnostics(sqlDriverProfile.value) ? analyzeMysqlRoutineSyntax(sql) : null;
    if (mysqlRoutineAnalysis) {
      nextDiagnostics.push(
        ...mysqlRoutineAnalysis.diagnostics.filter((diagnostic) => {
          const diagnosticRange = sqlTextSpanToRange(sql, diagnostic.span);
          return !!diagnosticRange && diagnosticRanges.some((range) => rangesOverlap(diagnosticRange, range));
        }),
      );
    }
    for (const range of diagnosticRanges) {
      if (mysqlRoutineAnalysis?.routineRanges.some((routineRange) => rangesOverlap(routineRange, range))) continue;
      try {
        const analysis = await api.analyzeSqlReferences(
          range.sql,
          sqlReferenceAnalysisDialectFor({
            databaseType: props.databaseType,
            identifierQuote: connectionStore.connectionIdentifierQuote(props.connectionId),
            fallbackDialect: props.formatDialect ?? props.dialect ?? "generic",
          }),
        );
        if (runId !== semanticDiagnosticRunId) return;

        const semanticCursor = Math.max(0, Math.min(currentView.state.selection.main.head - range.from, range.sql.length));
        const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED
          ? buildSqlSemanticModel(range.sql, semanticCursor, {
              databaseType: props.databaseType,
              dialect: sqlBehaviorDialect(),
            })
          : null;
        const semanticAnalysis = semanticModel ? mergeSqlSemanticReferenceAnalysis(analysis, semanticModel) : analysis;
        const metadataScope = semanticDiagnosticMetadataScope(sql, range);
        const scopedAnalysis = {
          ...semanticAnalysis,
          tables: semanticDiagnosticTablesForScope(semanticAnalysis.tables, metadataScope),
        };
        const { tables, missingTables } = await enrichSemanticDiagnosticTables(scopedAnalysis.tables, metadataScope);
        const columnMetadataMissingTables = await ensureColumnsForSemanticDiagnostics(tables, metadataScope);
        for (const tableKey of columnMetadataMissingTables) missingTables.add(tableKey);
        if (runId !== semanticDiagnosticRunId) return;

        const enrichedAnalysis: SqlReferenceAnalysis = {
          ...scopedAnalysis,
          tables,
        };
        nextDiagnostics.push(
          ...offsetSqlSemanticDiagnostics(
            buildSqlSemanticDiagnostics(enrichedAnalysis, {
              tables: metadata.cachedTables,
              columnsByTable: metadata.cachedColumnsByTable,
              missingTables,
              loadedColumnTables: metadata.loadedColumnsByTable,
              sql: range.sql,
              databaseType: props.databaseType,
            }),
            range,
            sql,
          ),
        );
      } catch (error) {
        if (runId !== semanticDiagnosticRunId) return;
        const diagnostic = buildSqlParserErrorDiagnostic(error, range.sql);
        if (diagnostic) nextDiagnostics.push(...offsetSqlSemanticDiagnostics([diagnostic], range, sql));
      }
    }
    if (options.preserveOutsideRanges) {
      replaceSemanticDiagnosticsInRanges(nextDiagnostics, [...diagnosticRanges, ...sqlServerRoutineRanges], sql);
    } else {
      setSemanticDiagnostics(nextDiagnostics.sort(compareSqlSemanticDiagnostics));
    }
  }

  function scheduleSemanticDiagnostics(delay = 500, options: { preserveOutsideRanges?: boolean } = {}) {
    if (!runtime.editorIsActive) return;
    if (shouldSkipSqlSemanticDiagnostics()) {
      clearScheduledSemanticDiagnostics();
      setSemanticDiagnostics([]);
      return;
    }
    pendingSemanticDiagnosticPreserveOutsideRanges = !!options.preserveOutsideRanges;
    if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
    semanticDiagnosticTimer = setTimeout(() => {
      const preserveOutsideRanges = pendingSemanticDiagnosticPreserveOutsideRanges;
      pendingSemanticDiagnosticPreserveOutsideRanges = false;
      semanticDiagnosticTimer = null;
      void refreshSemanticDiagnostics({ preserveOutsideRanges });
    }, delay);
  }

  onBeforeUnmount(clearScheduledSemanticDiagnostics);

  return {
    sqlErrorDecorationRange,
    sqlSemanticDecorationRanges,
    reconfigureDiagnostics,
    setSemanticDiagnostics,
    clearScheduledSemanticDiagnostics,
    invalidateSemanticDiagnosticsForDocumentChange,
    shouldSkipSqlSemanticDiagnostics,
    scheduleSemanticDiagnostics,
    get diagnostics() {
      return semanticDiagnostics;
    },
  };
}
