import { computed, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { tableObjectSourceKind } from "@/lib/table/tableObjectSourceKind";
import { columnIndexMetadataRequestCurrent, columnIndexTableIdentity } from "@/lib/dataGrid/dataGridColumnIndexIcon";
import { foreignKeyMetadataRequestCurrent, foreignKeyTableIdentity } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import { refreshLoadedMongoIndexes } from "@/lib/mongo/mongoIndexMetadata";
import type { ColumnInfo, ConstraintInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";

type SettingsStore = ReturnType<typeof import("@/stores/settingsStore").useSettingsStore>;
type ConnectionStore = ReturnType<typeof useConnectionStore>;

interface TableMetadataProps {
  connectionId?: string;
  database?: string;
  context?: "results" | "table-data";
  tableInfoTab?: string;
  autoShowTableInfo?: boolean;
  tableMeta?: {
    catalog?: string;
    database?: string;
    schema?: string;
    tableName: string;
    tableType?: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
}

interface TableMetadataState {
  ddlContent: Ref<string>;
  ddlLoading: Ref<boolean>;
  tableInfoColumns: Ref<ColumnInfo[]>;
  tableInfoColumnsLoading: Ref<boolean>;
  tableOwner: Ref<string | null>;
  tableOwnerLoading: Ref<boolean>;
  tableOwnerError: Ref<string>;
  indexes: Ref<IndexInfo[]>;
  indexesLoaded: Ref<boolean>;
  indexesLoading: Ref<boolean>;
  indexesError: Ref<string>;
  foreignKeys: Ref<ForeignKeyInfo[]>;
  foreignKeysLoaded: Ref<boolean>;
  foreignKeysLoading: Ref<boolean>;
  foreignKeysError: Ref<string>;
  triggers: Ref<TriggerInfo[]>;
  triggersLoaded: Ref<boolean>;
  triggersLoading: Ref<boolean>;
  triggersError: Ref<string>;
  constraints: Ref<ConstraintInfo[]>;
  constraintsLoaded: Ref<boolean>;
  constraintsLoading: Ref<boolean>;
  constraintsError: Ref<string>;
  tableInfoColumnsRequestGeneration: Ref<number>;
  tableOwnerRequestGeneration: Ref<number>;
  indexesRequestGeneration: Ref<number>;
  foreignKeysRequestGeneration: Ref<number>;
  constraintsRequestGeneration: Ref<number>;
}

export interface DataGridTableMetadataLoaderOptions {
  props: TableMetadataProps;
  state: TableMetadataState;
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  resolvedDatabaseType: ComputedRef<DatabaseType | undefined>;
  canShowTableIndexes: ComputedRef<boolean>;
  showTableInfo: Ref<boolean>;
  toast: (message: string, duration?: number) => void;
  formatBackendError: (error: unknown) => string;
  toastMongoIndexRefreshError: (message: string) => void;
}

export function useDataGridTableMetadataLoaders(options: DataGridTableMetadataLoaderOptions) {
  const { props, state } = options;

  const currentTableIdentity = (kind: "columns" | "owner" | "indexes" | "foreignKeys" | "constraints") =>
    kind === "foreignKeys"
      ? foreignKeyTableIdentity({
          connectionId: props.connectionId,
          database: props.database,
          catalog: props.tableMeta?.catalog,
          schema: props.tableMeta?.schema,
          tableName: props.tableMeta?.tableName,
        })
      : columnIndexTableIdentity({
          connectionId: props.connectionId,
          database: props.database,
          catalog: props.tableMeta?.catalog,
          schema: props.tableMeta?.schema,
          tableName: props.tableMeta?.tableName,
        });

  const tableRequest = () => {
    if (!props.connectionId || !props.tableMeta) return undefined;
    return {
      connectionId: props.connectionId,
      database: props.database || "",
      schema: props.tableMeta.schema || props.database || "",
      tableName: props.tableMeta.tableName,
      catalog: props.tableMeta.catalog,
      objectType: tableObjectSourceKind(props.tableMeta.tableType),
    };
  };

  const currentIndexTableIdentity = computed(() => currentTableIdentity("indexes"));
  const currentForeignKeyTableIdentity = computed(() => currentTableIdentity("foreignKeys"));
  const currentConstraintTableIdentity = computed(() => currentTableIdentity("constraints"));

  async function fetchDdl(force = options.settingsStore.editorSettings.refreshDdlOnOpen) {
    const request = tableRequest();
    if (!request) return;
    options.showTableInfo.value = true;
    state.ddlLoading.value = true;
    try {
      const { ddl } = await loadObjectDdl(request, { force });
      const formatDialect = sqlFormatDialectForDbType(options.resolvedDatabaseType.value);
      state.ddlContent.value = options.settingsStore.editorSettings.generateSqlQuoteIdentifiers ? ddl : omitDdlIdentifierQuotes(ddl, formatDialect);
    } catch (error: any) {
      state.ddlContent.value = `-- Error: ${error}`;
    } finally {
      state.ddlLoading.value = false;
    }
  }

  async function fetchTableInfoColumns(force = false) {
    const request = tableRequest();
    if (!request) return;
    const requestGeneration = ++state.tableInfoColumnsRequestGeneration.value;
    state.tableInfoColumnsLoading.value = true;
    try {
      const { value: columns } = await loadObjectMetadataFacet(request, "columns", () => api.getColumns(request.connectionId, request.database, request.schema, request.tableName, request.catalog), { force });
      if (requestGeneration !== state.tableInfoColumnsRequestGeneration.value) return;
      state.tableInfoColumns.value = columns;
    } catch (error) {
      if (requestGeneration !== state.tableInfoColumnsRequestGeneration.value) return;
      options.toast(options.formatBackendError(error), 5000);
    } finally {
      if (requestGeneration === state.tableInfoColumnsRequestGeneration.value) state.tableInfoColumnsLoading.value = false;
    }
  }

  async function fetchTableOwner(force = false) {
    if (options.resolvedDatabaseType.value !== "postgres" || !props.connectionId || !props.database || !props.tableMeta?.schema || !props.tableMeta.tableName) return;
    const request = tableRequest();
    if (!request) return;
    const requestGeneration = ++state.tableOwnerRequestGeneration.value;
    state.tableOwnerLoading.value = true;
    state.tableOwnerError.value = "";
    try {
      const result = await loadObjectMetadataFacet(request, "owner", () => api.getTableOwner(request.connectionId, request.database, request.schema, request.tableName), { force });
      if (requestGeneration !== state.tableOwnerRequestGeneration.value) return;
      state.tableOwner.value = result.value;
    } catch (error: any) {
      if (requestGeneration !== state.tableOwnerRequestGeneration.value) return;
      state.tableOwner.value = null;
      state.tableOwnerError.value = error?.message || String(error);
    } finally {
      if (requestGeneration === state.tableOwnerRequestGeneration.value) state.tableOwnerLoading.value = false;
    }
  }

  async function fetchIndexes() {
    const request = tableRequest();
    const requestIdentity = currentTableIdentity("indexes");
    if (!request || !requestIdentity || !options.canShowTableIndexes.value || state.indexesLoaded.value || state.indexesLoading.value) return;
    const requestGeneration = ++state.indexesRequestGeneration.value;
    await runMetadataRequest({
      loading: state.indexesLoading,
      error: state.indexesError,
      requestGeneration,
      currentGeneration: () => state.indexesRequestGeneration.value,
      isCurrent: () =>
        columnIndexMetadataRequestCurrent({
          requestGeneration,
          currentGeneration: state.indexesRequestGeneration.value,
          requestIdentity,
          currentIdentity: currentTableIdentity("indexes"),
        }),
      load: () => api.listIndexes(request.connectionId, request.database, request.schema, request.tableName, request.catalog),
      onSuccess: (value) => {
        state.indexes.value = value;
        state.indexesLoaded.value = true;
      },
    });
  }

  async function reloadIndexes() {
    state.indexesLoaded.value = false;
    await fetchIndexes();
  }

  async function refreshMongoIndexMetadataAfterMutation() {
    await reloadIndexes();
    const connectionId = props.connectionId;
    const database = props.database;
    const collection = props.tableMeta?.tableName;
    if (!connectionId || !database || !collection) return;
    try {
      await refreshLoadedMongoIndexes(options.connectionStore, { connectionId, database, collection });
    } catch (error: any) {
      options.toastMongoIndexRefreshError(String(error?.message || error));
    }
  }

  async function fetchForeignKeys() {
    const request = tableRequest();
    const requestIdentity = currentTableIdentity("foreignKeys");
    if (!request || !requestIdentity || state.foreignKeysLoaded.value || state.foreignKeysLoading.value) return;
    const requestGeneration = ++state.foreignKeysRequestGeneration.value;
    await runMetadataRequest({
      loading: state.foreignKeysLoading,
      error: state.foreignKeysError,
      requestGeneration,
      currentGeneration: () => state.foreignKeysRequestGeneration.value,
      isCurrent: () =>
        foreignKeyMetadataRequestCurrent({
          requestGeneration,
          currentGeneration: state.foreignKeysRequestGeneration.value,
          requestIdentity,
          currentIdentity: currentTableIdentity("foreignKeys"),
        }),
      load: () => api.listForeignKeys(request.connectionId, request.database, request.schema, request.tableName, request.catalog),
      onSuccess: (value) => {
        state.foreignKeys.value = value;
        state.foreignKeysLoaded.value = true;
      },
    });
  }

  async function fetchTriggers() {
    const request = tableRequest();
    if (!request || state.triggersLoaded.value || state.triggersLoading.value) return;
    state.triggersLoading.value = true;
    state.triggersError.value = "";
    try {
      state.triggers.value = await api.listTriggers(request.connectionId, request.database, request.schema, request.tableName, request.catalog);
      state.triggersLoaded.value = true;
    } catch (error: any) {
      state.triggersError.value = String(error?.message || error);
    } finally {
      state.triggersLoading.value = false;
    }
  }

  async function fetchConstraints() {
    const request = tableRequest();
    const requestIdentity = currentTableIdentity("constraints");
    if (!request || !requestIdentity || state.constraintsLoaded.value || state.constraintsLoading.value) return;
    const requestGeneration = ++state.constraintsRequestGeneration.value;
    await runMetadataRequest({
      loading: state.constraintsLoading,
      error: state.constraintsError,
      requestGeneration,
      currentGeneration: () => state.constraintsRequestGeneration.value,
      isCurrent: () =>
        columnIndexMetadataRequestCurrent({
          requestGeneration,
          currentGeneration: state.constraintsRequestGeneration.value,
          requestIdentity,
          currentIdentity: currentTableIdentity("constraints"),
        }),
      load: () => api.listConstraints(request.connectionId, request.database, request.schema, request.tableName, request.catalog),
      onSuccess: (value) => {
        state.constraints.value = value;
        state.constraintsLoaded.value = true;
      },
    });
  }

  return {
    currentIndexTableIdentity,
    currentForeignKeyTableIdentity,
    currentConstraintTableIdentity,
    fetchDdl,
    fetchTableInfoColumns,
    fetchTableOwner,
    fetchIndexes,
    reloadIndexes,
    refreshMongoIndexMetadataAfterMutation,
    fetchForeignKeys,
    fetchTriggers,
    fetchConstraints,
  };
}

interface MetadataRequest<T> {
  loading: Ref<boolean>;
  error: Ref<string>;
  requestGeneration: number;
  currentGeneration: () => number;
  isCurrent: () => boolean;
  load: () => Promise<T>;
  onSuccess: (value: T) => void;
}

async function runMetadataRequest<T>(request: MetadataRequest<T>) {
  request.loading.value = true;
  request.error.value = "";
  try {
    const value = await request.load();
    if (!request.isCurrent()) return;
    request.onSuccess(value);
  } catch (error: any) {
    if (request.isCurrent()) request.error.value = String(error?.message || error);
  } finally {
    if (request.isCurrent() && request.currentGeneration() === request.requestGeneration) request.loading.value = false;
  }
}
