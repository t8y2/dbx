import * as api from "@/lib/backend/api";
import { BackendErrorException, normalizeBackendError } from "@/lib/backend/errorUtils";
import type { OracleTypeDataManifest, OracleTypeDataMappingInput } from "@/types/database";
import type { OracleTypeManagementDraft, TypeManagementExecutionOptions } from "./oracleTypeManagement";
import { typeManagementRecordsEqual as same } from "./oracleTypeManagementRecord";

export interface TypeDataMappingDraft {
  manifest: OracleTypeDataManifest;
  insertSql: string;
  insertDraft?: string;
  insertState: "not-sent" | "sent" | "confirmed" | "failed" | "unknown";
  message?: string;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const mappingIdentity = (mapping: OracleTypeDataMappingInput) => [
  mapping.id,
  mapping.source,
  mapping.old,
  mapping.expected,
  mapping.target,
  mapping.fields.map((field) => [field.sourcePath, field.objectNull, field.oldColumn, field.expectedColumn, field.targetPath, field.targetObjectNull ?? false, field.unchanged]),
];
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const sameRelation = (a: { owner: string; name: string }, b: { owner: string; name: string }) => a.owner === b.owner && a.name === b.name;

/** Register once, while the original live reference and data can still be proved. */
export async function registerOracleTypeDataBaseline(plan: OracleTypeManagementDraft, mapping: OracleTypeDataMappingInput, persist: TypeManagementExecutionOptions["persist"]): Promise<OracleTypeManagementDraft> {
  if (plan.steps.some((step) => step.state !== "not-sent") || plan.history.length || plan.dataMappings.some((record) => record.manifest.mapping.id === mapping.id || sameRelation(record.manifest.mapping.source, mapping.source)))
    throw new Error("The original permanent baseline cannot be replaced after registration or dispatch.");
  if (!plan.originalSnapshot.persistentReferences.some((reference) => reference.owner === mapping.source.owner && reference.tableName === mapping.source.name)) throw new Error("Select a persistent relation from the original TYPE snapshot.");
  const result = await api.verifyOracleTypeData({ target: plan.target, action: "register", mapping });
  if (!result.manifest || !same(mappingIdentity(result.manifest.mapping), mappingIdentity(mapping))) throw new Error("The data baseline was not returned for the registered mapping.");
  const source = plan.lastSnapshot.objects.find((object) => object.owner === mapping.source.owner && object.name === mapping.source.name && object.objectType === "TABLE");
  if (source && (source.exists !== true || source.objectId !== result.manifest.original.relation.objectId)) throw new Error("The original table identity changed before baseline registration. Revalidate the TYPE preview.");
  const next = clone(plan);
  next.dataMappings.push({ manifest: result.manifest, insertSql: "", insertDraft: "", insertState: "not-sent" });
  next.dataPreparation = undefined;
  next.dataTargetPaths = undefined;
  next.revision++;
  next.executable = false;
  next.requiresReverify = true;
  next.state = "draft";
  await persist(next);
  return next;
}

/** No business rows cross this API. Reopening a tab must reverify these same baselines. */
export async function verifyOracleTypeDataMappings(plan: OracleTypeManagementDraft): Promise<void> {
  for (const record of plan.dataMappings) {
    if (record.insertState === "sent") record.insertState = "unknown";
    const previous = clone(record.manifest);
    const result = await api.verifyOracleTypeData({ target: plan.target, action: "verify", manifest: previous });
    const actual = result.manifest;
    if (!actual || !actual.verifiedTarget || !same([mappingIdentity(actual.mapping), actual.original, actual.old, actual.expected], [mappingIdentity(previous.mapping), previous.original, previous.old, previous.expected]))
      throw new Error("The original permanent baseline identity or data changed; do not replace it to resume.");
    record.manifest = actual;
    if (["unknown", "sent"].includes(record.insertState)) record.insertState = "confirmed";
  }
}

/** Preview and validate against the live empty target; this does not send INSERT. */
export async function prepareOracleTypeDataInsert(plan: OracleTypeManagementDraft, id: string, sql: string, persist: TypeManagementExecutionOptions["persist"]): Promise<OracleTypeManagementDraft> {
  const next = clone(plan);
  const record = next.dataMappings.find((record) => record.manifest.mapping.id === id);
  if (!record || !["not-sent", "failed"].includes(record.insertState)) throw new Error("A sent INSERT needs readback, not another preview or resend.");
  const result = await api.verifyOracleTypeData({ target: next.target, action: "validate_insert", manifest: record.manifest, sql });
  if (!result.manifest?.preparedTarget || !result.insertSql) throw new Error("The complete bounded INSERT and its exact empty target were not verified.");
  if (!same([mappingIdentity(result.manifest.mapping), result.manifest.original, result.manifest.old, result.manifest.expected], [mappingIdentity(record.manifest.mapping), record.manifest.original, record.manifest.old, record.manifest.expected])) throw new Error("The registered baseline changed.");
  record.manifest = result.manifest;
  record.insertSql = result.insertSql;
  record.insertDraft = result.insertSql;
  record.insertState = "not-sent";
  next.executable = false;
  next.requiresReverify = true;
  next.revision++;
  await persist(next);
  return next;
}

/** One bounded scalar INSERT, on the normal query boundary and guarded by the
 * caller. It never drops a relation, changes the TYPE or cleans up baselines. */
export async function executeOracleTypeDataInsert(plan: OracleTypeManagementDraft, id: string, options: TypeManagementExecutionOptions): Promise<void> {
  const record = plan.dataMappings.find((record) => record.manifest.mapping.id === id);
  if (!record?.insertSql || (record.insertDraft ?? record.insertSql) !== record.insertSql || record.insertState !== "not-sent" || !record.manifest.preparedTarget) throw new Error("Preview the bounded INSERT before confirmation.");
  const checked = await api.verifyOracleTypeData({ target: plan.target, action: "validate_insert", manifest: record.manifest, sql: record.insertSql });
  const manifestState = (manifest: OracleTypeDataManifest | null | undefined) => manifest && [mappingIdentity(manifest.mapping), manifest.original, manifest.old, manifest.expected, manifest.preparedTarget ?? null, manifest.verifiedTarget ?? null];
  if (checked.insertSql !== record.insertSql || !same(manifestState(checked.manifest), manifestState(record.manifest))) throw new Error("The prepared INSERT target or statement changed. Preview it again.");
  if (options.isCurrent?.() === false) throw new Error("The data target changed before confirmation.");
  const previousState = plan.state;
  plan.state = "running";
  record.insertState = "sent";
  plan.revision++;
  try {
    await options.persist(plan);
  } catch (cause) {
    record.insertState = "not-sent";
    plan.state = previousState;
    throw cause;
  }
  if (options.isCurrent?.() === false) {
    record.insertState = "not-sent";
    plan.state = previousState;
    plan.revision++;
    await options.persist(plan);
    throw new Error("The data target changed before dispatch.");
  }
  let error: unknown;
  let rejected = false;
  try {
    const result = await api.executeQuery(plan.target.connectionId, plan.target.database, record.insertSql, record.manifest.mapping.target.owner);
    if (result.execution_error || result.messages?.some((item) => item.severity.toUpperCase() === "ERROR")) {
      rejected = true;
      throw new BackendErrorException(result.error || "The database rejected the INSERT.");
    }
  } catch (cause) {
    error = cause;
    const envelope = normalizeBackendError(cause);
    rejected ||= envelope?.operationOutcome === "not_started" || (envelope?.code === "DBX-JDBC-4001" && envelope.diagnostics?.category === "sql" && envelope.diagnostics?.stage === "execute");
  }
  try {
    const result = await api.verifyOracleTypeData({ target: plan.target, action: "verify", manifest: record.manifest });
    if (!result.manifest?.verifiedTarget) throw new Error("The complete target data has not been verified.");
    if (!same([mappingIdentity(result.manifest.mapping), result.manifest.original, result.manifest.old, result.manifest.expected], [mappingIdentity(record.manifest.mapping), record.manifest.original, record.manifest.old, record.manifest.expected]))
      throw new Error("The original baselines changed during INSERT.");
    record.manifest = result.manifest;
    record.insertState = "confirmed";
    record.message = error ? "Confirmed by complete readback after the response failed." : undefined;
  } catch (cause) {
    record.insertState = rejected ? "failed" : "unknown";
    record.message = message(error ?? cause);
  }
  plan.executable = false;
  plan.requiresReverify = true;
  plan.state = "stopped";
  plan.revision++;
  await options.persist(plan);
  if (record.insertState !== "confirmed") throw new Error(record.message);
}

/** Validate the durable record before any restored fields reach a reader. */
export function isTypeDataMappingDraft(value: unknown): value is TypeDataMappingDraft {
  if (!value || typeof value !== "object") return false;
  const record = value as TypeDataMappingDraft;
  const key = (value: unknown) => {
    const key = value as { owner: string; name: string };
    return !!key && typeof key.owner === "string" && typeof key.name === "string";
  };
  const path = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((part) => typeof part === "string" && part.length > 0);
  const baseline = (value: unknown) => {
    const baseline = value as OracleTypeDataManifest["old"];
    const relation = baseline?.relation;
    return (
      !!relation &&
      key(relation.relation) &&
      typeof relation.objectId === "string" &&
      typeof relation.structure === "string" &&
      (relation.readOnly === null || typeof relation.readOnly === "boolean") &&
      Array.isArray(relation.projection) &&
      relation.projection.length > 0 &&
      relation.projection.length <= 128 &&
      relation.projection.every((field) => field && path(field.path) && typeof field.objectNull === "boolean" && typeof field.dataType === "string") &&
      Number.isSafeInteger(baseline.rowCount) &&
      baseline.rowCount >= 0 &&
      baseline.rowCount <= 10000 &&
      typeof baseline.fingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(baseline.fingerprint)
    );
  };
  const manifest = record.manifest;
  const mapping = manifest?.mapping;
  return (
    typeof record.insertSql === "string" &&
    (record.insertDraft === undefined || typeof record.insertDraft === "string") &&
    ["not-sent", "sent", "confirmed", "failed", "unknown"].includes(record.insertState) &&
    !!mapping &&
    typeof mapping.id === "string" &&
    mapping.id.length > 0 &&
    [mapping.source, mapping.old, mapping.expected, mapping.target].every(key) &&
    Array.isArray(mapping.fields) &&
    mapping.fields.length > 0 &&
    mapping.fields.length <= 128 &&
    mapping.fields.every(
      (field) =>
        field &&
        path(field.sourcePath) &&
        path(field.targetPath) &&
        typeof field.objectNull === "boolean" &&
        (field.targetObjectNull === undefined || typeof field.targetObjectNull === "boolean") &&
        typeof field.oldColumn === "string" &&
        typeof field.expectedColumn === "string" &&
        typeof field.unchanged === "boolean",
    ) &&
    [manifest.original, manifest.old, manifest.expected].every(baseline) &&
    (manifest.preparedTarget == null || baseline(manifest.preparedTarget)) &&
    (manifest.verifiedTarget == null || baseline(manifest.verifiedTarget))
  );
}

export function isTypeDataPreparation(value: unknown): value is OracleTypeDataMappingInput {
  const mapping = value as OracleTypeDataMappingInput;
  const relation = (key: { owner: string; name: string }) => key && typeof key.owner === "string" && typeof key.name === "string";
  const path = (path: string[]) => Array.isArray(path) && path.length > 0 && path.length <= 4 && path.every((part) => typeof part === "string");
  return (
    !!mapping &&
    typeof mapping.id === "string" &&
    [mapping.source, mapping.old, mapping.expected, mapping.target].every(relation) &&
    Array.isArray(mapping.fields) &&
    mapping.fields.length <= 128 &&
    mapping.fields.every(
      (field) =>
        field &&
        path(field.sourcePath) &&
        path(field.targetPath) &&
        typeof field.objectNull === "boolean" &&
        (field.targetObjectNull === undefined || typeof field.targetObjectNull === "boolean") &&
        typeof field.oldColumn === "string" &&
        typeof field.expectedColumn === "string" &&
        typeof field.unchanged === "boolean",
    )
  );
}
