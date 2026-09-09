import { reactive, shallowReactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { openSchemaDiffSession } from "@/composables/useDialogSources";
import { useExportTracker } from "@/composables/useExportTracker";
import { filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { compileSchemaDiffTableFilter } from "@/lib/schema/schemaDiffTableFilter";
import { loadSchemaDetails } from "@/lib/schema/schemaDiffMetadataLoad";
import type { SchemaDiffTableIdentity, SchemaDiffTableListLoader } from "@/lib/schema/schemaDiffTableList";
import { getSchemaDiffNextProgressStep, isSchemaDiffPostgresLike, shouldLoadSchemaDiffExtraObjects, type SchemaDiffProgressPhase } from "@/lib/schema/schemaDiffProgress";
import { convertToSchemaDiffObjects, databaseTypeToDialectKind, normalizeDialectKind, schemaDiffDeployTargetSchema, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { normalizeSchemaDiffCompareOptions, type SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { DatabaseType } from "@/types/database";
import type { SchemaDiffPreparation } from "@/lib/schema/schemaDiff";

export interface SchemaDiffSessionProgress {
  phase: SchemaDiffProgressPhase;
  current?: number;
  total?: number;
  objectName?: string;
}

export interface SchemaDiffSessionConfig {
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  sourceDbType: string;
  targetDbType: DatabaseType;
  options: SchemaDiffCompareOptions;
  ignoreComments: boolean;
  label: string;
}

export type SchemaDiffSessionStatus = "running" | "completed" | "failed";

export interface SchemaDiffSession {
  id: string;
  version: number;
  status: SchemaDiffSessionStatus;
  config: SchemaDiffSessionConfig;
  progress: SchemaDiffSessionProgress | null;
  result: SchemaDiffPreparation | null;
  error: string | null;
  startedAt: number;
  finishedAt?: number;
}

export interface SchemaDiffSessionDependencies {
  tableListLoader: SchemaDiffTableListLoader;
}

const sessions = reactive(new Map<string, SchemaDiffSession>());

function cloneOptions(options: SchemaDiffCompareOptions): SchemaDiffCompareOptions {
  return {
    ...options,
    selectedTables: options.selectedTables ? [...options.selectedTables] : options.selectedTables,
    tableMappings: options.tableMappings?.map((mapping) => ({ ...mapping })),
    fieldMappings: options.fieldMappings?.map((mapping) => ({ ...mapping })),
  };
}

function resultObjectCount(result: SchemaDiffPreparation): number {
  return result.diffs.length + (result.functionDiffs?.length ?? 0) + (result.sequenceDiffs?.length ?? 0) + (result.ruleDiffs?.length ?? 0) + (result.ownerDiffs?.length ?? 0);
}

function sessionError(error: unknown): string {
  return error instanceof Error ? error.message : (error as { message?: string } | null)?.message || String(error);
}

function publishProgress(session: SchemaDiffSession, progress: SchemaDiffSessionProgress): void {
  session.version += 1;
  session.progress = progress;
  useExportTracker().updateCompareTask(session.id, {
    status: "Running",
    comparePhase: progress.phase,
    compareCurrent: progress.current,
    compareTotal: progress.total,
    compareCurrentObject: progress.objectName,
  });
}

async function runSchemaDiffSession(session: SchemaDiffSession, dependencies: SchemaDiffSessionDependencies): Promise<void> {
  const input = session.config;
  const tracker = useExportTracker();
  const options = normalizeSchemaDiffCompareOptions(input.options, input.targetDbType);
  const isPostgresLike = isSchemaDiffPostgresLike(input.targetDbType);
  const hasExtraObjectPhase = shouldLoadSchemaDiffExtraObjects(input.targetDbType, options);
  const tableFilter = compileSchemaDiffTableFilter(options);

  try {
    publishProgress(session, { phase: "loading-table-lists" });

    const sourceTableIdentity: SchemaDiffTableIdentity = {
      connectionId: input.sourceConnectionId,
      database: input.sourceDatabase,
      schema: input.sourceSchema,
    };
    const targetTableIdentity: SchemaDiffTableIdentity = {
      connectionId: input.targetConnectionId,
      database: input.targetDatabase,
      schema: input.targetSchema,
    };
    const [sourceTableList, targetTableList] = await Promise.all([dependencies.tableListLoader.load(sourceTableIdentity, { refresh: true }), dependencies.tableListLoader.load(targetTableIdentity, { refresh: true })]);
    const { sourceTables, targetTables } = filterSchemaDiffTables(sourceTableList, targetTableList, tableFilter, options, options.selectedTables);

    publishProgress(session, { phase: "loading-source-details", current: 0, total: sourceTables.length });
    const sourceDetails = await loadSchemaDetails(
      sourceTables,
      {
        connectionId: input.sourceConnectionId,
        database: input.sourceDatabase,
        schema: input.sourceSchema,
        dbType: input.sourceDbType,
        options,
        onProgress: (progress) => publishProgress(session, { phase: "loading-source-details", ...progress }),
      },
      api,
    );

    publishProgress(session, { phase: "loading-target-details", current: 0, total: targetTables.length });
    const targetDetails = await loadSchemaDetails(
      targetTables,
      {
        connectionId: input.targetConnectionId,
        database: input.targetDatabase,
        schema: input.targetSchema,
        dbType: input.targetDbType,
        options,
        onProgress: (progress) => publishProgress(session, { phase: "loading-target-details", ...progress }),
      },
      api,
    );

    const promises: Promise<unknown>[] = [];
    if (isPostgresLike && options.functions) {
      promises.push(api.listFunctions(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listFunctions(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }
    if (isPostgresLike && options.sequences) {
      promises.push(api.listSequences(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema, !!options.sequenceLastValues));
      promises.push(api.listSequences(input.targetConnectionId, input.targetDatabase, input.targetSchema, !!options.sequenceLastValues));
    }
    if (isPostgresLike && options.rules) {
      promises.push(api.listRules(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listRules(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }
    if (isPostgresLike && options.owners) {
      promises.push(api.listOwners(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listOwners(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }

    if (hasExtraObjectPhase) publishProgress(session, { phase: "loading-extra-objects" });
    const extraObjects = await Promise.all(promises);
    let index = 0;
    const sourceFunctions = options.functions && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listFunctions>>) : [];
    const targetFunctions = options.functions && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listFunctions>>) : [];
    const sourceSequences = options.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const targetSequences = options.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const sourceRules = options.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const targetRules = options.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const sourceOwners = options.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];
    const targetOwners = options.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];

    publishProgress(session, { phase: "comparing" });
    const result = await api.prepareSchemaDiff({
      sourceTables,
      targetTables,
      sourceDetails,
      targetDetails,
      sourceFunctions,
      targetFunctions,
      sourceSequences,
      targetSequences,
      sourceRules,
      targetRules,
      sourceOwners,
      targetOwners,
      tableMappings: options.selectedTables === undefined ? undefined : options.tableMappings,
      databaseType: input.targetDbType,
      targetSchema: schemaDiffDeployTargetSchema(input.targetDbType, input.targetDatabase, input.targetSchema),
      ignoreComments: input.ignoreComments,
      cascadeDelete: options.cascadeDelete ?? false,
      compareColumnOrder: options.compareColumnOrder,
      ignoreTableNameCase: options.ignoreTableNameCase,
      ignoreColumnNameCase: options.ignoreColumnNameCase,
      detectRenames: options.detectRenames ?? false,
      detectTableRenames: options.detectTableRenames ?? false,
      renameThreshold: options.renameThreshold ?? 0.5,
      enableRollback: options.enableRollback ?? false,
      batchPatterns: options.batchPatterns
        ? options.batchPatterns
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
      sourceDialect: options.sourceDialect ? normalizeDialectKind(options.sourceDialect) : input.sourceDbType ? databaseTypeToDialectKind(input.sourceDbType as DatabaseType) : undefined,
      targetDialect: options.targetDialect ? normalizeDialectKind(options.targetDialect) : input.targetDbType ? databaseTypeToDialectKind(input.targetDbType) : undefined,
      compatibilityThreshold: options.compatibilityThreshold ?? 0.5,
      fieldMappings:
        options.fieldMappings?.map((mapping) => ({
          sourceType: mapping.sourceType,
          targetType: mapping.targetType,
          paramStrategy: mapping.paramStrategy ?? "preserve",
          customParams: mapping.customParams,
        })) || [],
    });

    publishProgress(session, { phase: "generating" });
    session.result = result;
    session.progress = { phase: "complete" };
    session.version += 1;
    session.status = "completed";
    session.finishedAt = Date.now();
    tracker.updateCompareTask(session.id, {
      status: "Done",
      comparePhase: "complete",
      compareCurrent: 1,
      compareTotal: 1,
      compareResultCount: resultObjectCount(result),
    });
  } catch (error: unknown) {
    const message = sessionError(error);
    session.error = message;
    session.progress = null;
    session.version += 1;
    session.status = "failed";
    session.finishedAt = Date.now();
    tracker.updateCompareTask(session.id, {
      status: "Error",
      errorMessage: message,
    });
  }
}

export function startSchemaDiffSession(input: Omit<SchemaDiffSessionConfig, "options"> & { options: SchemaDiffCompareOptions }, dependencies: SchemaDiffSessionDependencies): SchemaDiffSession {
  const id = uuid();
  const session = shallowReactive<SchemaDiffSession>({
    id,
    version: 0,
    status: "running",
    config: {
      ...input,
      options: cloneOptions(input.options),
    },
    progress: null,
    result: null,
    error: null,
    startedAt: Date.now(),
  });
  sessions.set(id, session);

  const tracker = useExportTracker();
  tracker.addSchemaDiffTask(
    id,
    input.label,
    () => openSchemaDiffSession(id),
    () => removeSchemaDiffSession(id),
  );
  void runSchemaDiffSession(session, dependencies);
  return session;
}

export function getSchemaDiffSession(id: string | null | undefined): SchemaDiffSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export function removeSchemaDiffSession(id: string): boolean {
  const session = sessions.get(id);
  if (session?.status === "running") return false;
  return sessions.delete(id);
}

export function schemaDiffSessionNextProgressStep(session: SchemaDiffSession): string | null {
  return getSchemaDiffNextProgressStep(session.progress?.phase, shouldLoadSchemaDiffExtraObjects(session.config.targetDbType, session.config.options));
}

export function schemaDiffSessionObjects(result: SchemaDiffPreparation | null): SchemaDiffObject[] {
  if (!result) return [];
  return convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs, result.renameCandidates);
}
