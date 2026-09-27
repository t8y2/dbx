import type { EditorView as EditorViewType } from "@codemirror/view";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { applyDdlDatabaseQualifier, omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { findCteColumnResolution, resolveCteColumnOrigins, type CteColumnOrigin } from "@/lib/sql/semantic/cteNavigation";
import type { SqlSemanticModel, SqlSemanticRowSource } from "@/lib/sql/semantic/types";
import { resolveSqlSemanticNavigationTarget } from "@/lib/sql/semantic/references";
import { extractQualifiedIdentifierAt, isSqlKeyword, splitQualifiedIdentifier, sqlObjectHoverDetail, sqlObjectNavigationSourceKind } from "@/lib/sql/sqlNavigation";
import { buildHoverTableSql, ddlForHoverPreview, hoverTableMatchesScope, quoteIdentifier, quoteQualifiedName, reformatHoverDdl, scopeHoverTables, type HoverTableScope } from "@/lib/editor/hoverTableSql";
import { matchHoverTableCandidates, resolveHoverTableLookupTarget } from "@/lib/editor/hoverTableLookup";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { applyDdlStoragePreference } from "@/lib/sql/ddlStorage";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import * as api from "@/lib/backend/api";
import type { SqlCompletionColumn } from "@/lib/sql/sqlCompletion";
import type { ColumnInfo, IndexInfo } from "@/types/database";
import type { Ref } from "vue";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { useQueryEditorCompletionMetadata } from "./useQueryEditorCompletionMetadata";
import type { createQueryEditorHoverContent } from "./queryEditorHoverContent";

interface QueryEditorHoverOptions {
  props: Readonly<QueryEditorProps>;
  contextMenuOpen: Readonly<Ref<boolean>>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  metadata: ReturnType<typeof useQueryEditorCompletionMetadata>;
  createHoverDom: ReturnType<typeof createQueryEditorHoverContent>["createHoverDom"];
  semanticCompletionEnabled: boolean;
  maxCompletionTables: number;
}

export function useQueryEditorHover(options: QueryEditorHoverOptions) {
  const { props, contextMenuOpen, settingsStore, connectionStore, metadata: completionMetadata, createHoverDom } = options;
  const { ensureColumnsForTable, cachedColumnsByTable, completionCacheKey, getEditorSemanticModel, completionMetadataTarget, mergeCompletionTables, usesLocalOnlyCompletionMetadata, getEditorSqlCompletionContext } = completionMetadata;
  const SEMANTIC_SQL_COMPLETION_ENABLED = options.semanticCompletionEnabled;
  const MAX_COMPLETION_TABLES = options.maxCompletionTables;
  function identifierRangeAt(sql: string, pos: number): { from: number; to: number; text: string } | null {
    const located = extractQualifiedIdentifierAt(sql, pos);
    if (!located) return null;
    if (located.parts.length === 1 && !located.parts[0].quoted && isSqlKeyword(located.parts[0].value)) return null;
    const text = located.parts.map((part) => quoteIdentifier(part.value)).join(".");
    if (!text) return null;
    return { from: located.start, to: located.end, text };
  }

  function referencedTableLikeFromSemanticSource(source: SqlSemanticRowSource) {
    const identifierParts = source.qualifiedName?.parts ?? [];
    return {
      name: source.name,
      nameQuoted: !!identifierParts[identifierParts.length - 1]?.quote,
      database: source.metadataTarget?.database,
      schema: source.qualifierParts[source.qualifierParts.length - 1],
      schemaQuoted: source.qualifierParts.length > 0 ? !!identifierParts[identifierParts.length - 2]?.quote : undefined,
    };
  }

  async function resolveCteColumnHoverColumn(semanticModel: SqlSemanticModel, columnName: string, qualifier?: string): Promise<SqlCompletionColumn | null> {
    try {
      const hit = findCteColumnResolution(semanticModel, columnName, qualifier);
      if (!hit) return null;
      const origins: CteColumnOrigin[] = resolveCteColumnOrigins(semanticModel, hit, columnName);
      if (origins.length === 0) return null;
      // Fetch all candidate origins concurrently (same pattern as expandSelectStar);
      // origin order still decides which match wins.
      const matched = await Promise.all(
        origins.map(async (origin) => {
          const reference = referencedTableLikeFromSemanticSource(origin.source);
          await ensureColumnsForTable(reference, reference);
          const columns = cachedColumnsByTable.get(completionCacheKey(reference));
          return columns?.find((candidate) => candidate.name.toLowerCase() === origin.column.toLowerCase()) ?? null;
        }),
      );
      return matched.find((column) => column != null) ?? null;
    } catch {
      return null;
    }
  }

  async function resolveSqlHoverTooltip(currentView: EditorViewType, pos: number) {
    if (!props.connectionId || props.database == null || contextMenuOpen.value) return null;

    const sql = currentView.state.doc.toString();
    const range = identifierRangeAt(sql, pos);
    if (!range) return null;

    const identifier = range.text;
    const parts = splitQualifiedIdentifier(identifier);
    const name = parts[parts.length - 1] ?? identifier;
    const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;
    let semanticModel: ReturnType<typeof buildSqlSemanticModel> | null = null;
    if (SEMANTIC_SQL_COMPLETION_ENABLED) {
      try {
        semanticModel = getEditorSemanticModel(sql, pos, currentView.state);
      } catch (error) {
        semanticModel = null;
        console.warn(`[DBX] Failed to build semantic model for hover tooltip:`, error);
      }
    }
    const semanticTarget = semanticModel ? resolveSqlSemanticNavigationTarget(semanticModel, parts) : null;
    const semanticQualifierIsRowSource = !!qualifier && !!semanticTarget && (semanticTarget.alias?.toLowerCase() === qualifier.toLowerCase() || semanticTarget.source.name.toLowerCase() === qualifier.toLowerCase());
    const tableLookupName = semanticTarget && !semanticQualifierIsRowSource ? semanticTarget.name : name;
    const qualifiedTableLookup = semanticTarget?.schema ? `${semanticTarget.schema}.${semanticTarget.name}` : identifier;

    // CTE-derived columns: trace to the physical column and show its type/source/comment before
    // the generic table/column fallback (which cannot see inside a CTE body).
    if (semanticModel) {
      const cteColumn = await resolveCteColumnHoverColumn(semanticModel, name, qualifier);
      if (cteColumn) {
        return {
          pos: range.from,
          end: range.to,
          create: () => createHoverDom(cteColumn.name, cteColumn.dataType || "column", undefined, [cteColumn.schema ? `${cteColumn.schema}.${cteColumn.table}` : cteColumn.table, ...(cteColumn.comment?.trim() ? [cteColumn.comment.trim()] : [])]),
        };
      }
    }

    const lookup = resolveHoverTableLookupTarget({
      database: props.database,
      schema: props.schema,
      catalog: props.catalog,
      databaseType: props.databaseType,
      tableName: tableLookupName,
      // Alias.column must not be treated as schema.table; keep the bare column/table token.
      identifierParts: semanticQualifierIsRowSource ? [tableLookupName] : parts,
      semanticDatabase: semanticQualifierIsRowSource ? undefined : semanticTarget?.database,
      semanticSchema: semanticQualifierIsRowSource ? undefined : semanticTarget?.schema,
      mode: settingsStore.editorSettings.tableHoverLookupMode,
    });

    const hoverTarget = completionMetadataTarget({
      name: lookup.tableName,
      catalog: props.catalog,
      database: lookup.database !== props.database ? lookup.database : undefined,
      schema: lookup.schema,
    });
    if (!hoverTarget) return null;
    const hoverScope: HoverTableScope = {
      catalog: hoverTarget.catalog,
      database: hoverTarget.database,
      schema: hoverTarget.schema,
    };
    const preferredSchema = props.schema;
    const matchHoverTable = (tables: typeof completionMetadata.cachedTables) =>
      matchHoverTableCandidates(tables, {
        lookups: [qualifiedTableLookup, identifier],
        tableName: tableLookupName,
        preferredSchema,
      });

    try {
      const searchLocal = (schema?: string) => {
        const scopeForFilter: HoverTableScope = { ...hoverScope, schema };
        const localTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, hoverScope.database, tableLookupName, MAX_COMPLETION_TABLES, schema, hoverScope.catalog);
        const localHoverTables = schema ? scopeHoverTables(localTables, scopeForFilter) : scopeHoverTables(localTables, { ...hoverScope, schema: undefined });
        return localHoverTables;
      };
      const searchRemote = async (schema: string | undefined, globalSearch: boolean) => {
        const loadedTables = await connectionStore.listCompletionTables(props.connectionId!, hoverScope.database, tableLookupName, MAX_COMPLETION_TABLES, schema, globalSearch, preferredSchema, hoverScope.catalog);
        return schema ? scopeHoverTables(loadedTables, { ...hoverScope, schema }) : loadedTables;
      };

      let hoverTables = completionMetadata.cachedTables.filter((table) => (lookup.preferGlobalFirst || !hoverScope.schema ? hoverTableMatchesScope(table, { ...hoverScope, schema: undefined }) : hoverTableMatchesScope(table, hoverScope)));
      let table = matchHoverTable(hoverTables);

      if (!table && !lookup.preferGlobalFirst) {
        const localHoverTables = searchLocal(hoverScope.schema);
        hoverTables = mergeCompletionTables(localHoverTables, hoverTables);
        completionMetadata.cachedTables = mergeCompletionTables(localHoverTables, completionMetadata.cachedTables);
        table = matchHoverTable(hoverTables);
      }

      if (!table && lookup.preferGlobalFirst) {
        const localHoverTables = searchLocal(undefined);
        hoverTables = mergeCompletionTables(localHoverTables, hoverTables);
        completionMetadata.cachedTables = mergeCompletionTables(localHoverTables, completionMetadata.cachedTables);
        table = matchHoverTable(hoverTables);
      }

      if (!table && !usesLocalOnlyCompletionMetadata() && !lookup.preferGlobalFirst) {
        const remoteHoverTables = await searchRemote(hoverScope.schema, false);
        hoverTables = mergeCompletionTables(hoverTables, remoteHoverTables);
        completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, remoteHoverTables);
        table = matchHoverTable(hoverTables);
      }

      if (!table && !usesLocalOnlyCompletionMetadata() && lookup.preferGlobalFirst) {
        const remoteHoverTables = await searchRemote(undefined, true);
        hoverTables = mergeCompletionTables(hoverTables, remoteHoverTables);
        completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, remoteHoverTables);
        table = matchHoverTable(hoverTables);
      }

      if (!table && lookup.allowGlobalFallback && !lookup.preferGlobalFirst) {
        const localHoverTables = searchLocal(undefined);
        hoverTables = mergeCompletionTables(localHoverTables, hoverTables);
        completionMetadata.cachedTables = mergeCompletionTables(localHoverTables, completionMetadata.cachedTables);
        table = matchHoverTable(hoverTables);
        if (!table && !usesLocalOnlyCompletionMetadata()) {
          const remoteHoverTables = await searchRemote(undefined, true);
          hoverTables = mergeCompletionTables(hoverTables, remoteHoverTables);
          completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, remoteHoverTables);
          table = matchHoverTable(hoverTables);
        }
      }

      if (table && settingsStore.editorSettings.showTableDdlHoverPreview && !semanticQualifierIsRowSource && (!qualifier || table.schema?.toLowerCase() === qualifier.toLowerCase() || table.name === name)) {
        const hoverDatabase = table.database ?? hoverScope.database;
        const hoverSchema = table.schema ?? hoverScope.schema ?? "";
        const hoverQualifiedName = [hoverScope.catalog, hoverDatabase, hoverSchema, table.name].filter(Boolean).join(".");
        const objectMetadataRequest = {
          connectionId: props.connectionId,
          database: hoverDatabase,
          schema: hoverSchema,
          tableName: table.name,
          catalog: hoverScope.catalog,
          objectType: sqlObjectNavigationSourceKind(table),
        };
        let sqlContent: string | undefined;
        const formatDialect = props.formatDialect ?? sqlFormatDialectForDbType(props.databaseType);
        let metadataLoadFailed = false;

        // The persisted display DDL is canonical across the full-page and hover
        // views. Hover only removes PostgreSQL's appended access-control tail.
        try {
          const { ddl } = await loadObjectDdl(objectMetadataRequest);
          const rawDdl = ddlForHoverPreview(applyDdlStoragePreference(ddl, props.databaseType, settingsStore.editorSettings.excludeDdlStorage));
          if (rawDdl && rawDdl.trim()) {
            // A view's display DDL wraps the raw (often single-line) view source
            // in `CREATE ... VIEW ... AS`; the table-oriented reformatter cannot
            // lay out a SELECT body, so views reuse the shared display formatter
            // (the same one the sidebar/object-source viewers use). Tables keep
            // the aligned column layout from reformatHoverDdl.
            const isViewObject = objectMetadataRequest.objectType === "VIEW" || objectMetadataRequest.objectType === "MATERIALIZED_VIEW";
            const formatted = isViewObject ? await formatSqlForDisplay(rawDdl, formatDialect, settingsStore.editorSettings.sqlFormatter) : reformatHoverDdl(rawDdl, quoteQualifiedName(hoverQualifiedName));
            const unqualified = applyDdlDatabaseQualifier(formatted, formatDialect, props.databaseType, settingsStore.editorSettings.generateSqlIncludeDatabaseName, hoverDatabase, props.catalog);
            sqlContent = settingsStore.editorSettings.generateSqlQuoteIdentifiers ? unqualified : omitDdlIdentifierQuotes(unqualified, formatDialect);
          }
        } catch (error) {
          console.warn(`[DBX] Failed to load table DDL for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
        }

        // Fallback path: rebuild the DDL from cached table metadata when the
        // backend DDL is unavailable (empty result or request failure).
        if (!sqlContent) {
          let fullColumns: ColumnInfo[] = [];
          let fullIndexes: IndexInfo[] = [];
          let tableComment: string | undefined;
          try {
            const [columnsResult, indexesResult] = await Promise.all([
              loadObjectMetadataFacet(objectMetadataRequest, "columns", () => api.getColumns(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog)),
              loadObjectMetadataFacet(objectMetadataRequest, "indexes", () => api.listIndexes(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog)).catch(() => ({ value: [] as IndexInfo[], cacheStatus: "remote" as const })),
            ]);
            fullColumns = columnsResult.value;
            fullIndexes = indexesResult.value;
          } catch (error) {
            metadataLoadFailed = true;
            console.warn(`[DBX] Failed to load table metadata for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
          }
          if (!metadataLoadFailed) {
            try {
              const commentResult = await loadObjectMetadataFacet(objectMetadataRequest, "comment", () => api.getTableComment(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog));
              if (commentResult.value) tableComment = commentResult.value;
            } catch (error) {
              console.warn(`[DBX] Failed to load table comment for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
            }
          }
          if (fullColumns.length > 0) {
            sqlContent = buildHoverTableSql(quoteQualifiedName(hoverQualifiedName), fullColumns, fullIndexes, tableComment);
            sqlContent = applyDdlDatabaseQualifier(sqlContent, formatDialect, props.databaseType, settingsStore.editorSettings.generateSqlIncludeDatabaseName, hoverDatabase, props.catalog);
            if (!settingsStore.editorSettings.generateSqlQuoteIdentifiers) sqlContent = omitDdlIdentifierQuotes(sqlContent, formatDialect);
            metadataLoadFailed = false;
          }
        }
        // Re-check after async metadata load — the context menu may have opened
        // while the DDL request was in flight, and we must not display a hover
        // tooltip on top of an open context menu.
        if (contextMenuOpen.value) return null;
        return {
          pos: range.from,
          end: range.to,
          create: () => createHoverDom(table.name, sqlObjectHoverDetail(table), sqlContent, metadataLoadFailed ? ["[DBX] Failed to load table structure — check connection"] : undefined),
        };
      }

      const legacyContext = getEditorSqlCompletionContext(sql, pos);
      const context = semanticModel ? sqlCompletionContextFromSemantic(semanticModel, legacyContext) : legacyContext;
      const candidates = qualifier ? context.referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : context.referencedTables;

      for (const refTable of candidates) {
        const columns: SqlCompletionColumn[] =
          refTable.columns?.map((columnName) => ({
            name: columnName,
            table: refTable.name,
            ...(refTable.schema ? { schema: refTable.schema } : {}),
          })) ?? [];
        if (columns.length === 0) {
          await ensureColumnsForTable(refTable);
          columns.push(...(cachedColumnsByTable.get(completionCacheKey(refTable)) ?? []));
        }
        const column = columns.find((col) => col.name.toLowerCase() === name.toLowerCase());
        if (!column) continue;
        return {
          pos: range.from,
          end: range.to,
          create: () => createHoverDom(column.name, column.dataType || "column", undefined, [column.schema ? `${column.schema}.${column.table}` : column.table, ...(column.comment?.trim() ? [column.comment.trim()] : [])]),
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  return { resolveSqlHoverTooltip };
}
