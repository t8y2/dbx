import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDatabaseOptions, catalogDatabaseOptionsKey } from "@/composables/useDatabaseOptions";
import { schemaOptionsCacheKey, useSchemaOptions } from "@/composables/useSchemaOptions";
import { isInternalDorisCatalog } from "@/lib/database/databaseFeatureSupport";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { supportsQueryExecution } from "@/lib/database/databaseFeatureSupport";
import { sqlExecutionTargetCapabilities, targetCanUseDefaultWhenDatabaseListEmpty, targetDefaultDatabase, targetIsSingleDatabase, targetSupportsCatalog, targetSupportsSchema, targetUsesConnectionOnlyScope } from "@/lib/database/sqlExecutionTargetCapabilities";
import type { CatalogInfo, ConnectionConfig, DatabaseType } from "@/types/database";
import type { MultiDbExecutionTarget, SqlExecutionTargetValidation } from "@/types/sqlExecution";

export type SqlExecutionTargetValidationReason = "targetMissingConnection" | "targetTypeMismatch" | "targetCatalogMissing" | "targetDatabaseMissing" | "targetSchemaMissing" | "targetPermissionDenied" | "targetValidationFailed";

export interface MultiDbTargetCatalogOption {
  name: string;
  targetCatalog?: string;
  isInternal: boolean;
}

export interface MultiDbTargetResourceState {
  status: "idle" | "loading" | "loaded" | "error";
  loading: boolean;
  loaded: boolean;
  error?: string;
}

type DatabaseTypeSource = Ref<DatabaseType | undefined> | ComputedRef<DatabaseType | undefined> | DatabaseType | undefined;

