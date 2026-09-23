import type { EditorState, Text } from "@codemirror/state";
import type { CompletionMetadataScope } from "./queryEditorTypes";
import { insertValueHintColumnNames } from "@/lib/sql/insertValueHintColumns";
import { COMPLETION_METADATA_CONCURRENCY } from "@/stores/connectionStore";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { SqlSemanticModel } from "@/lib/sql/semantic/types";
import { usesOracleSessionCompletionColumns as shouldUseOracleSessionCompletionColumns } from "@/lib/sql/oracleCompletionSession";
import { mergeSqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import { requestInsertValueHintsRefresh, supportsInsertValueHints } from "@/lib/editor/codemirrorInsertValueHints";
import { isSchemaAware, isSingleDatabase, supportsDatabaseSchemaQualifier } from "@/lib/database/databaseFeatureSupport";
import { metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { usesLocalOnlyEditorCompletionMetadata, usesOnDemandOnlyEditorColumnMetadata } from "@/lib/metadata/completionMetadataPolicy";
import * as api from "@/lib/backend/api";
import { isSqlVirtualTableReference } from "@/lib/sql/semantic/diagnostics";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionObject, SqlCompletionReferencedTable, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { DatabaseType, SqlTableReference } from "@/types/database";
import type { ShallowRef } from "vue";
import type { EditorView } from "@codemirror/view";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { QueryEditorProps } from "./queryEditorTypes";

export interface RoutineCompletionTarget {
  schema?: string;
  parentName?: string;
  globalSearch?: boolean;
}

interface QueryEditorCompletionMetadataOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorView | null>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  sqlBehaviorDialect: () => QueryEditorProps["dialect"];
  remoteLatencyBudgetMs: number;
  maxCompletionTables: number;
  onDemandMinPrefix: number;
  semanticCompletionEnabled: boolean;
}

export function useQueryEditorCompletionMetadata(options: QueryEditorCompletionMetadataOptions) {
  const { props, view, connectionStore, sqlBehaviorDialect } = options;
  const COMPLETION_REMOTE_LATENCY_BUDGET_MS = options.remoteLatencyBudgetMs;
  const MAX_COMPLETION_TABLES = options.maxCompletionTables;
  const PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX = options.onDemandMinPrefix;
  const SEMANTIC_SQL_COMPLETION_ENABLED = options.semanticCompletionEnabled;

  // Completion cache
  let cachedTables: SqlCompletionTable[] = [];

  const cachedCompletionObjectsByScope = new Map<string, SqlCompletionObject[]>();

  // Persistent column cache keyed by "schema.table" or "table"
  const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();

  const cachedPrefixColumnsByTable = new Map<string, SqlCompletionColumn[]>();

  const cachedInsertValueHintColumnsByTable = new Map<string, string[]>();

  const cachedForeignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();

  const loadedColumnsByTable = new Set<string>();

  function sqlCompletionDialectOptions() {
    return {
      databaseType: props.databaseType,
      dialect: sqlBehaviorDialect(),
      editorState: view.value?.state,
    };
  }

  let editorCompletionContextCache: {
    doc: Text;
    editorState: EditorState | undefined;
    position: number;
    databaseType: DatabaseType | undefined;
    dialect: string | undefined;
    context: ReturnType<typeof getSqlCompletionContext>;
  } | null = null;

  function getEditorSqlCompletionContext(sql: string, position: number, editorState = view.value?.state): ReturnType<typeof getSqlCompletionContext> {
    const dialect = sqlBehaviorDialect();
    const doc = editorState?.doc;
    if (doc && editorCompletionContextCache?.doc === doc && editorCompletionContextCache.editorState === editorState && editorCompletionContextCache.position === position && editorCompletionContextCache.databaseType === props.databaseType && editorCompletionContextCache.dialect === dialect) {
      return editorCompletionContextCache.context;
    }

    const context = getSqlCompletionContext(sql, position, {
      databaseType: props.databaseType,
      dialect,
      editorState,
    });
    if (doc) {
      editorCompletionContextCache = {
        doc,
        editorState,
        position,
        databaseType: props.databaseType,
        dialect,
        context,
      };
    }
    return context;
  }

  // CTE definition metadata is cursor-independent, but hover/ctrl-click models still carry the
  // position; memoize per (Text node, position, dialect, state) so hover and click at the same
  // position share one parse. Any edit swaps the Text node, invalidating the cache for free.
  let editorSemanticModelCache: {
    doc: Text;
    editorState: EditorState | undefined;
    position: number;
    databaseType: DatabaseType | undefined;
    dialect: string | undefined;
    model: SqlSemanticModel;
  } | null = null;

  function getEditorSemanticModel(sql: string, position: number, editorState = view.value?.state): SqlSemanticModel | null {
    if (!SEMANTIC_SQL_COMPLETION_ENABLED) return null;
    const dialect = sqlBehaviorDialect();
    const doc = editorState?.doc;
    if (doc && editorSemanticModelCache?.doc === doc && editorSemanticModelCache.editorState === editorState && editorSemanticModelCache.position === position && editorSemanticModelCache.databaseType === props.databaseType && editorSemanticModelCache.dialect === dialect) {
      return editorSemanticModelCache.model;
    }
    const model = buildSqlSemanticModel(sql, position, {
      databaseType: props.databaseType,
      dialect,
      editorState,
    });
    if (doc) {
      editorSemanticModelCache = {
        doc,
        editorState,
        position,
        databaseType: props.databaseType,
        dialect,
        model,
      };
    }
    return model;
  }

  function usesOracleSessionCompletionColumns(schema?: string | null): boolean {
    return shouldUseOracleSessionCompletionColumns({
      databaseType: props.databaseType,
      selectedSchema: props.schema,
      referenceSchema: schema,
      clientSessionId: props.clientSessionId,
    });
  }

  function completionColumnRequestContext(reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">) {
    return {
      clientSessionId: props.clientSessionId,
      version: props.completionContextVersion,
      tableQuoted: reference?.nameQuoted,
      schemaQuoted: reference?.schemaQuoted,
    };
  }

  async function listCompletionColumnsForEditor(connectionId: string, database: string, table: string, schema?: string, catalog = props.catalog, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">, prefix?: string) {
    const requestedVersion = props.completionContextVersion;
    const sessionScoped = usesOracleSessionCompletionColumns(schema);
    let columns: SqlCompletionColumn[];
    if (prefix && prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql")) {
      try {
        columns = await connectionStore.listCompletionColumnsByPrefix(connectionId, database, table, schema, prefix, catalog, completionColumnRequestContext(reference));
      } catch {
        columns = await connectionStore.listCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
      }
    } else {
      columns = await connectionStore.listCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
    }
    if (sessionScoped && requestedVersion !== props.completionContextVersion) throw new Error("Stale Oracle completion context");
    return columns;
  }

  async function refreshCompletionColumnsForEditor(connectionId: string, database: string, table: string, schema?: string, catalog = props.catalog, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">) {
    const requestedVersion = props.completionContextVersion;
    const sessionScoped = usesOracleSessionCompletionColumns(schema);
    const columns = await connectionStore.refreshCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
    if (sessionScoped && requestedVersion !== props.completionContextVersion) throw new Error("Stale Oracle completion context");
    return columns;
  }

  function completionCacheKey(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope?: CompletionMetadataScope) {
    const schema = table.schema ?? scope?.schema ?? props.schema;
    const scopedDatabase = scope && scope.database !== props.database ? scope.database : undefined;
    const database = supportsDatabaseSchemaQualifierCompletion() ? (table.database ?? scopedDatabase) : undefined;
    const baseKey = schema ? `${database ? `${database}.` : ""}${schema}.${table.name}` : table.name;
    if (props.databaseType !== "postgres" || (!table.nameQuoted && !table.schemaQuoted)) return baseKey;
    return `${baseKey}:quoted:s=${table.schemaQuoted ? "1" : "0"}:t=${table.nameQuoted ? "1" : "0"}`;
  }

  function completionPrefixCacheKey(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope: CompletionMetadataScope | undefined, prefix: string) {
    return `${completionCacheKey(table, scope)}:prefix:${prefix.trim().toLowerCase()}`;
  }

  function lookupCachedPrefixColumns(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope: CompletionMetadataScope | undefined, prefix: string): SqlCompletionColumn[] | undefined {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const exactKey = completionPrefixCacheKey(table, scope, normalizedPrefix);
    const exact = cachedPrefixColumnsByTable.get(exactKey);
    if (exact) return exact;

    const marker = `${completionCacheKey(table, scope)}:prefix:`;
    let best: { prefix: string; columns: SqlCompletionColumn[] } | undefined;
    for (const [key, columns] of cachedPrefixColumnsByTable) {
      if (!key.startsWith(marker)) continue;
      const cachedPrefix = key.slice(marker.length);
      if (!normalizedPrefix.startsWith(cachedPrefix) || (best && cachedPrefix.length <= best.prefix.length)) continue;
      best = { prefix: cachedPrefix, columns };
    }
    if (!best) return undefined;
    return best.columns.filter((column) => column.name.toLowerCase().startsWith(normalizedPrefix));
  }

  const pendingInsertValueHintColumnLoads = new Set<string>();

  function insertHintCacheKey(table: { name: string; schema?: string | null; database?: string | null }) {
    if (table.database) {
      return table.schema ? `${table.database}.${table.schema}.${table.name}` : `${table.database}.${table.name}`;
    }
    return completionCacheKey(table);
  }

  function insertHintMetadataTarget(table: { name: string; schema?: string | null; database?: string | null }): { database: string; schema?: string; catalog?: string } | null {
    if (props.database == null) return null;
    if (table.database) {
      return { database: table.database, schema: table.schema ?? undefined, catalog: props.catalog };
    }
    return completionMetadataTarget(table);
  }

  function getInsertValueHintTableColumns(table: string, schema?: string, database?: string): string[] | undefined {
    const cacheKey = insertHintCacheKey({ name: table, schema, database });
    if (props.databaseType === "sqlserver") return cachedInsertValueHintColumnsByTable.get(cacheKey);
    const cached = cachedColumnsByTable.get(cacheKey);
    if (!cached) return undefined;
    return cached.map((column) => column.name);
  }

  function requestInsertValueHintTableColumns(table: string, schema?: string, database?: string) {
    if (!props.connectionId || props.database == null) return;
    if (!supportsInsertValueHints(props.databaseType)) return;
    const cacheKey = insertHintCacheKey({ name: table, schema, database });
    const hasCachedColumns = props.databaseType === "sqlserver" ? cachedInsertValueHintColumnsByTable.has(cacheKey) : cachedColumnsByTable.has(cacheKey);
    if (hasCachedColumns || pendingInsertValueHintColumnLoads.has(cacheKey)) return;
    const target = insertHintMetadataTarget({ name: table, schema, database });
    if (!target) return;
    pendingInsertValueHintColumnLoads.add(cacheKey);
    const connectionId = props.connectionId;
    const databaseType = props.databaseType;
    const loadColumns = async () => {
      if (databaseType === "sqlserver") {
        const querySchema = metadataSchemaForConnection(connectionStore.getConfig(connectionId), target.database, target.schema);
        const columns = await api.getSqlServerColumnMetadata(connectionId, target.database, querySchema, table);
        cachedInsertValueHintColumnsByTable.set(cacheKey, insertValueHintColumnNames(databaseType, columns));
        return;
      }
      const columns = await listCompletionColumnsForEditor(connectionId, target.database, table, target.schema, target.catalog);
      cachedColumnsByTable.set(cacheKey, columns);
    };
    void loadColumns()
      .then(() => {
        loadedColumnsByTable.add(cacheKey.toLowerCase());
        if (view.value) requestInsertValueHintsRefresh(view.value);
      })
      .catch(() => {})
      .finally(() => {
        pendingInsertValueHintColumnLoads.delete(cacheKey);
      });
  }

  function supportsDatabaseQualifierCompletion(): boolean {
    return !!props.databaseType && !isSchemaAware(props.databaseType) && !isSingleDatabase(props.databaseType);
  }

  function supportsDatabaseSchemaQualifierCompletion(): boolean {
    return supportsDatabaseSchemaQualifier(props.databaseType);
  }

  function usesLocalOnlyCompletionMetadata(): boolean {
    return usesLocalOnlyEditorCompletionMetadata(props.databaseType);
  }

  function usesOnDemandOnlyCompletionColumns(): boolean {
    return usesOnDemandOnlyEditorColumnMetadata(props.databaseType);
  }

  function allowsOnDemandQualifiedTableCompletion(prefix: string): boolean {
    if (!usesLocalOnlyCompletionMetadata()) return false;
    if (props.databaseType !== "prestosql" && props.databaseType !== "trino") return false;
    return prefix.trim().length >= PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX;
  }

  function completionMetadataTarget(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }, scope?: CompletionMetadataScope): { database: string; schema?: string; catalog?: string } | null {
    const currentDatabase = scope?.database ?? props.database;
    if (currentDatabase == null) return null;
    // SQL Server metadata queries require a schema even when the SQL uses an
    // unqualified table name. The query editor commonly has no schema selected
    // when the user is working from a database-level tab, so use the same
    // default as the table/DDL metadata paths instead of returning no columns.
    const selectedSchema = table.schema ?? scope?.schema ?? props.schema;
    const effectiveSchema = selectedSchema ?? (props.databaseType === "sqlserver" ? metadataSchemaForConnection(connectionStore.getConfig(props.connectionId ?? ""), currentDatabase, undefined) : undefined);
    if (supportsDatabaseSchemaQualifierCompletion() && table.database) {
      return { database: table.database, schema: effectiveSchema, catalog: table.catalog ?? props.catalog };
    }
    if (supportsDatabaseQualifierCompletion() && effectiveSchema) {
      return { database: effectiveSchema, catalog: table.catalog ?? props.catalog };
    }
    return { database: currentDatabase, schema: effectiveSchema, catalog: table.catalog ?? props.catalog };
  }

  function isVirtualCompletionTableReference(table: { name: string; database?: string | null; schema?: string | null }): boolean {
    return isSqlVirtualTableReference(table, props.databaseType);
  }

  function completionQualifiedTableTarget(completionContext: ReturnType<typeof getSqlCompletionContext>): { name: string; database?: string; schema: string } | null {
    if (!completionContext.suggestColumns) return null;
    const parts = completionContext.qualifierParts ?? completionContext.qualifier?.split(".").filter(Boolean) ?? [];
    if (parts.length < 2) return null;
    const name = parts[parts.length - 1];
    const schema = parts[parts.length - 2];
    if (!name || !schema) return null;
    const database = supportsDatabaseSchemaQualifierCompletion() && parts.length >= 3 ? parts[parts.length - 3] : undefined;
    return { name, database, schema };
  }

  function completionTablesMatch(left: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }, right: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }) {
    if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
    if (left.catalog && right.catalog && left.catalog.toLowerCase() !== right.catalog.toLowerCase()) return false;
    if (left.database && right.database && left.database.toLowerCase() !== right.database.toLowerCase()) return false;
    if (!left.schema || !right.schema) return true;
    return left.schema.toLowerCase() === right.schema.toLowerCase();
  }

  async function findExactSemanticDiagnosticTable(table: SqlTableReference, scope?: CompletionMetadataScope): Promise<SqlCompletionTable | null> {
    if (!props.connectionId || props.database == null) return null;
    const target = completionMetadataTarget(table, scope);
    if (!target) return null;
    const localMatches = connectionStore.lookupLocalCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema, target.catalog);
    const localExact = localMatches.find((item) => completionTablesMatch(item, table));
    if (localExact) {
      cachedTables = mergeCompletionTables(cachedTables, [localExact]);
      return localExact;
    }

    const remoteMatches = await connectionStore.listCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema, false, scope?.schema ?? props.schema, target.catalog, {
      verifySchemaMetadata: !!target.schema,
    });
    cachedTables = mergeCompletionTables(cachedTables, remoteMatches);
    return remoteMatches.find((item) => completionTablesMatch(item, table)) ?? null;
  }

  async function ensureColumnsForTable(table: { name: string; database?: string | null; schema?: string | null }, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">, scope?: CompletionMetadataScope): Promise<boolean> {
    if (isVirtualCompletionTableReference(table)) return false;
    const cacheKey = completionCacheKey(table, scope);
    if (cachedColumnsByTable.has(cacheKey)) return true;
    if (!props.connectionId || props.database == null) return false;
    const target = completionMetadataTarget(table, scope);
    if (!target) return false;
    const localColumns = connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, table.name, target.schema, target.catalog, completionColumnRequestContext(reference));
    if (localColumns.length > 0) {
      cachedColumnsByTable.set(cacheKey, localColumns);
      loadedColumnsByTable.add(cacheKey.toLowerCase());
      return true;
    }
    let columns = await listCompletionColumnsForEditor(props.connectionId, target.database, table.name, target.schema, target.catalog, reference);

    // A schema-aware connection can legitimately return an empty result when
    // the editor has no selected schema. Resolve the physical table from the
    // local/remote table cache and retry with its schema before reporting that
    // star expansion is unavailable. This is especially important for aliased
    // sources because the alias itself must never be sent as the table name.
    if (columns.length === 0 && !table.schema && !target.schema && !supportsDatabaseQualifierCompletion()) {
      const schemaCandidates: string[] = [];
      const seenSchemas = new Set<string>();
      const addSchema = (schema?: string | null) => {
        const normalized = schema?.trim();
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seenSchemas.has(key)) return;
        seenSchemas.add(key);
        schemaCandidates.push(normalized);
      };

      if (props.databaseType === "sqlserver") {
        addSchema(metadataSchemaForConnection(connectionStore.getConfig(props.connectionId), target.database, undefined));
      }

      const localTables = connectionStore.lookupLocalCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, undefined, target.catalog);
      localTables.forEach((candidate) => {
        if (candidate.name.toLowerCase() === table.name.toLowerCase()) addSchema(candidate.schema);
      });
      if (schemaCandidates.length === 0 && !usesLocalOnlyCompletionMetadata()) {
        const remoteTables = await connectionStore.listCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, undefined, false, undefined, target.catalog);
        remoteTables.forEach((candidate) => {
          if (candidate.name.toLowerCase() === table.name.toLowerCase()) addSchema(candidate.schema);
        });
      }

      for (const schema of schemaCandidates) {
        const schemaTarget = completionMetadataTarget({ ...table, schema }, scope);
        if (!schemaTarget) continue;
        const retryColumns = await listCompletionColumnsForEditor(props.connectionId, schemaTarget.database, table.name, schemaTarget.schema, schemaTarget.catalog, reference);
        if (retryColumns.length > 0) {
          columns = retryColumns;
          break;
        }
      }
    }
    // Do not memoize an empty response as a successful load. Empty results are
    // commonly caused by a temporarily unresolved schema; keeping that value
    // would prevent the next expansion attempt from retrying after metadata has
    // become available.
    if (columns.length > 0) {
      cachedColumnsByTable.set(cacheKey, columns);
      loadedColumnsByTable.add(cacheKey.toLowerCase());
    } else {
      cachedColumnsByTable.delete(cacheKey);
      loadedColumnsByTable.delete(cacheKey.toLowerCase());
    }
    return true;
  }

  function isMissingTableMetadataError(error: unknown) {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    return message.includes("42s02") || message.includes("1146") || message.includes("doesn't exist") || message.includes("does not exist") || message.includes("unknown table");
  }

  async function ensureForeignKeysForTable(table: { name: string; database?: string | null; schema?: string | null }) {
    if (isVirtualCompletionTableReference(table)) return;
    const cacheKey = completionCacheKey(table);
    if (cachedForeignKeysByTable.has(cacheKey) || !props.connectionId || props.database == null) return;
    const target = completionMetadataTarget(table);
    if (!target) return;
    try {
      const foreignKeys = await connectionStore.listCompletionForeignKeys(props.connectionId, target.database, table.name, target.schema);
      cachedForeignKeysByTable.set(cacheKey, foreignKeys);
    } catch (e) {
      console.warn(`[DBX] Failed to load foreign keys for ${cacheKey}:`, e);
      cachedForeignKeysByTable.set(cacheKey, []);
    }
  }

  async function ensureForeignKeysForTables(tables: Array<{ name: string; database?: string | null; schema?: string | null }>) {
    const seen = new Set<string>();
    const uniqueTables = tables.filter((table) => {
      const key = completionCacheKey(table).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (let index = 0; index < uniqueTables.length; index += COMPLETION_METADATA_CONCURRENCY) {
      await Promise.all(uniqueTables.slice(index, index + COMPLETION_METADATA_CONCURRENCY).map((table) => ensureForeignKeysForTable(table)));
    }
  }

  function mergeCompletionTables(existing: SqlCompletionTable[], incoming: SqlCompletionTable[]): SqlCompletionTable[] {
    const merged = [...existing];
    const indexes = new Map(existing.map((table, index) => [`${table.catalog ?? ""}.${table.database ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase(), index]));
    for (const table of incoming) {
      const key = `${table.catalog ?? ""}.${table.database ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase();
      const index = indexes.get(key);
      if (index == null) {
        indexes.set(key, merged.length);
        merged.push(table);
      } else {
        const existing = merged[index];
        // Preserve the more specific tree type if an older metadata endpoint reports a materialized view as VIEW.
        merged[index] = {
          ...existing,
          ...table,
          type: mergeSqlObjectNavigationType(existing.type, table.type),
        };
      }
    }
    return merged;
  }

  function withCompletionLatencyBudget<T>(remote: Promise<T>, local: T): Promise<T> {
    return Promise.race([remote, new Promise<T>((resolve) => setTimeout(() => resolve(local), COMPLETION_REMOTE_LATENCY_BUDGET_MS))]);
  }

  function listCompletionTablesWithLatencyBudget(connectionId: string, database: string, filter: string, limit: number, schema?: string, globalSearch = false, catalog = props.catalog, currentSchema = props.schema): Promise<SqlCompletionTable[]> {
    const local = connectionStore.lookupLocalCompletionTables(connectionId, database, filter, limit, globalSearch ? undefined : schema, catalog).map((table) => ({ ...table, catalog: table.catalog ?? catalog, database: table.database ?? database }));
    const remote = connectionStore.listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog).then((tables) => {
      const scopedTables = tables.map((table) => ({ ...table, catalog: table.catalog ?? catalog, database: table.database ?? database }));
      cachedTables = mergeCompletionTables(cachedTables, scopedTables);
      return scopedTables;
    });
    if (local.length === 0) return remote;
    return withCompletionLatencyBudget(remote, local);
  }

  function mergeCompletionObjects(existing: SqlCompletionObject[], incoming: SqlCompletionObject[]) {
    const merged = [...existing];
    const indexes = new Map(existing.map((object, index) => [completionObjectIdentityKey(object), index]));
    for (const object of incoming) {
      const key = completionObjectIdentityKey(object);
      const index = indexes.get(key);
      if (index == null) {
        indexes.set(key, merged.length);
        merged.push(object);
      } else {
        merged[index] = { ...merged[index], ...object };
      }
    }
    return merged;
  }

  function completionObjectScopeKey(scope: CompletionMetadataScope): string {
    return `${scope.database}:${scope.schema ?? ""}`.toLowerCase();
  }

  function completionObjectsForScope(scope: CompletionMetadataScope): SqlCompletionObject[] {
    return cachedCompletionObjectsByScope.get(completionObjectScopeKey(scope)) ?? [];
  }

  function completionObjectIdentityKey(object: SqlCompletionObject): string {
    return `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}:${object.signature?.trim() ?? ""}`.toLowerCase();
  }

  function completionObjectsDiffer(existing: SqlCompletionObject[], incoming: SqlCompletionObject[]): boolean {
    if (existing.length !== incoming.length) return true;
    return existing.some((object, index) => {
      const other = incoming[index];
      return (
        !other ||
        object.name !== other.name ||
        object.schema !== other.schema ||
        object.type !== other.type ||
        object.parentSchema !== other.parentSchema ||
        object.parentName !== other.parentName ||
        object.dataType !== other.dataType ||
        object.signature !== other.signature ||
        object.comment !== other.comment ||
        object.applyName !== other.applyName ||
        object.boost !== other.boost
      );
    });
  }

  function refreshCompletionCache() {
    cachedTables = [];
    cachedCompletionObjectsByScope.clear();
    cachedColumnsByTable.clear();
    cachedPrefixColumnsByTable.clear();
    cachedInsertValueHintColumnsByTable.clear();
    loadedColumnsByTable.clear();
    cachedForeignKeysByTable.clear();
  }

  return {
    sqlCompletionDialectOptions,
    getEditorSqlCompletionContext,
    ensureColumnsForTable,
    cachedColumnsByTable,
    completionCacheKey,
    getEditorSemanticModel,
    completionMetadataTarget,
    mergeCompletionTables,
    usesLocalOnlyCompletionMetadata,
    supportsDatabaseSchemaQualifierCompletion,
    supportsDatabaseQualifierCompletion,
    completionObjectsForScope,
    usesOracleSessionCompletionColumns,
    completionQualifiedTableTarget,
    completionTablesMatch,
    lookupCachedPrefixColumns,
    completionColumnRequestContext,
    isVirtualCompletionTableReference,
    cachedForeignKeysByTable,
    usesOnDemandOnlyCompletionColumns,
    ensureForeignKeysForTables,
    mergeCompletionObjects,
    completionObjectsDiffer,
    cachedCompletionObjectsByScope,
    completionObjectScopeKey,
    refreshCompletionColumnsForEditor,
    loadedColumnsByTable,
    findExactSemanticDiagnosticTable,
    isMissingTableMetadataError,
    listCompletionColumnsForEditor,
    listCompletionTablesWithLatencyBudget,
    allowsOnDemandQualifiedTableCompletion,
    completionPrefixCacheKey,
    cachedPrefixColumnsByTable,
    getInsertValueHintTableColumns,
    requestInsertValueHintTableColumns,
    refreshCompletionCache,
    get cachedTables() {
      return cachedTables;
    },
    set cachedTables(tables: SqlCompletionTable[]) {
      cachedTables = tables;
    },
  };
}
