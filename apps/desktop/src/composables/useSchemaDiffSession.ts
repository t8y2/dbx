import { reactive, shallowReactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { openSchemaDiffSession } from "@/composables/useDialogSources";
import { useExportTracker } from "@/composables/useExportTracker";
import { filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { compileSchemaDiffTableFilter } from "@/lib/schema/schemaDiffTableFilter";
import { filterSchemaDiffFunctions, schemaDiffRoutineKeyFromFunction } from "@/lib/schema/schemaDiffRoutine";
import { loadSchemaDetails } from "@/lib/schema/schemaDiffMetadataLoad";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { registerSchemaDiffTask } from "@/lib/schema/schemaDiffCancellation";
import type { SchemaDiffTableIdentity, SchemaDiffTableListLoader } from "@/lib/schema/schemaDiffTableList";
import { getSchemaDiffNextProgressStep, isSchemaDiffPostgresLike, shouldLoadSchemaDiffExtraObjectPhase, shouldLoadSchemaDiffRoutines, type SchemaDiffProgressPhase } from "@/lib/schema/schemaDiffProgress";
import { schemaDiffRoutineObjectTypesIntersection, schemaDiffRoutineProductType } from "@/lib/database/databaseObjectCapabilities";
import { convertToSchemaDiffObjects, databaseTypeToDialectKind, normalizeDialectKind, schemaDiffDeployTargetSchema, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { normalizeSchemaDiffCompareOptions, type OracleRoutineCompareContext, type OracleRoutineKind, type OracleRoutineSnapshot, type SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { DatabaseType, FunctionInfo, TableInfo, TransferPackageDraft } from "@/types/database";
import type { SchemaDiffPreparation } from "@/lib/schema/schemaDiff";
import { createOracleRoutineDeployment, disposeOracleRoutineDeployment, synchronizeOracleRoutineSelection, type OracleRoutineDeployment } from "@/lib/schema/oracleRoutineDeploy";

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
  /**
   * Product type behind a JDBC `sourceDbType`/`targetDbType` (see
   * `schemaDiffEngineDatabaseType`). The diff engine and strict Oracle routine
   * collector use the product; unrelated metadata and option defaults keep raw db types.
   */
  sourceEngineDbType?: DatabaseType;
  targetEngineDbType?: DatabaseType;
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
  routineSnapshots?: { source?: OracleRoutineSnapshot; target?: OracleRoutineSnapshot };
  oracleRoutineContext?: OracleRoutineCompareContext;
  routineDeployment?: OracleRoutineDeployment;
  error: string | null;
  startedAt: number;
  finishedAt?: number;
}

export interface SchemaDiffSessionDependencies {
  tableListLoader: SchemaDiffTableListLoader;
}

export interface OraclePackageComparisonHandoff {
  source: OracleRoutineSnapshot["endpoint"];
  target: OracleRoutineSnapshot["endpoint"];
  drafts: readonly TransferPackageDraft[];
}

const sessions = reactive(new Map<string, SchemaDiffSession>());

function schemaDiffDialect(dbType: DatabaseType | string | undefined, explicit: string | undefined): string | undefined {
  if (explicit) return normalizeDialectKind(explicit);
  return dbType ? databaseTypeToDialectKind(dbType as DatabaseType) : undefined;
}

function cloneOptions(options: SchemaDiffCompareOptions): SchemaDiffCompareOptions {
  return {
    ...options,
    selectedTables: options.selectedTables ? [...options.selectedTables] : options.selectedTables,
    tableMappings: options.tableMappings?.map((mapping) => ({ ...mapping })),
    selectedRoutines: options.selectedRoutines ? [...options.selectedRoutines] : options.selectedRoutines,
    ...(options.routineObjectKinds === undefined ? {} : { routineObjectKinds: [...options.routineObjectKinds] }),
    ...(options.selectedRoutineObjects === undefined ? {} : { selectedRoutineObjects: options.selectedRoutineObjects.map((object) => ({ ...object })) }),
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

function filterFunctionsByRoutineKinds(functions: FunctionInfo[], kinds: OracleRoutineKind[], exactKind = false): FunctionInfo[] {
  if (kinds.length === 0) return [];
  if (exactKind) {
    const allowed = new Set<string>(kinds);
    return functions.filter((fn) => allowed.has(fn.function_type));
  }
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

function isOracleRoutineEngine(databaseType: string): boolean {
  return databaseType === "oracle" || databaseType === "oceanbase-oracle";
}

async function loadSessionRoutines(session: SchemaDiffSession, side: "source" | "target", signal: AbortSignal): Promise<FunctionInfo[]> {
  const input = session.config;
  const connectionId = side === "source" ? input.sourceConnectionId : input.targetConnectionId;
  const database = side === "source" ? input.sourceDatabase : input.targetDatabase;
  const schema = side === "source" ? input.sourceSchema : input.targetSchema;
  const engine = side === "source" ? (input.sourceEngineDbType ?? input.sourceDbType) : (input.targetEngineDbType ?? input.targetDbType);
  if (!isOracleRoutineEngine(engine)) return api.listFunctions(connectionId, database, schema);
  const snapshot =
    input.options.routineObjectKinds === undefined
      ? await api.loadSchemaDiffRoutines(connectionId, database, schema, input.options?.selectedRoutines)
      : await api.loadSchemaDiffRoutines(connectionId, database, schema, undefined, { objectKinds: input.options.routineObjectKinds, ...(input.options.selectedRoutineObjects === undefined ? {} : { selectedObjects: input.options.selectedRoutineObjects }) });
  signal.throwIfAborted();
  if (snapshot.endpoint.connectionId !== connectionId || snapshot.endpoint.database !== database || snapshot.endpoint.schema !== schema || snapshot.endpoint.databaseType !== engine) {
    throw new Error("Routine snapshot endpoint does not match this comparison");
  }
  session.routineSnapshots = { ...session.routineSnapshots, [side]: snapshot };
  return snapshot.objects.map((object) => ({ name: object.version.identity.name, function_type: object.version.identity.kind, data_type: "", arguments: "", definition: object.source ?? "" }));
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

async function settleRequests<T>(requests: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(requests);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

async function runSchemaDiffSession(session: SchemaDiffSession, dependencies: SchemaDiffSessionDependencies, signal: AbortSignal, handoff?: OraclePackageComparisonHandoff): Promise<void> {
  const input = session.config;
  const tracker = useExportTracker();
  const options = normalizeSchemaDiffCompareOptions(input.options, input.targetDbType);
  const sourceRoutineType = schemaDiffRoutineProductType(input.sourceDbType, input.sourceEngineDbType);
  const targetRoutineType = schemaDiffRoutineProductType(input.targetDbType, input.targetEngineDbType);
  const routineKinds = options.routineObjectKinds ?? schemaDiffRoutineObjectTypesIntersection(sourceRoutineType, targetRoutineType);
  const typedRoutines = options.routineObjectKinds !== undefined;
  const loadRoutines = shouldLoadSchemaDiffRoutines(sourceRoutineType, targetRoutineType, options);
  const sessionOptions = options;
  const isPostgresLike = isSchemaDiffPostgresLike(input.targetDbType);
  const hasExtraObjectPhase = shouldLoadSchemaDiffExtraObjectPhase(sourceRoutineType, targetRoutineType, sessionOptions);
  const tableFilter = compileSchemaDiffTableFilter(sessionOptions);
  const loadTableMetadata = !!(sessionOptions.tables || sessionOptions.views);

  try {
    if (sessionOptions.functions && (typedRoutines || sessionOptions.selectedRoutineObjects !== undefined)) {
      if (!isOracleRoutineEngine(sourceRoutineType ?? "") || !isOracleRoutineEngine(targetRoutineType ?? "")) throw new Error("Typed program comparison requires two Oracle product endpoints");
      if (!typedRoutines || sessionOptions.selectedRoutines !== undefined) throw new Error("Typed program selection requires explicit kinds and cannot use legacy routine names");
      const supported = new Set(schemaDiffRoutineObjectTypesIntersection(sourceRoutineType, targetRoutineType, routineKinds));
      if (!routineKinds.length || routineKinds.some((kind) => !supported.has(kind))) throw new Error("The selected program kinds are not supported for this exact product pair; cross-product comparison supports explicit package kinds only");
    }
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
      const [sourceTableList, targetTableList] = await settleRequests([dependencies.tableListLoader.load(sourceTableIdentity, { refresh: true }), dependencies.tableListLoader.load(targetTableIdentity, { refresh: true })]);
      signal.throwIfAborted();
      ({ sourceTables, targetTables } = filterSchemaDiffTables(sourceTableList, targetTableList, tableFilter, sessionOptions, sessionOptions.selectedTables));

      // Column/index/foreign-key reads are served from the persisted object
      // metadata cache, which has no TTL on the backend. A compare must see the
      // live structure on both sides, otherwise changes made outside DBX are
      // hidden behind a stale snapshot. Best effort: a failed deletion only
      // means the compare falls back to whatever the cache returns. Users can
      // opt out via `refreshMetadata` to reuse the cache for faster compares.
      if (sessionOptions.refreshMetadata) {
        await Promise.all([invalidateObjectMetadataCache({ connectionId: input.sourceConnectionId, database: input.sourceDatabase }), invalidateObjectMetadataCache({ connectionId: input.targetConnectionId, database: input.targetDatabase })]);
        signal.throwIfAborted();
      }

      publishProgress(session, { phase: "loading-source-details", current: 0, total: sourceTables.length });
      sourceDetails = await loadSchemaDetails(
        sourceTables,
        {
          connectionId: input.sourceConnectionId,
          database: input.sourceDatabase,
          schema: input.sourceSchema,
          dbType: input.sourceDbType,
          options: sessionOptions,
          signal,
          onProgress: (progress) => publishProgress(session, { phase: "loading-source-details", ...progress }),
        },
        api,
      );

      signal.throwIfAborted();
      publishProgress(session, { phase: "loading-target-details", current: 0, total: targetTables.length });
      targetDetails = await loadSchemaDetails(
        targetTables,
        {
          connectionId: input.targetConnectionId,
          database: input.targetDatabase,
          schema: input.targetSchema,
          dbType: input.targetDbType,
          options: sessionOptions,
          signal,
          onProgress: (progress) => publishProgress(session, { phase: "loading-target-details", ...progress }),
        },
        api,
      );
    }

    signal.throwIfAborted();
    const promises: Promise<unknown>[] = [];
    if (loadRoutines) {
      promises.push(loadSessionRoutines(session, "source", signal));
      promises.push(loadSessionRoutines(session, "target", signal));
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
    const extraObjects = await settleRequests(promises);
    signal.throwIfAborted();
    let index = 0;
    const listedSourceFunctions = loadRoutines ? filterFunctionsByRoutineKinds(extraObjects[index++] as FunctionInfo[], routineKinds, typedRoutines) : [];
    const listedTargetFunctions = loadRoutines ? filterFunctionsByRoutineKinds(extraObjects[index++] as FunctionInfo[], routineKinds, typedRoutines) : [];
    const selectedRoutineKeys = typedRoutines ? sessionOptions.selectedRoutineObjects?.map((object) => schemaDiffRoutineKeyFromFunction({ name: object.name, function_type: object.kind, arguments: "" }, true)) : sessionOptions.selectedRoutines;
    const { sourceFunctions, targetFunctions } = filterSchemaDiffFunctions(listedSourceFunctions, listedTargetFunctions, selectedRoutineKeys, sessionOptions.routineMappings ?? [], typedRoutines);
    const sourceSequences = sessionOptions.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const targetSequences = sessionOptions.sequences && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listSequences>>) : [];
    const sourceRules = sessionOptions.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const targetRules = sessionOptions.rules && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listRules>>) : [];
    const sourceOwners = sessionOptions.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];
    const targetOwners = sessionOptions.owners && isPostgresLike ? (extraObjects[index++] as Awaited<ReturnType<typeof api.listOwners>>) : [];
    if (loadRoutines && (isOracleRoutineEngine(input.sourceEngineDbType ?? input.sourceDbType) || isOracleRoutineEngine(input.targetEngineDbType ?? input.targetDbType))) {
      const source = session.routineSnapshots?.source;
      const target = session.routineSnapshots?.target;
      session.oracleRoutineContext = {
        sourceDatabaseType: input.sourceEngineDbType ?? input.sourceDbType,
        targetDatabaseType: input.targetEngineDbType ?? input.targetDbType,
        sourceSchema: input.sourceSchema,
        targetSchema: input.targetSchema,
        sourceEnumerationComplete: source?.enumerationComplete ?? true,
        targetEnumerationComplete: target?.enumerationComplete ?? true,
        sourceIncompleteNames: source?.objects.filter((object) => !object.sourceComplete).map((object) => object.version.identity.name) ?? [],
        targetIncompleteNames: target?.objects.filter((object) => !object.sourceComplete).map((object) => object.version.identity.name) ?? [],
        ...(typedRoutines
          ? {
              objectKinds: sessionOptions.routineObjectKinds,
              sourceIncompleteObjects: source?.objects.filter((object) => !object.sourceComplete).map((object) => ({ name: object.version.identity.name, kind: object.version.identity.kind })) ?? [],
              targetIncompleteObjects: target?.objects.filter((object) => !object.sourceComplete).map((object) => ({ name: object.version.identity.name, kind: object.version.identity.kind })) ?? [],
            }
          : {}),
      };
    }

    publishProgress(session, { phase: "comparing" });
    const result = await api.prepareSchemaDiff({
      sourceTables,
      targetTables,
      sourceDetails,
      targetDetails,
      sourceFunctions,
      targetFunctions,
      oracleRoutines: session.oracleRoutineContext,
      sourceSequences,
      targetSequences,
      sourceRules,
      targetRules,
      sourceOwners,
      targetOwners,
      tableMappings: sessionOptions.selectedTables === undefined ? undefined : sessionOptions.tableMappings,
      databaseType: input.targetEngineDbType ?? input.targetDbType,
      targetSchema: schemaDiffDeployTargetSchema(input.targetDbType, input.targetDatabase, input.targetSchema),
      ignoreComments: input.ignoreComments,
      cascadeDelete: sessionOptions.cascadeDelete ?? false,
      compareColumnOrder: sessionOptions.compareColumnOrder,
      compareCharset: sessionOptions.compareCharset,
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
      sourceDialect: schemaDiffDialect(input.sourceEngineDbType ?? input.sourceDbType, sessionOptions.sourceDialect),
      targetDialect: schemaDiffDialect(input.targetEngineDbType ?? input.targetDbType, sessionOptions.targetDialect),
      compatibilityThreshold: sessionOptions.compatibilityThreshold ?? 0.5,
      fieldMappings:
        sessionOptions.fieldMappings?.map((mapping) => ({
          sourceType: mapping.sourceType,
          targetType: mapping.targetType,
          paramStrategy: mapping.paramStrategy ?? "preserve",
          customParams: mapping.customParams,
        })) || [],
    });

    signal.throwIfAborted();
    publishProgress(session, { phase: "generating" });
    if (handoff) {
      const snapshots = session.routineSnapshots;
      if (!snapshots?.source || !snapshots.target) throw new Error("Transferred package drafts require the original strict comparison endpoints");
      for (const side of ["source", "target"] as const) {
        if ((["connectionId", "database", "schema", "databaseType", "generation"] as const).some((key) => snapshots[side]!.endpoint[key] !== handoff[side][key])) throw new Error("The package comparison endpoint changed during handoff; retain the transfer draft and refresh its original identities");
      }
      const state = reactive(createOracleRoutineDeployment(snapshots.source, snapshots.target));
      const objects = schemaDiffSessionObjects(result);
      for (const saved of handoff.drafts) {
        if ((saved.identity.kind !== "PACKAGE" && saved.identity.kind !== "PACKAGE_BODY") || saved.identity.owner !== snapshots.target.endpoint.schema) throw new Error("Transferred drafts must retain their exact package target identities");
        const object = objects.find((object) => object.name === saved.identity.name && object.routineType === saved.identity.kind);
        if (!object) throw new Error(`Package ${saved.identity.kind} ${saved.identity.name} is unavailable in the fresh comparison; retain its draft in the transfer preview`);
        if (object && saved.sql?.trim() && (object.operationType === "delete" || (object.operationType === "none" && saved.reviewedTargetDraft))) {
          object.operationType = snapshots.target.objects.some((target) => target.version.identity.owner === saved.identity.owner && target.version.identity.name === saved.identity.name && target.version.identity.kind === saved.identity.kind) ? "modify" : "create";
          object.selected = true;
        }
      }
      synchronizeOracleRoutineSelection(state, objects);
      for (const draft of state.drafts) {
        const saved = handoff.drafts.find((saved) => saved.identity.owner === draft.identity.owner && saved.identity.name === draft.identity.name && saved.identity.kind === draft.identity.kind);
        if (saved) Object.assign(draft, saved, { identity: { ...saved.identity }, confirmPackagePair: false });
      }
      session.routineDeployment = state;
    }
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
    const message = sessionError(signal.aborted ? signal.reason : error);
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

export function startSchemaDiffSession(input: Omit<SchemaDiffSessionConfig, "options"> & { options: SchemaDiffCompareOptions }, dependencies: SchemaDiffSessionDependencies, handoff?: OraclePackageComparisonHandoff): SchemaDiffSession {
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
  const controller = new AbortController();
  const frozenHandoff = handoff && {
    source: { ...handoff.source },
    target: { ...handoff.target },
    drafts: handoff.drafts.map(({ identity, sourceName, sql, packageBodySource, packageContract, reviewedTargetDraft }) => ({ identity: { ...identity }, sourceName, sql, packageBodySource, packageContract, reviewedTargetDraft })),
  };
  const settled = runSchemaDiffSession(session, dependencies, controller.signal, frozenHandoff);
  registerSchemaDiffTask([input.sourceConnectionId, input.targetConnectionId], controller, settled);
  return session;
}

export function getSchemaDiffSession(id: string | null | undefined): SchemaDiffSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export function removeSchemaDiffSession(id: string): boolean {
  const session = sessions.get(id);
  if (session?.status === "running") return false;
  if (session?.routineDeployment) void disposeOracleRoutineDeployment(session.routineDeployment);
  return sessions.delete(id);
}

export function schemaDiffSessionNextProgressStep(session: SchemaDiffSession): string | null {
  const config = session.config;
  return getSchemaDiffNextProgressStep(session.progress?.phase, shouldLoadSchemaDiffExtraObjectPhase(schemaDiffRoutineProductType(config.sourceDbType, config.sourceEngineDbType), schemaDiffRoutineProductType(config.targetDbType, config.targetEngineDbType), config.options));
}

export function schemaDiffSessionObjects(result: SchemaDiffPreparation | null, deployment?: OracleRoutineDeployment): SchemaDiffObject[] {
  if (!result) return [];
  const objects = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs, result.renameCandidates);
  for (const object of objects) {
    const draft = deployment?.drafts.find((draft) => draft.objectId === object.id);
    if (draft?.sql?.trim() && draft.action !== "delete" && (object.operationType === "delete" || (object.operationType === "none" && draft.reviewedTargetDraft))) {
      object.operationType = draft.action === "replace" ? "modify" : "create";
    }
  }
  return objects;
}
