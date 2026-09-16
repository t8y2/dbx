import { reactive, shallowReactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { openSchemaDiffSession } from "@/composables/useDialogSources";
import { useExportTracker } from "@/composables/useExportTracker";
import { filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { compileSchemaDiffTableFilter } from "@/lib/schema/schemaDiffTableFilter";
import { filterSchemaDiffFunctions } from "@/lib/schema/schemaDiffRoutine";
import { loadSchemaDetails } from "@/lib/schema/schemaDiffMetadataLoad";
import type { SchemaDiffTableIdentity, SchemaDiffTableListLoader } from "@/lib/schema/schemaDiffTableList";
import { getSchemaDiffNextProgressStep, isSchemaDiffPostgresLike, shouldLoadSchemaDiffExtraObjectPhase, shouldLoadSchemaDiffRoutines, type SchemaDiffProgressPhase } from "@/lib/schema/schemaDiffProgress";
import { schemaDiffRoutineObjectTypesIntersection } from "@/lib/database/databaseObjectCapabilities";
import { convertToSchemaDiffObjects, databaseTypeToDialectKind, normalizeDialectKind, schemaDiffDeployTargetSchema, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { normalizeSchemaDiffCompareOptions, type SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { DatabaseType, FunctionInfo, TableInfo } from "@/types/database";
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
    selectedRoutines: options.selectedRoutines ? [...options.selectedRoutines] : options.selectedRoutines,
    routineMappings: options.routineMappings?.map((mapping) => ({ ...mapping })),
    fieldMappings: options.fieldMappings?.map((mapping) => ({ ...mapping })),
  };
}

function resultObjectCount(result: SchemaDiffPreparation): number {
  return result.diffs.length + (result.functionDiffs?.length ?? 0) + (result.sequenceDiffs?.length ?? 0) + (result.ruleDiffs?.length ?? 0) + (result.ownerDiffs?.length ?? 0);
}

function sessionError(error: unknown): string {
  return error instanceof Error ? error.message : (error as { message?: string } | null)?.message || String(error);
}

function filterFunctionsByRoutineKinds(functions: FunctionInfo[], kinds: Array<"PROCEDURE" | "FUNCTION">): FunctionInfo[] {
  if (kinds.length === 0) return [];
  if (kinds.length === 2) return functions;
  const allowProcedure = kinds.includes("PROCEDURE");
  const allowFunction = kinds.includes("FUNCTION");
  return functions.filter((fn) => {
    const type = (fn.function_type || "").toUpperCase();
    if (allowProcedure && type.includes("PROC")) return true;
    if (allowFunction && (type.includes("FUNC") || type === "" || type === "FUNCTION")) return true;
    return false;
  });
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
  const routineKinds = schemaDiffRoutineObjectTypesIntersection(input.sourceDbType as DatabaseType, input.targetDbType);
  const loadRoutines = shouldLoadSchemaDiffRoutines(input.sourceDbType, input.targetDbType, options);
  const sessionOptions = options;
  const isPostgresLike = isSchemaDiffPostgresLike(input.targetDbType);
  const hasExtraObjectPhase = shouldLoadSchemaDiffExtraObjectPhase(input.sourceDbType, input.targetDbType, sessionOptions);
  const tableFilter = compileSchemaDiffTableFilter(sessionOptions);
  const loadTableMetadata = !!(sessionOptions.tables || sessionOptions.views);

  try {
    publishProgress(session, { phase: "loading-table-lists" });

    let sourceTables: TableInfo[] = [];
    let targetTables: TableInfo[] = [];
    let sourceDetails: Awaited<ReturnType<typeof loadSchemaDetails>> = [];
    let targetDetails: Awaited<ReturnType<typeof loadSchemaDetails>> = [];

    if (loadTableMetadata) {
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
      ({ sourceTables, targetTables } = filterSchemaDiffTables(sourceTableList, targetTableList, tableFilter, sessionOptions, sessionOptions.selectedTables));

      publishProgress(session, { phase: "loading-source-details", current: 0, total: sourceTables.length });
      sourceDetails = await loadSchemaDetails(
        sourceTables,
        {
          connectionId: input.sourceConnectionId,
          database: input.sourceDatabase,
          schema: input.sourceSchema,
          dbType: input.sourceDbType,
          options: sessionOptions,
          onProgress: (progress) => publishProgress(session, { phase: "loading-source-details", ...progress }),
        },
        api,
      );

      publishProgress(session, { phase: "loading-target-details", current: 0, total: targetTables.length });
      targetDetails = await loadSchemaDetails(
        targetTables,
        {
          connectionId: input.targetConnectionId,
          database: input.targetDatabase,
          schema: input.targetSchema,
          dbType: input.targetDbType,
          options: sessionOptions,
          onProgress: (progress) => publishProgress(session, { phase: "loading-target-details", ...progress }),
        },
        api,
      );
    }

    const promises: Promise<unknown>[] = [];
    if (loadRoutines) {
      promises.push(api.listFunctions(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listFunctions(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }
    if (isPostgresLike && sessionOptions.sequences) {
      promises.push(api.listSequences(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema, !!sessionOptions.sequenceLastValues));
      promises.push(api.listSequences(input.targetConnectionId, input.targetDatabase, input.targetSchema, !!sessionOptions.sequenceLastValues));
    }
    if (isPostgresLike && sessionOptions.rules) {
      promises.push(api.listRules(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listRules(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }
    if (isPostgresLike && sessionOptions.owners) {
      promises.push(api.listOwners(input.sourceConnectionId, input.sourceDatabase, input.sourceSchema));
      promises.push(api.listOwners(input.targetConnectionId, input.targetDatabase, input.targetSchema));
    }

    if (hasExtraObjectPhase) publishProgress(session, { phase: "loading-extra-objects" });
    const extraObjects = await Promise.all(promises);
    let index = 0;
    const listedSourceFunctions = loadRoutines ? filterFunctionsByRoutineKinds(extraObjects[index++] as FunctionInfo[], routineKinds) : [];
    const listedTargetFunctions = loadRoutines ? filterFunctionsByRoutineKinds(extraObjects[index++] as FunctionInfo[], routineKinds) : [];
    const { sourceFunctions, targetFunctions } = filterSchemaDiffFunctions(listedSourceFunctions, listedTargetFunctions, sessionOptions.selectedRoutines, sessionOptions.routineMappings ?? []);
    const sourceSequences = sessionOptions.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const targetSequences = sessionOptions.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const sourceRules = sessionOptions.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const targetRules = sessionOptions.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const sourceOwners = sessionOptions.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];
    const targetOwners = sessionOptions.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];

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
      tableMappings: sessionOptions.selectedTables === undefined ? undefined : sessionOptions.tableMappings,
      databaseType: input.targetDbType,
      targetSchema: schemaDiffDeployTargetSchema(input.targetDbType, input.targetDatabase, input.targetSchema),
      ignoreComments: input.ignoreComments,
      cascadeDelete: sessionOptions.cascadeDelete ?? false,
      compareColumnOrder: sessionOptions.compareColumnOrder,
      ignoreTableNameCase: sessionOptions.ignoreTableNameCase,
      ignoreColumnNameCase: sessionOptions.ignoreColumnNameCase,
      detectRenames: sessionOptions.detectRenames ?? false,
      detectTableRenames: sessionOptions.detectTableRenames ?? false,
      renameThreshold: sessionOptions.renameThreshold ?? 0.5,
      enableRollback: sessionOptions.enableRollback ?? false,
      batchPatterns: sessionOptions.batchPatterns
        ? sessionOptions.batchPatterns
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
      sourceDialect: sessionOptions.sourceDialect ? normalizeDialectKind(sessionOptions.sourceDialect) : input.sourceDbType ? databaseTypeToDialectKind(input.sourceDbType as DatabaseType) : undefined,
      targetDialect: sessionOptions.targetDialect ? normalizeDialectKind(sessionOptions.targetDialect) : input.targetDbType ? databaseTypeToDialectKind(input.targetDbType) : undefined,
      compatibilityThreshold: sessionOptions.compatibilityThreshold ?? 0.5,
      fieldMappings:
        sessionOptions.fieldMappings?.map((mapping) => ({
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
  return getSchemaDiffNextProgressStep(session.progress?.phase, shouldLoadSchemaDiffExtraObjectPhase(session.config.sourceDbType, session.config.targetDbType, session.config.options));
}

export function schemaDiffSessionObjects(result: SchemaDiffPreparation | null): SchemaDiffObject[] {
  if (!result) return [];
  return convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs, result.renameCandidates);
}