function sourceValue(source: DatabaseTypeSource): DatabaseType | undefined {
  return typeof source === "string" || source === undefined ? source : source.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function catalogTargetValue(catalog: CatalogInfo): MultiDbTargetCatalogOption {
  const isInternal = isInternalDorisCatalog(catalog.catalog_type, catalog.name);
  return {
    name: catalog.name,
    targetCatalog: isInternal ? undefined : catalog.name,
    isInternal,
  };
}

export function useMultiDbTargetSelection(databaseTypeSource: DatabaseTypeSource) {
  const connectionStore = useConnectionStore();
  const databaseOptionsApi = useDatabaseOptions();
  const schemaOptionsApi = useSchemaOptions();
  const resourceStates = ref<Record<string, MultiDbTargetResourceState>>({});
  const pendingLoads = new Map<string, Promise<void>>();

  const databaseType = computed(() => sourceValue(databaseTypeSource));
  const compatibleConnections = computed(() =>
    connectionStore.connections
      .filter((connection) => {
        const effectiveType = effectiveDatabaseTypeForConnection(connection);
        return effectiveType === databaseType.value && supportsQueryExecution(connection.db_type);
      })
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true, sensitivity: "base" })),
  );

  function stateFor(key: string): MultiDbTargetResourceState {
    return resourceStates.value[key] ?? { status: "idle", loading: false, loaded: false };
  }

  function setState(key: string, state: MultiDbTargetResourceState): void {
    resourceStates.value[key] = state;
  }

  async function loadOnce(key: string, loader: () => Promise<void>): Promise<void> {
    const existing = pendingLoads.get(key);
    if (existing) return existing;
    const request = (async () => {
      setState(key, { status: "loading", loading: true, loaded: false });
      try {
        await loader();
        setState(key, { status: "loaded", loading: false, loaded: true });
      } catch (error) {
        setState(key, { status: "error", loading: false, loaded: false, error: errorMessage(error) });
        throw error;
      } finally {
        pendingLoads.delete(key);
      }
    })();
    pendingLoads.set(key, request);
    return request;
  }

  function connection(connectionId: string): ConnectionConfig | undefined {
    return connectionStore.getConfig(connectionId);
  }

  function isCatalogCapable(connectionId: string): boolean {
    return targetSupportsCatalog(connection(connectionId));
  }

  function catalogsForConnection(connectionId: string): MultiDbTargetCatalogOption[] {
    return (databaseOptionsApi.catalogOptions.value[connectionId] ?? []).map(catalogTargetValue);
  }

  function catalogOption(connectionId: string, targetCatalog?: string): MultiDbTargetCatalogOption | undefined {
    return catalogsForConnection(connectionId).find((catalog) => catalog.targetCatalog === targetCatalog);
  }

  function databaseCacheKey(connectionId: string, targetCatalog?: string): string {
    return targetCatalog ? catalogDatabaseOptionsKey(connectionId, targetCatalog) : connectionId;
  }

  function databaseNamesForConnection(connectionId: string, targetCatalog?: string): string[] {
    const config = connection(connectionId);
    if (config && targetUsesConnectionOnlyScope(config)) return [];
    const cached = targetCatalog ? databaseOptionsApi.catalogDatabaseOptions.value[databaseCacheKey(connectionId, targetCatalog)] : databaseOptionsApi.databaseOptions.value[connectionId];
    const cache = targetCatalog ? databaseOptionsApi.catalogDatabaseOptions.value : databaseOptionsApi.databaseOptions.value;
    const cacheKey = databaseCacheKey(connectionId, targetCatalog);
    if (stateFor(`databases:${cacheKey}`).status === "error") return [];
    const hasLoadedMetadata = Object.prototype.hasOwnProperty.call(cache, cacheKey);
    const loadedNames = cached ?? [];
    if (loadedNames.length > 0) return loadedNames;
    if (config && targetCanUseDefaultWhenDatabaseListEmpty(config)) {
      const defaultDatabase = targetDefaultDatabase(config);
      if (defaultDatabase) return [defaultDatabase];
    }
    // An empty loaded response is authoritative. Returning no synthetic
    // database here lets the selector expose an explicit connection fallback
    // only for capabilities that registered one, without turning an empty
    // metadata response into an arbitrary database list.
    if (hasLoadedMetadata) return [];
    return [];
  }

  function schemaDatabaseName(target: MultiDbExecutionTarget, config: ConnectionConfig): string {
    if (target.database) return target.database;
    if (targetIsSingleDatabase(config)) return "_";
    return "";
  }

  function schemaNamesForTarget(target: MultiDbExecutionTarget): string[] {
    const config = connection(target.connectionId);
    if (!config || !targetSupportsSchema(config)) return [];
    const database = schemaDatabaseName(target, config);
    if (stateFor(`schemas:${schemaOptionsCacheKey(target.connectionId, database, config.show_system_schemas === true)}`).status === "error") return [];
    return schemaOptionsApi.getSchemaOptionsForDb(target.connectionId, database);
  }

  async function loadConnection(connectionId: string): Promise<void> {
    const config = connection(connectionId);
    if (!config) return;
    if (targetUsesConnectionOnlyScope(config)) return;
    if (isCatalogCapable(connectionId)) {
      await loadCatalogs(connectionId);
      const catalogs = catalogsForConnection(connectionId);
      const internalCatalog = catalogs.find((catalog) => catalog.isInternal);
      await loadDatabase(connectionId, internalCatalog?.targetCatalog);
      return;
    }
    await loadDatabase(connectionId);
  }

  async function loadCatalogs(connectionId: string): Promise<void> {
    if (!isCatalogCapable(connectionId)) return;
    const config = connection(connectionId);
    const provider = sqlExecutionTargetCapabilities(config)?.provider;
    if (!config || !provider) return;
    await loadOnce(`catalogs:${connectionId}`, async () => {
      await provider.listTargets(
        config,
        { level: "catalog" },
        {
          listCatalogs: async () => {
            await databaseOptionsApi.loadCatalogOptions(connectionId);
            return catalogsForConnection(connectionId).map((catalog) => catalog.name);
          },
        },
      );
    });
  }

  async function loadDatabase(connectionId: string, targetCatalog?: string): Promise<void> {
    const config = connection(connectionId);
    if (!config) return;
    if (targetUsesConnectionOnlyScope(config)) return;
    const provider = sqlExecutionTargetCapabilities(config)?.provider;
    if (!provider) return;
    const key = databaseCacheKey(connectionId, targetCatalog);
    await loadOnce(`databases:${key}`, async () => {
      await provider.listTargets(
        config,
        { level: "database", catalog: targetCatalog },
        {
          listDatabases: async (catalog) => {
            if (catalog) await databaseOptionsApi.loadCatalogDatabaseOptions(connectionId, catalog);
            else await databaseOptionsApi.loadDatabaseOptions(connectionId);
            return databaseNamesForConnection(connectionId, catalog);
          },
        },
      );
    });
  }

  async function loadSchemas(target: MultiDbExecutionTarget): Promise<void> {
    const config = connection(target.connectionId);
    if (!config || !targetSupportsSchema(config)) return;
    const provider = sqlExecutionTargetCapabilities(config)?.provider;
    if (!provider) return;
    const database = schemaDatabaseName(target, config);
    const key = schemaOptionsCacheKey(target.connectionId, database, config.show_system_schemas === true);
    await loadOnce(`schemas:${key}`, async () => {
      await provider.listTargets(
        config,
        { level: "schema", database },
        {
          listSchemas: async (requestedDatabase) => {
            await schemaOptionsApi.loadSchemaOptions(target.connectionId, requestedDatabase);
            return schemaOptionsApi.getSchemaOptionsForDb(target.connectionId, requestedDatabase);
          },
        },
      );
    });
  }

  function resourceState(key: string): MultiDbTargetResourceState {
    return stateFor(key);
  }

  function databaseState(connectionId: string, targetCatalog?: string): MultiDbTargetResourceState {
    return resourceState(`databases:${databaseCacheKey(connectionId, targetCatalog)}`);
  }

  function catalogState(connectionId: string): MultiDbTargetResourceState {
    return resourceState(`catalogs:${connectionId}`);
  }

  function schemaState(target: MultiDbExecutionTarget): MultiDbTargetResourceState {
    const config = connection(target.connectionId);
    if (!config) return { status: "idle", loading: false, loaded: false };
    const database = schemaDatabaseName(target, config);
    return resourceState(`schemas:${schemaOptionsCacheKey(target.connectionId, database, config.show_system_schemas === true)}`);
  }

  async function validateTarget(target: MultiDbExecutionTarget): Promise<SqlExecutionTargetValidation> {
    const config = connection(target.connectionId);
    if (!config) return { target, state: "invalid", reason: "targetMissingConnection" };
    if (!databaseType.value) return { target, state: "invalid", reason: "targetValidationFailed" };
    if (effectiveDatabaseTypeForConnection(config) !== databaseType.value) return { target, state: "invalid", reason: "targetTypeMismatch" };
    const capabilities = sqlExecutionTargetCapabilities(config);
    if (!capabilities) return { target, state: "invalid", reason: "targetValidationFailed" };
    try {
      await capabilities.provider.validateTarget(target, config);
    } catch {
      return { target, state: "invalid", reason: "targetValidationFailed" };
    }
    if (capabilities.scope === "connection") {
      if (target.database.trim() || target.catalog !== undefined || target.schema !== undefined) return { target, state: "invalid", reason: "targetDatabaseMissing" };
      return { target: { ...target, database: "" }, state: "valid" };
    }

    try {
      if (isCatalogCapable(target.connectionId)) {
        await loadCatalogs(target.connectionId);
        // An omitted catalog is the normalized representation of the
        // driver's internal catalog. It must still be present in the loaded
        // catalog metadata; otherwise an empty/partial catalog response must
        // not silently validate a target against a fabricated default.
        if (!catalogOption(target.connectionId, target.catalog)) {
          return { target, state: "invalid", reason: "targetCatalogMissing" };
        }
      } else if (target.catalog !== undefined) {
        return { target, state: "invalid", reason: "targetCatalogMissing" };
      }

      await loadDatabase(target.connectionId, target.catalog);
      if (databaseState(target.connectionId, target.catalog).status !== "loaded") {
        return { target, state: "invalid", reason: "targetValidationFailed" };
      }
      const databases = databaseNamesForConnection(target.connectionId, target.catalog);
      if (target.database) {
        if (databases.length === 0) {
          if (!capabilities.allowDefaultWhenDatabaseListEmpty || target.database !== capabilities.defaultDatabase) {
            return { target, state: "invalid", reason: "targetDatabaseMissing" };
          }
        } else if (!databases.includes(target.database)) {
          return { target, state: "invalid", reason: "targetDatabaseMissing" };
        }
      } else if (capabilities.databaseRequired || !capabilities.allowsEmptyDatabaseTarget) {
        return { target, state: "invalid", reason: "targetDatabaseMissing" };
      }

      if (target.schema !== undefined) {
        if (!capabilities.supportsSchema) return { target, state: "invalid", reason: "targetSchemaMissing" };
        await loadSchemas(target);
        if (schemaState(target).status !== "loaded") {
          return { target, state: "invalid", reason: "targetValidationFailed" };
        }
        const schemas = schemaNamesForTarget(target);
        if (schemas.length === 0 || !schemas.includes(target.schema)) return { target, state: "invalid", reason: "targetSchemaMissing" };
      }
      // Keep the provider as the final authority for the context that will be
      // consumed by execution. This also prevents a future namespace provider
      // from being considered valid merely because a list item was present.
      capabilities.provider.toExecutionContext(target, config);
      return { target, state: "valid" };
    } catch (error) {
      return { target, state: "invalid", reason: error instanceof Error && /permission|denied|forbidden|unauthorized/i.test(error.message) ? "targetPermissionDenied" : "targetValidationFailed" };
    }
  }

  async function validateTargets(targets: readonly MultiDbExecutionTarget[]): Promise<SqlExecutionTargetValidation[]> {
    // Target validation is independent. Keep the shared loadOnce/pendingLoads
    // deduplication semantics, but allow different connections/databases to
    // load metadata concurrently instead of making the dialog wait for a
    // full serial pass.
    return Promise.all(targets.map((target) => validateTarget(target)));
  }

  return {
    databaseType,
    compatibleConnections,
    resourceStates,
    connection,
    isCatalogCapable,
    catalogsForConnection,
    databaseNamesForConnection,
    schemaNamesForTarget,
    loadConnection,
    loadCatalogs,
    loadDatabase,
    loadSchemas,
    resourceState,
    catalogState,
    databaseState,
    schemaState,
    validateTarget,
    validateTargets,
  };
}
