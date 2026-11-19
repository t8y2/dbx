import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { BackendErrorException, normalizeBackendError } from "@/lib/backend/errorUtils";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { isTypeDataMappingDraft, isTypeDataPreparation, registerOracleTypeDataBaseline, verifyOracleTypeDataMappings, type TypeDataMappingDraft } from "@/lib/table/oracleTypeDataMapping";
import type { OracleTypeDataMappingInput, OracleTypeEvolutionManifest, TypeExecutionBinding } from "@/types/database";
import type { DatabaseType, ObjectSourceKind, OracleTypeManagementDependency, OracleTypeManagementObject, OracleTypeManagementObjectKey, OracleTypeManagementPrivilege, OracleTypeManagementSnapshot, OracleTypeManagementSqlInput, OracleTypeManagementTarget, TypeMetadataRead } from "@/types/database";

export type TypeManagementOperation = "save-spec" | "save-body" | "delete-spec" | "delete-body";
export interface TypeManagementTarget extends OracleTypeManagementTarget {
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle" | "dameng">;
}
export interface TypeManagementIssue {
  code: string;
  message: string;
  objectKey?: string;
  repairable: boolean;
}
export interface TypeManagementObjectDraft extends OracleTypeManagementObjectKey {
  source: string;
}
export interface TypeManagementStep {
  id: string;
  kind: "drop-dependent" | "replace" | "rebuild" | "grant" | "delete" | "evolve" | "compile";
  object: OracleTypeManagementObjectKey;
  sql: string;
  sourceFingerprint?: string;
  privilege?: OracleTypeManagementPrivilege;
  nativePhase?: number;
  triggerEnabled?: boolean;
  state: "not-sent" | "sent" | "confirmed" | "failed" | "unknown";
  executionId?: string;
  databaseTerminal?: boolean;
  message?: string;
}

/** Only definitions and control records belong here, never rows from business tables. */
export interface OracleTypeManagementDraft {
  version: 1;
  planId: string;
  revision: number;
  target: TypeManagementTarget;
  operation: TypeManagementOperation;
  originalSnapshot: OracleTypeManagementSnapshot;
  lastSnapshot: OracleTypeManagementSnapshot;
  /** Read-only observation of an unresolved write; never an execution baseline. */
  observedSnapshot?: OracleTypeManagementSnapshot;
  drafts: TypeManagementObjectDraft[];
  steps: TypeManagementStep[];
  history: TypeManagementStep[];
  dataMappings: TypeDataMappingDraft[];
  dataPreparation?: OracleTypeDataMappingInput;
  dataTargetPaths?: string[];
  nativeEvolution?: OracleTypeEvolutionManifest;
  issues: TypeManagementIssue[];
  executable: boolean;
  requiresReverify: boolean;
  state: "draft" | "validated" | "running" | "stopped" | "complete";
  message?: string;
}

const sourceKinds = new Set(["TYPE", "TYPE BODY", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY", "VIEW", "TRIGGER"]);
const canonicalKind = (kind: string) => kind.replaceAll("_", " ").toUpperCase();
const sourceKind = (kind: string) => canonicalKind(kind).replaceAll(" ", "_") as ObjectSourceKind;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const complete = (read: TypeMetadataRead) => read.state === "available";
const isBody = (operation: TypeManagementOperation) => operation.endsWith("body");
const isDelete = (operation: TypeManagementOperation) => operation.startsWith("delete");

function executionBinding(plan: OracleTypeManagementDraft, step: TypeManagementStep): TypeExecutionBinding {
  return { executionId: step.executionId!, planId: plan.planId, stepId: step.id, connectionId: plan.target.connectionId, database: plan.target.database, schema: step.object.owner, sql: step.sql };
}

/** The kind and the original quoted spelling are part of the identity. */
export function typeManagementObjectKey(object: OracleTypeManagementObjectKey): string {
  return JSON.stringify([object.owner, object.name, canonicalKind(object.objectType)]);
}

function rootKey(target: TypeManagementTarget, body = false): OracleTypeManagementObjectKey {
  return { owner: target.owner, name: target.name, objectType: body ? "TYPE BODY" : "TYPE" };
}

function sameObject(a: OracleTypeManagementObjectKey, b: OracleTypeManagementObjectKey) {
  return typeManagementObjectKey(a) === typeManagementObjectKey(b);
}

function objectIn(snapshot: OracleTypeManagementSnapshot, key: OracleTypeManagementObjectKey) {
  return snapshot.objects.find((object) => sameObject(object, key));
}

function dependencyKey(edge: OracleTypeManagementDependency) {
  return JSON.stringify([edge.owner, edge.name, canonicalKind(edge.objectType), edge.referencedOwner, edge.referencedName, canonicalKind(edge.referencedType), edge.referencedLink ?? null]);
}

function ordered(values: unknown[]) {
  return values.map((value) => JSON.stringify(value)).sort();
}

function grants(privileges: OracleTypeManagementPrivilege[]) {
  return ordered(privileges.map((grant) => [grant.grantor ?? null, grant.grantee, grant.privilege, grant.grantable ?? null, grant.hierarchy ?? null, grant.privilegeType ?? null, grant.columnId ?? null]));
}

function objectDefinition(object: OracleTypeManagementObject) {
  return [object.exists ?? null, object.objectId ?? null, object.source ?? null, object.sourceFingerprint ?? null, object.sourceRead.state, grants(object.directPrivileges), object.privilegesRead.state, object.triggerEnabled ?? null, object.triggerEnabledRead?.state ?? null];
}

/** Compare the live contract, not response order or a digest of ordinary source text. */
export function typeManagementSnapshotIdentity(snapshot: OracleTypeManagementSnapshot): string {
  return JSON.stringify([
    [snapshot.target.connectionId, snapshot.target.database, snapshot.target.owner, snapshot.target.name],
    snapshot.visibilityScope,
    snapshot.actingUser ?? null,
    snapshot.actingUserRead.state,
    ordered(snapshot.objects.map((object) => [typeManagementObjectKey(object), ...objectDefinition(object), object.status ?? null, object.statusRead.state, ordered(object.errors.map((error) => [error.line, error.position, error.text])), object.errorsRead.state])),
    snapshot.dependencies.map(dependencyKey).sort(),
    snapshot.dependenciesRead.state,
    ordered(snapshot.persistentReferences.map((reference) => [reference.owner, reference.tableName, reference.columnName ?? null, reference.dataTypeOwner ?? null, reference.dataType ?? null, reference.tableReadOnly ?? null])),
    snapshot.persistentReferencesRead.state,
    grants(snapshot.directPrivileges),
    snapshot.privilegesRead.state,
  ]);
}

function knownObjects(plan: OracleTypeManagementDraft) {
  const objects = [...plan.originalSnapshot.objects, ...plan.lastSnapshot.objects, ...plan.drafts];
  return [...new Map(objects.map((object) => [typeManagementObjectKey(object), { owner: object.owner, name: object.name, objectType: canonicalKind(object.objectType) }])).values()];
}

async function readSnapshot(target: TypeManagementTarget, known: OracleTypeManagementObjectKey[] = []) {
  const snapshot = await api.getOracleTypeManagementSnapshot(target.connectionId, target.database, target.owner, target.name, known);
  if (!sameTarget(snapshot.target, target)) throw new Error("The TYPE snapshot belongs to a different target.");
  return snapshot;
}

function sameTarget(a: OracleTypeManagementTarget, b: OracleTypeManagementTarget) {
  return a.connectionId === b.connectionId && a.database === b.database && a.owner === b.owner && a.name === b.name;
}

function addIssue(plan: OracleTypeManagementDraft, code: string, message: string, object?: OracleTypeManagementObjectKey, repairable = true) {
  plan.issues.push({ code, message, objectKey: object && typeManagementObjectKey(object), repairable });
}

function requireRead(plan: OracleTypeManagementDraft, read: TypeMetadataRead, label: string, object?: OracleTypeManagementObjectKey) {
  if (!complete(read)) addIssue(plan, "incomplete-metadata", `${label}: ${read.reason || read.state}`, object);
}

function sourceOrder(plan: OracleTypeManagementDraft, objects: OracleTypeManagementObjectKey[]) {
  const byKey = new Map(objects.map((object) => [typeManagementObjectKey(object), object]));
  const precedents = new Map([...byKey.keys()].map((key) => [key, new Set<string>()]));
  for (const edge of plan.originalSnapshot.dependencies) {
    const dependent = typeManagementObjectKey(edge);
    const referenced = typeManagementObjectKey({ owner: edge.referencedOwner, name: edge.referencedName, objectType: edge.referencedType });
    if (dependent !== referenced && byKey.has(dependent) && byKey.has(referenced)) precedents.get(dependent)!.add(referenced);
  }
  for (const object of objects) {
    if (canonicalKind(object.objectType).endsWith(" BODY")) {
      const spec = typeManagementObjectKey({ ...object, objectType: canonicalKind(object.objectType).slice(0, -5) });
      if (byKey.has(spec)) precedents.get(typeManagementObjectKey(object))!.add(spec);
    }
  }
  const output: OracleTypeManagementObjectKey[] = [];
  while (precedents.size) {
    const ready = [...precedents]
      .filter(([, parents]) => !parents.size)
      .map(([key]) => key)
      .sort();
    if (!ready.length) {
      for (const key of precedents.keys()) addIssue(plan, "dependency-cycle", "The dependency cycle needs revised definitions before a rebuild order can be determined.", byKey.get(key));
      break;
    }
    for (const key of ready) {
      output.push(byKey.get(key)!);
      precedents.delete(key);
      for (const parents of precedents.values()) parents.delete(key);
    }
  }
  return output;
}

async function buildStep(plan: OracleTypeManagementDraft, object: OracleTypeManagementObjectKey, kind: TypeManagementStep["kind"], input: Omit<OracleTypeManagementSqlInput, "databaseType" | "owner" | "name">, privilege?: OracleTypeManagementPrivilege) {
  try {
    const result = await api.buildOracleTypeManagementSql({ databaseType: plan.target.databaseType, owner: object.owner, name: object.name, ...input });
    if (result.statements.length !== 1 || !result.statements[0]?.trim()) throw new Error("A TYPE step must contain one complete statement.");
    if (["replace", "rebuild", "compile"].includes(kind) && !result.sourceFingerprint) throw new Error("The complete definition could not be compared after execution.");
    const sql = result.statements[0];
    const id = JSON.stringify([kind, typeManagementObjectKey(object), sql]);
    const previous = plan.steps.find((step) => step.id === id);
    return { ...previous, id, kind, object: clone(object), sql, sourceFingerprint: result.sourceFingerprint ?? undefined, privilege: privilege && clone(privilege), triggerEnabled: input.triggerEnabled, state: previous?.state ?? "not-sent" } satisfies TypeManagementStep;
  } catch (error) {
    addIssue(plan, "invalid-definition", errorMessage(error), object);
    return null;
  }
}

function validateObject(plan: OracleTypeManagementDraft, object: OracleTypeManagementObject) {
  requireRead(plan, object.statusRead, "Object state", object);
  if (canonicalKind(object.objectType) === "TRIGGER") {
    requireRead(plan, object.triggerEnabledRead ?? { state: "unavailable" }, "Trigger enabled state", object);
    if (typeof object.triggerEnabled !== "boolean") addIssue(plan, "trigger-state", "Read the exact ENABLED/DISABLED trigger state before rebuilding this dependency.", object);
  }
  if (!sourceKinds.has(canonicalKind(object.objectType))) {
    addIssue(plan, "unsupported-dependency", "This dependency needs preparation in the SQL editor; its original identity remains in this plan.", object);
    return;
  }
  requireRead(plan, object.sourceRead, "Complete source", object);
  if (complete(object.sourceRead) && object.exists !== false && !object.source) addIssue(plan, "missing-source", "The original definition is unavailable. Supply a complete definition and verify its identity.", object);
}

function restoreGrantIssue(plan: OracleTypeManagementDraft, object: OracleTypeManagementObject, privilege: OracleTypeManagementPrivilege) {
  if (
    !complete(plan.lastSnapshot.actingUserRead) ||
    privilege.grantor !== plan.lastSnapshot.actingUser ||
    privilege.grantor !== object.owner ||
    privilege.grantable == null ||
    privilege.hierarchy !== false ||
    !["EXECUTE", "DEBUG", "UNDER"].includes(privilege.privilege) ||
    (plan.target.databaseType === "dameng" && privilege.privilege !== "EXECUTE")
  ) {
    addIssue(plan, "grant-authority", "This direct grant needs its original grantor and verified grant options restored before automatic dependency removal.", object);
    return true;
  }
  return false;
}

/** Preparing never sends SQL. A repairable plan retains every draft and generated step. */
export async function prepareOracleTypeManagement(target: TypeManagementTarget, operation: TypeManagementOperation, drafts: TypeManagementObjectDraft[] = [], previous?: OracleTypeManagementDraft): Promise<OracleTypeManagementDraft> {
  if (previous && (!sameTarget(previous.target, target) || previous.target.databaseType !== target.databaseType || previous.operation !== operation)) throw new Error("A recovery plan cannot be rebound to a different TYPE target.");
  const recoveringSteps = clone(previous?.steps ?? []);
  for (const step of recoveringSteps) {
    if (!["sent", "unknown"].includes(step.state) || !step.executionId || step.databaseTerminal) continue;
    try {
      const completion = await api.cancelConditionalUpdate(step.executionId, { cancel: false, typeRecovery: executionBinding(previous!, step) });
      step.databaseTerminal = completion.terminal && completion.databaseTerminal === true;
    } catch {
      // A failed status read is not proof that the original DDL has stopped.
      step.databaseTerminal = false;
    }
  }
  // Never use a snapshot taken before the original execution finished.
  const actual = await readSnapshot(target, previous ? knownObjects(previous) : []);
  const started = previous?.steps.some((step) => step.state !== "not-sent") === true || !!previous?.dataMappings?.length;
  const plan: OracleTypeManagementDraft = {
    version: 1,
    planId: previous?.planId ?? uuid(),
    revision: (previous?.revision ?? 0) + 1,
    target: clone(target),
    operation,
    originalSnapshot: clone(started ? previous!.originalSnapshot : actual),
    lastSnapshot: clone(actual),
    drafts: clone(drafts),
    steps: recoveringSteps,
    history: clone(previous?.history ?? []),
    dataMappings: clone(previous?.dataMappings ?? []),
    dataPreparation: previous?.dataPreparation && clone(previous.dataPreparation),
    dataTargetPaths: previous?.dataTargetPaths && clone(previous.dataTargetPaths),
    nativeEvolution: started && previous?.nativeEvolution ? clone(previous.nativeEvolution) : undefined,
    issues: [],
    executable: false,
    requiresReverify: false,
    state: "draft",
  };
  const selected = rootKey(target, isBody(operation));
  const selectedObject = objectIn(actual, selected);
  if (!selectedObject) addIssue(plan, "missing-target", "The exact TYPE target could not be read.", selected);
  else requireRead(plan, selectedObject.statusRead, "Target state", selected);
  const originalSelected = objectIn(plan.originalSnapshot, selected);
  if (!originalSelected || originalSelected.exists !== true) addIssue(plan, "missing-target", "The original TYPE target was not verified as existing.", selected);
  else {
    requireRead(plan, originalSelected.sourceRead, "Original target source", selected);
    requireRead(plan, originalSelected.statusRead, "Original target identity", selected);
  }
  if (new Set(plan.drafts.map(typeManagementObjectKey)).size !== plan.drafts.length) addIssue(plan, "duplicate-draft", "Keep one definition for each exact owner, name, and object kind.");
  if (plan.dataMappings.length) {
    try {
      await verifyOracleTypeDataMappings(plan);
    } catch (error) {
      addIssue(plan, "persistent-data", errorMessage(error));
    }
  }
  const verifiedMapping = (object: OracleTypeManagementObjectKey) =>
    !plan.issues.some((issue) => issue.code === "persistent-data") && object.objectType === "TABLE" && plan.dataMappings.some((record) => record.manifest.verifiedTarget && record.manifest.mapping.source.owner === object.owner && record.manifest.mapping.source.name === object.name);
  if (target.databaseType === "oracle" && operation === "save-spec" && !plan.dataMappings.length && (plan.originalSnapshot.persistentReferences.length || plan.nativeEvolution)) {
    const rootDraft = plan.drafts.find((draft) => sameObject(draft, selected));
    try {
      if (!rootDraft || !originalSelected?.source) throw new Error("Supply the complete original and target TYPE specification for native evolution.");
      const manifest = started ? previous?.nativeEvolution : undefined;
      if (manifest && rootDraft.source !== manifest.sourceAfter) throw new Error("A dispatched native evolution must retain its approved specification. Reconcile the existing phases before starting another change.");
      const next = await api.prepareOracleTypeEvolution({ target, sourceBefore: originalSelected.source, sourceAfter: rootDraft.source, manifest });
      if (!validNativeManifest(next) || !sameTarget(next.target, target) || next.sourceBefore !== originalSelected.source || next.sourceAfter !== rootDraft.source || (manifest && nativeIdentity(next) !== nativeIdentity(manifest)))
        throw new Error("The native evolution preview changed its original target or guards.");
      if (manifest && next.phase !== manifest.phase && !previous!.steps.some((step) => step.kind === "evolve" && ["sent", "unknown", "confirmed"].includes(step.state) && step.nativePhase === next.phase))
        throw new Error("A native evolution phase changed without a recorded dispatch. Reconcile the actual TYPE before continuing.");
      plan.nativeEvolution = next;
    } catch (error) {
      addIssue(plan, "native-evolution", errorMessage(error), selected);
    }
  }
  // A sent or unknown request must first be reconciled, never turned into a new write.
  for (const step of plan.steps) {
    if (step.state !== "sent" && step.state !== "unknown") continue;
    try {
      if (step.executionId && !step.databaseTerminal) throw new Error("The original database execution has not been confirmed as finished. Keep this plan and read it again after completion.");
      assertNoUnapprovedChange(previous!.lastSnapshot, actual, step, plan.originalSnapshot);
      if (stepSatisfied(actual, step, plan.nativeEvolution)) {
        step.state = "confirmed";
        step.message = "Confirmed by fresh readback.";
      } else if (stepWrittenInvalid(actual, step)) {
        step.state = "failed";
        step.message = [step.message, invalidDefinitionMessage(objectIn(actual, step.object)!)].filter(Boolean).join("\n");
      } else throw new Error("A previously sent step is not yet verified. Read back its result; do not resend it.");
    } catch (error) {
      addIssue(plan, "unknown-result", errorMessage(error), step.object);
    }
  }
  if (previous && started) {
    for (const object of previous.lastSnapshot.objects) {
      const current = objectIn(actual, object);
      if (verifiedMapping(object)) continue; // external preparation was verified against the original permanent baselines
      if (current && JSON.stringify(objectDefinition(current)) === JSON.stringify(objectDefinition(object))) continue;
      const approved = plan.steps.some(
        (step) =>
          step.state !== "not-sent" &&
          (stepSatisfied(actual, step, plan.nativeEvolution) || stepWrittenInvalid(actual, step)) &&
          (sameObject(step.object, object) || ((step.kind === "delete" || step.kind === "drop-dependent") && step.object.objectType === "TYPE" && object.objectType === "TYPE BODY" && step.object.owner === object.owner && step.object.name === object.name && current?.exists === false)),
      );
      if (!approved) addIssue(plan, "definition-changed", "This object's definition, identity, or grants changed after the last recorded state. Review the live definition before starting a replacement plan.", object);
    }
  }

  if (plan.steps.some((step) => step.state === "sent" || step.state === "unknown")) {
    // Keep active execution identities even when the user has edited their drafts.
    // Replacing these with newly generated steps would lose the no-replay guard.
    plan.requiresReverify = true;
    plan.observedSnapshot = clone(actual);
    plan.lastSnapshot = clone(previous!.lastSnapshot);
    return plan;
  }
  const priorSteps = plan.steps;
  const generated: TypeManagementStep[] = [];
  const push = (step: TypeManagementStep | null) => {
    if (step) generated.push(step);
  };

  if (isBody(operation)) {
    const root = objectIn(actual, rootKey(target));
    if (root?.exists !== true || !complete(root.statusRead)) addIssue(plan, "missing-specification", "The TYPE specification must still exist and have a verified identity.", rootKey(target));
    if (operation === "delete-body") {
      requireRead(plan, actual.dependenciesRead, "Deletion impact");
      push(await buildStep(plan, selected, "delete", { operation: "drop_body" }));
    } else {
      const draft = plan.drafts.find((item) => sameObject(item, selected));
      if (!draft) addIssue(plan, "missing-draft", "Supply the exact TYPE BODY definition.", selected);
      else push(await buildStep(plan, selected, "replace", { operation: "save_body", source: draft.source }));
    }
  } else {
    requireRead(plan, actual.dependenciesRead, "Dependency closure");
    requireRead(plan, actual.persistentReferencesRead, "Persistent TYPE references");
    const unverifiedTables = plan.originalSnapshot.persistentReferences.filter((reference) => !verifiedMapping({ owner: reference.owner, name: reference.tableName, objectType: "TABLE" }));
    if (!plan.nativeEvolution && (unverifiedTables.length || actual.persistentReferences.length))
      addIssue(plan, "persistent-mapping", "Register permanent OLD/EXPECTED before external preparation. Verify complete target data and remove live TYPE references in the SQL editor, then revalidate this same plan.");
    for (const edge of plan.originalSnapshot.dependencies) {
      if (edge.referencedLink) addIssue(plan, "database-link", "A remote dependency cannot be included in an automatic local rebuild.", edge);
    }
    const originals = plan.originalSnapshot.objects.filter((object) => object.exists === true && !verifiedMapping(object) && !(plan.nativeEvolution && object.objectType === "TABLE"));
    if (plan.originalSnapshot.objects.length > 500) addIssue(plan, "closure-limit", "The TYPE recovery snapshot exceeds the 500-object limit. Reduce the dependency closure before automatic changes.");
    for (const object of originals) {
      validateObject(plan, object);
      if (!plan.drafts.some((draft) => sameObject(draft, object)) && sourceKinds.has(canonicalKind(object.objectType))) plan.drafts.push({ owner: object.owner, name: object.name, objectType: object.objectType, source: object.source ?? "" });
    }
    const order = sourceOrder(plan, originals);
    const dependentTypes = order.filter((object) => canonicalKind(object.objectType) === "TYPE" && !sameObject(object, selected));
    for (const key of plan.nativeEvolution ? [] : dependentTypes) {
      const object = objectIn(plan.originalSnapshot, key)!;
      requireRead(plan, object.privilegesRead, "Direct grants", object);
      for (const privilege of object.directPrivileges) restoreGrantIssue(plan, object, privilege);
    }
    for (const object of plan.nativeEvolution ? [] : dependentTypes.slice().reverse()) push(await buildStep(plan, object, "drop-dependent", { operation: "drop_spec" }));
    if (plan.nativeEvolution) {
      plan.nativeEvolution.statements.forEach((sql, index) => {
        const id = JSON.stringify(["evolve", typeManagementObjectKey(selected), sql]);
        const previous = plan.steps.find((step) => step.id === id);
        push({ ...previous, id, kind: "evolve", object: clone(selected), sql, nativePhase: index + 1, state: previous?.state ?? "not-sent" });
      });
    } else if (!isDelete(operation)) {
      const draft = plan.drafts.find((item) => sameObject(item, selected));
      if (!draft) addIssue(plan, "missing-draft", "Supply the exact TYPE specification.", selected);
      else push(await buildStep(plan, selected, "replace", { operation: "save_spec", source: draft.source }));
    }
    for (const object of order) {
      if (sameObject(object, selected) || (isDelete(operation) && sameObject(object, rootKey(target, true)))) continue;
      const draft = plan.drafts.find((item) => sameObject(item, object));
      if (!draft) continue;
      if (isDelete(operation)) {
        const directlyReferencesRoot = plan.originalSnapshot.dependencies.some((edge) => sameObject(edge, object) && edge.referencedOwner === target.owner && edge.referencedName === target.name && canonicalKind(edge.referencedType) === "TYPE");
        const original = objectIn(plan.originalSnapshot, object)!;
        if (directlyReferencesRoot && draft.source === original.source) addIssue(plan, "unlink-required", "Revise this definition to use the chosen replacement TYPE, then revalidate. The original TYPE will be dropped only after live references are removed.", object);
      }
      if (plan.nativeEvolution && object.objectType === "TYPE") {
        const step = await buildStep(plan, object, "compile", { operation: "compile_spec", source: draft.source });
        if (step && step.sourceFingerprint !== objectIn(plan.originalSnapshot, object)?.sourceFingerprint) addIssue(plan, "native-dependent-edit", "Keep this dependent TYPE specification unchanged for native compilation. Evolve its structure in a separate verified plan.", object);
        push(step);
      } else {
        const original = objectIn(plan.originalSnapshot, object)!;
        const unchangedTrigger = object.objectType === "TRIGGER" && draft.source === original.source;
        push(
          await buildStep(plan, object, unchangedTrigger ? "compile" : "rebuild", {
            operation: unchangedTrigger ? "compile_trigger" : "rebuild_source",
            objectType: sourceKind(object.objectType),
            source: draft.source,
            triggerEnabled: object.objectType === "TRIGGER" ? (original.triggerEnabled ?? undefined) : undefined,
          }),
        );
      }
      if (!plan.nativeEvolution && canonicalKind(object.objectType) === "TYPE") {
        const original = objectIn(plan.originalSnapshot, object)!;
        for (const privilege of original.directPrivileges) {
          if (!plan.issues.some((issue) => issue.code === "grant-authority" && issue.objectKey === typeManagementObjectKey(object)))
            push(await buildStep(plan, object, "grant", { operation: "grant_privilege", grantee: privilege.grantee, grantable: privilege.grantable!, privilege: privilege.privilege }, privilege));
        }
      }
    }
    if (isDelete(operation)) push(await buildStep(plan, selected, "delete", { operation: "drop_spec" }));
  }

  // Keep failed diagnostics before revalidation resets the step, and sent history when drafts change.
  for (const step of priorSteps.filter((step) => step.state !== "not-sent")) {
    const changed = !generated.some((candidate) => candidate.id === step.id);
    if (step.state === "failed" || (changed && !plan.history.some((attempt) => attempt.id === step.id))) plan.history.push(clone(step));
    if (changed && step.state !== "failed") addIssue(plan, "changed-sent-step", "A sent definition changed. Verify the original step before replacing its draft.", step.object);
  }
  plan.steps = generated;
  for (const step of plan.steps) {
    if (step.state === "confirmed" && !stepStillSatisfied(actual, step, plan.steps, plan.nativeEvolution)) addIssue(plan, "confirmed-step-changed", "A confirmed result no longer matches the approved definition. Review the actual state before continuing.", step.object);
    if (step.state === "failed") {
      step.state = "not-sent"; // a verified failure is retryable only after fresh confirmation
      delete step.executionId;
      delete step.databaseTerminal;
    }
  }
  plan.executable = !plan.issues.length;
  plan.state = plan.executable ? (plan.steps.every((step) => step.state === "confirmed") ? "complete" : "validated") : "draft";
  return plan;
}

function stepSatisfied(snapshot: OracleTypeManagementSnapshot, step: TypeManagementStep, native?: OracleTypeEvolutionManifest) {
  const object = objectIn(snapshot, step.object);
  if (!object || !complete(object.statusRead)) return false;
  if (step.kind === "delete" || step.kind === "drop-dependent") return object.exists === false;
  if (step.kind === "grant") return complete(object.privilegesRead) && object.directPrivileges.some((privilege) => grants([privilege])[0] === grants([step.privilege!])[0]);
  if (step.object.objectType === "TRIGGER" && (typeof step.triggerEnabled !== "boolean" || object.triggerEnabled !== step.triggerEnabled || !complete(object.triggerEnabledRead ?? { state: "unavailable" }))) return false;
  if (step.kind === "evolve") return !!native && !!step.nativePhase && native.phase >= step.nativePhase && object.exists === true && object.status === "VALID" && complete(object.sourceRead) && complete(object.errorsRead) && !object.errors.length;
  return object.exists === true && object.status === "VALID" && complete(object.sourceRead) && complete(object.errorsRead) && !object.errors.length && object.sourceFingerprint === step.sourceFingerprint;
}

function stepWrittenInvalid(snapshot: OracleTypeManagementSnapshot, step: TypeManagementStep) {
  const object = objectIn(snapshot, step.object);
  return (
    step.databaseTerminal === true &&
    ["replace", "rebuild", "compile"].includes(step.kind) &&
    !!step.sourceFingerprint &&
    object?.exists === true &&
    object.status === "INVALID" &&
    complete(object.statusRead) &&
    complete(object.sourceRead) &&
    complete(object.errorsRead) &&
    object.sourceFingerprint === step.sourceFingerprint &&
    (step.object.objectType !== "TRIGGER" || (typeof step.triggerEnabled === "boolean" && object.triggerEnabled === step.triggerEnabled && complete(object.triggerEnabledRead ?? { state: "unavailable" })))
  );
}

function invalidDefinitionMessage(object: OracleTypeManagementObject) {
  return `Written, but INVALID. ${object.errors.map((error) => `${error.line}:${error.position} ${error.text}`).join(" ") || "The error dictionary returned no diagnostics."}`;
}

function stepStillSatisfied(snapshot: OracleTypeManagementSnapshot, step: TypeManagementStep, steps: TypeManagementStep[], native?: OracleTypeEvolutionManifest) {
  if (step.kind === "drop-dependent") {
    const rebuild = steps.find((candidate) => sameObject(candidate.object, step.object) && candidate.kind === "rebuild");
    if (rebuild && rebuild.state !== "not-sent") {
      const actual = objectIn(snapshot, step.object);
      return actual?.exists === false || (complete(actual?.sourceRead ?? { state: "unavailable" }) && actual?.sourceFingerprint === rebuild.sourceFingerprint);
    }
  }
  // A later specification replacement may invalidate a BODY which is still awaiting its planned rebuild.
  return stepSatisfied(snapshot, step, native);
}

function assertNoUnapprovedChange(before: OracleTypeManagementSnapshot, after: OracleTypeManagementSnapshot, step: TypeManagementStep, original: OracleTypeManagementSnapshot) {
  if ((complete(before.dependenciesRead) && !complete(after.dependenciesRead)) || (complete(before.persistentReferencesRead) && !complete(after.persistentReferencesRead))) throw new Error("Dependency or persistent-reference readback is incomplete. Verify the applied step before continuing.");
  if (["replace", "rebuild", "compile", "evolve"].includes(step.kind)) {
    const old = objectIn(before, step.object);
    const actual = objectIn(after, step.object);
    if (!old || !actual || grants(old.directPrivileges).join() !== grants(actual.directPrivileges).join() || old.privilegesRead.state !== actual.privilegesRead.state) throw new Error("The source replacement did not preserve direct grants.");
  }
  if (step.kind === "grant") {
    const old = objectIn(before, step.object);
    const actual = objectIn(after, step.object);
    const expected = new Set(grants([...(old?.directPrivileges ?? []), step.privilege!]));
    const observed = JSON.stringify(grants(actual?.directPrivileges ?? []));
    const approved = [JSON.stringify(grants(old?.directPrivileges ?? [])), JSON.stringify([...expected].sort())];
    if (!old || !actual || old.exists !== actual.exists || old.objectId !== actual.objectId || old.source !== actual.source || !complete(actual.privilegesRead) || !approved.includes(observed)) throw new Error("The grant readback contains an unapproved identity, definition, or grant change.");
  }
  for (const object of before.objects) {
    if (sameObject(object, step.object)) continue;
    if ((step.kind === "delete" || step.kind === "drop-dependent") && step.object.objectType === "TYPE" && object.objectType === "TYPE BODY" && object.owner === step.object.owner && object.name === step.object.name) continue;
    const actual = objectIn(after, object);
    if (!actual || JSON.stringify(objectDefinition(actual)) !== JSON.stringify(objectDefinition(object))) throw new Error(`${object.objectType} ${object.owner}.${object.name} changed outside the approved step.`);
  }
  // Restoring a removed TYPE can make its old caller edges visible again.
  const oldEdges = new Set([...before.dependencies, ...original.dependencies].map(dependencyKey));
  if (after.dependencies.some((edge) => !oldEdges.has(dependencyKey(edge)) && !sameObject(edge, step.object))) throw new Error("A new dependency appeared outside the approved step.");
  if (JSON.stringify(ordered(after.persistentReferences)) !== JSON.stringify(ordered(before.persistentReferences))) throw new Error("Persistent TYPE references changed during execution.");
}

export interface TypeManagementExecutionOptions {
  /** Must save this exact revision through app_state and read it back, or reject. */
  persist: (draft: OracleTypeManagementDraft) => Promise<void>;
  /** Relevant only before dispatch. Confirmed writes stay bound to their original target. */
  isCurrent?: () => boolean;
  shouldStop?: () => boolean;
}

export async function registerOracleTypeDataMapping(plan: OracleTypeManagementDraft, mapping: OracleTypeDataMappingInput, persist: TypeManagementExecutionOptions["persist"]): Promise<OracleTypeManagementDraft> {
  const assertOriginal = async () => {
    const actual = await readSnapshot(plan.target, knownObjects(plan));
    if (typeManagementSnapshotIdentity(actual) !== typeManagementSnapshotIdentity(plan.lastSnapshot)) throw new Error("TYPE metadata changed before baseline registration. Revalidate the preview before preparing permanent baselines.");
  };
  await assertOriginal();
  return registerOracleTypeDataBaseline(plan, mapping, async (record) => {
    await assertOriginal();
    await persist(record);
  });
}

export class OracleTypeManagementFailure extends Error {
  constructor(
    public readonly plan: OracleTypeManagementDraft,
    cause: unknown,
  ) {
    super(errorMessage(cause));
  }
}

function nativeIdentity(value: OracleTypeEvolutionManifest) {
  return JSON.stringify([[value.target.connectionId, value.target.database, value.target.owner, value.target.name], value.sourceBefore, value.sourceAfter, value.statements, value.metadata]);
}
function validNativeManifest(value: OracleTypeEvolutionManifest) {
  return (
    !!value &&
    !!value.target &&
    [value.target.connectionId, value.target.database, value.target.owner, value.target.name, value.sourceBefore, value.sourceAfter, value.metadata].every((part) => typeof part === "string" && part.length > 0) &&
    Array.isArray(value.statements) &&
    value.statements.length <= 2 &&
    value.statements.every((sql) => typeof sql === "string" && sql.length > 0) &&
    Number.isSafeInteger(value.phase) &&
    value.phase >= 0 &&
    value.phase <= value.statements.length
  );
}
async function refreshNative(plan: OracleTypeManagementDraft, allowedPhases: number[]) {
  const manifest = plan.nativeEvolution;
  if (!manifest) return;
  const actual = await api.prepareOracleTypeEvolution({ target: plan.target, sourceBefore: manifest.sourceBefore, sourceAfter: manifest.sourceAfter, manifest });
  if (!validNativeManifest(actual) || nativeIdentity(actual) !== nativeIdentity(manifest) || !allowedPhases.includes(actual.phase)) throw new Error("The native evolution phase, table identity, counts or restrictions changed outside the approved step.");
  plan.nativeEvolution = actual;
}

/** Each DDL uses the existing session boundary. No transaction or rollback is promised. */
export async function executeOracleTypeManagement(plan: OracleTypeManagementDraft, options: TypeManagementExecutionOptions): Promise<OracleTypeManagementDraft> {
  if (!plan.executable || plan.requiresReverify || plan.state === "complete") throw new Error("Revalidate the TYPE plan before execution.");
  if (options.isCurrent?.() === false) throw new Error("The TYPE target or draft changed before confirmation.");
  const frozen = freezeSourceIdentities(knownObjects(plan).map((object) => ({ connectionId: plan.target.connectionId, database: plan.target.database, schema: object.owner, name: object.name, objectType: sourceKind(object.objectType) })));
  let dispatched = false;
  plan.state = "running";
  try {
    const initial = await readSnapshot(plan.target, knownObjects(plan));
    if (typeManagementSnapshotIdentity(initial) !== typeManagementSnapshotIdentity(plan.lastSnapshot)) throw new Error("TYPE definitions, dependencies, or grants changed. Revalidate the preview.");
    await refreshNative(plan, [plan.nativeEvolution?.phase ?? 0]);
    for (const step of plan.steps) {
      if (step.state === "confirmed") continue;
      if (step.state !== "not-sent") throw new Error("A previously sent step needs readback, not another execution.");
      if (options.shouldStop?.()) throw new Error("Stopped before the next step; confirmed DDL remains applied.");
      if (!dispatched && options.isCurrent?.() === false) throw new Error("The TYPE target or draft changed before dispatch.");
      const before = await readSnapshot(plan.target, knownObjects(plan));
      if (typeManagementSnapshotIdentity(before) !== typeManagementSnapshotIdentity(plan.lastSnapshot)) throw new Error("TYPE metadata changed before the next step. Revalidate the remaining plan.");
      await refreshNative(plan, [plan.nativeEvolution?.phase ?? 0]);
      await verifyOracleTypeDataMappings(plan);
      if (step.kind === "delete" && step.object.objectType === "TYPE") {
        if (!complete(before.dependenciesRead) || !complete(before.persistentReferencesRead) || before.persistentReferences.length) throw new Error("Verify all persistent references before deleting the TYPE.");
        const references = before.dependencies.filter(
          (edge) => edge.referencedOwner === step.object.owner && edge.referencedName === step.object.name && canonicalKind(edge.referencedType) === "TYPE" && !(edge.owner === step.object.owner && edge.name === step.object.name && ["TYPE", "TYPE BODY"].includes(canonicalKind(edge.objectType))),
        );
        if (references.length) throw new Error("The TYPE still has live dependents. Revise their definitions and revalidate before DROP.");
      }
      plan.revision++;
      step.state = "sent";
      step.executionId = uuid();
      step.databaseTerminal = false;
      try {
        await options.persist(plan);
      } catch (error) {
        step.state = "not-sent";
        throw error;
      }
      if (!dispatched && options.isCurrent?.() === false) {
        step.state = "not-sent";
        throw new Error("The TYPE target or draft changed before dispatch.");
      }
      frozen.markDispatched();
      dispatched = true;
      let executionError: unknown;
      let rejected = false;
      try {
        const result = await api.executeConditionalUpdate(plan.target.connectionId, plan.target.database, step.sql, step.object.owner, step.executionId, { typeRecovery: { planId: plan.planId, stepId: step.id } });
        step.databaseTerminal = true;
        if (result.execution_error || result.messages?.some((message) => message.severity.toUpperCase() === "ERROR")) {
          rejected = true;
          throw new BackendErrorException(result.error || "The database rejected the TYPE statement.");
        }
      } catch (error) {
        executionError = error;
        const envelope = normalizeBackendError(error);
        // A terminal, typed execute rejection can be reviewed and retried. Fetch,
        // timeout and legacy text errors do not prove that the DDL has stopped.
        rejected ||= envelope?.operationOutcome === "not_started" || (envelope?.code === "DBX-JDBC-4001" && envelope.diagnostics?.category === "sql" && envelope.diagnostics?.stage === "execute");
        step.databaseTerminal ||= rejected;
      }
      if (!step.databaseTerminal) {
        try {
          const completion = await api.cancelConditionalUpdate(step.executionId, { cancel: false, typeRecovery: executionBinding(plan, step) });
          step.databaseTerminal = completion.terminal && completion.databaseTerminal === true;
        } catch {
          // Keep the original execution unknown when its completion cannot be read.
        }
      }
      try {
        const after = await readSnapshot(plan.target, knownObjects(plan));
        await refreshNative(plan, step.kind === "evolve" ? [plan.nativeEvolution!.phase, step.nativePhase!] : [plan.nativeEvolution?.phase ?? 0]);
        const satisfied = step.databaseTerminal && stepSatisfied(after, step, plan.nativeEvolution);
        assertNoUnapprovedChange(before, after, step, plan.originalSnapshot);
        await verifyOracleTypeDataMappings(plan);
        plan.lastSnapshot = clone(after);
        if (!satisfied) {
          const object = objectIn(after, step.object);
          const original = objectIn(before, step.object);
          const unchanged = object && original && JSON.stringify(objectDefinition(object)) === JSON.stringify(objectDefinition(original));
          const writtenInvalid = stepWrittenInvalid(after, step);
          // A different VALID definition, or a success without its expected
          // effect, is not a retryable rejection. Reconcile it before any send.
          step.state = writtenInvalid || (rejected && unchanged) ? "failed" : "unknown";
          step.message = executionError
            ? [errorMessage(executionError), writtenInvalid ? invalidDefinitionMessage(object!) : undefined].filter(Boolean).join("\n")
            : object?.status === "INVALID"
              ? invalidDefinitionMessage(object)
              : "The write result has not been verified against the approved definition.";
          throw new Error(step.message);
        }
        step.state = "confirmed";
        step.message = [executionError ? "Confirmed by readback after the response failed." : undefined, objectIn(after, step.object)?.errorsRead.reason].filter(Boolean).join("\n") || undefined;
        plan.revision++;
        await options.persist(plan);
      } catch (error) {
        if (step.state === "sent") step.state = "unknown";
        step.message ||= errorMessage(error);
        throw error;
      }
    }
    if (!plan.steps.every((step) => stepStillSatisfied(plan.lastSnapshot, step, plan.steps, plan.nativeEvolution))) throw new Error("A completed definition or grant no longer matches the approved TYPE plan. Read back before continuing.");
    plan.state = "complete";
    plan.executable = false;
    plan.revision++;
    await options.persist(plan);
    return plan;
  } catch (error) {
    plan.state = "stopped";
    plan.executable = false;
    plan.requiresReverify = true;
    plan.message = errorMessage(error);
    plan.revision++;
    try {
      await options.persist(plan);
    } catch (persistError) {
      plan.message += ` Recovery record was not saved: ${errorMessage(persistError)}`;
    }
    throw new OracleTypeManagementFailure(plan, error);
  } finally {
    if (!dispatched) frozen.cancel();
    else {
      frozen.finish();
      const affected = knownObjects(plan);
      for (const owner of new Set(affected.map((object) => object.owner))) invalidateObjectBrowserRowsCache({ connectionId: plan.target.connectionId, database: plan.target.database, schema: owner });
      await Promise.allSettled(
        affected.flatMap((object) => {
          const scope = { connectionId: plan.target.connectionId, database: plan.target.database, schema: object.owner, tableName: object.name };
          return [invalidateObjectDdlCache(scope), invalidateObjectMetadataCache(scope)];
        }),
      );
    }
  }
}

/** Restored SQL is a draft, never executable authority. Fresh preparation rebuilds every statement. */
export function restoreOracleTypeManagementDraft(value: unknown): OracleTypeManagementDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const draft = value as OracleTypeManagementDraft;
  const target = draft.target;
  const validKey = (object: OracleTypeManagementObjectKey) => object && typeof object.owner === "string" && typeof object.name === "string" && typeof object.objectType === "string";
  const optionalString = (value: unknown) => value == null || typeof value === "string";
  const validRead = (read: TypeMetadataRead) => read && ["available", "incomplete", "unavailable", "unsupported"].includes(read.state) && optionalString(read.reason);
  const validGrant = (grant: OracleTypeManagementPrivilege) =>
    grant && typeof grant.grantee === "string" && typeof grant.privilege === "string" && optionalString(grant.grantor) && (grant.grantable == null || typeof grant.grantable === "boolean") && (grant.hierarchy == null || typeof grant.hierarchy === "boolean");
  const validObject = (object: OracleTypeManagementObject) =>
    validKey(object) &&
    (object.exists == null || typeof object.exists === "boolean") &&
    optionalString(object.objectId) &&
    optionalString(object.status) &&
    (object.triggerEnabled == null || typeof object.triggerEnabled === "boolean") &&
    (object.triggerEnabledRead == null || validRead(object.triggerEnabledRead)) &&
    optionalString(object.source) &&
    optionalString(object.sourceFingerprint) &&
    [object.sourceRead, object.statusRead, object.errorsRead, object.privilegesRead].every(validRead) &&
    Array.isArray(object.errors) &&
    object.errors.every((error) => Number.isSafeInteger(error.line) && error.line >= 0 && Number.isSafeInteger(error.position) && error.position >= 0 && typeof error.text === "string") &&
    Array.isArray(object.directPrivileges) &&
    object.directPrivileges.every(validGrant);
  const validSnapshot = (snapshot: OracleTypeManagementSnapshot) =>
    snapshot &&
    typeof snapshot.visibilityScope === "string" &&
    optionalString(snapshot.actingUser) &&
    [snapshot.actingUserRead, snapshot.detailsRead, snapshot.typeSourceRead, snapshot.bodySourceRead, snapshot.dependenciesRead, snapshot.persistentReferencesRead, snapshot.privilegesRead].every(validRead) &&
    Array.isArray(snapshot.objects) &&
    snapshot.objects.every(validObject) &&
    new Set(snapshot.objects.map(typeManagementObjectKey)).size === snapshot.objects.length &&
    Array.isArray(snapshot.dependencies) &&
    snapshot.dependencies.every((edge) => validKey(edge) && typeof edge.referencedOwner === "string" && typeof edge.referencedName === "string" && typeof edge.referencedType === "string" && optionalString(edge.referencedLink)) &&
    Array.isArray(snapshot.persistentReferences) &&
    snapshot.persistentReferences.every((reference) => reference && typeof reference.owner === "string" && typeof reference.tableName === "string") &&
    Array.isArray(snapshot.directPrivileges) &&
    snapshot.directPrivileges.every(validGrant) &&
    snapshot.target &&
    sameTarget(snapshot.target, target);
  const validStep = (step: TypeManagementStep) =>
    step &&
    validKey(step.object) &&
    typeof step.id === "string" &&
    typeof step.sql === "string" &&
    ["drop-dependent", "replace", "rebuild", "grant", "delete", "evolve", "compile"].includes(step.kind) &&
    ["not-sent", "sent", "confirmed", "failed", "unknown"].includes(step.state) &&
    optionalString(step.sourceFingerprint) &&
    optionalString(step.executionId) &&
    (step.databaseTerminal === undefined || typeof step.databaseTerminal === "boolean") &&
    (step.databaseTerminal !== true || !!step.executionId) &&
    (step.triggerEnabled === undefined || typeof step.triggerEnabled === "boolean") &&
    (step.kind !== "evolve" || (Number.isSafeInteger(step.nativePhase) && step.nativePhase! > 0 && step.nativePhase! <= 2)) &&
    (step.kind !== "grant" || validGrant(step.privilege!));
  if (
    draft.version !== 1 ||
    typeof draft.planId !== "string" ||
    !draft.planId ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    !target ||
    !["oracle", "oceanbase-oracle", "dameng"].includes(target.databaseType) ||
    ![target.connectionId, target.database, target.owner, target.name].every((part) => typeof part === "string") ||
    !["save-spec", "save-body", "delete-spec", "delete-body"].includes(draft.operation)
  )
    return undefined;
  if (![draft.originalSnapshot, draft.lastSnapshot].every(validSnapshot)) return undefined;
  if (draft.observedSnapshot !== undefined && !validSnapshot(draft.observedSnapshot)) return undefined;
  if (!Array.isArray(draft.drafts) || !draft.drafts.every((object) => validKey(object) && typeof object.source === "string") || !Array.isArray(draft.steps) || !draft.steps.every(validStep) || (draft.history !== undefined && (!Array.isArray(draft.history) || !draft.history.every(validStep))))
    return undefined;
  if (draft.dataMappings !== undefined && (!Array.isArray(draft.dataMappings) || !draft.dataMappings.every(isTypeDataMappingDraft) || new Set(draft.dataMappings.map((record) => record.manifest.mapping.id)).size !== draft.dataMappings.length)) return undefined;
  if (draft.dataPreparation !== undefined && !isTypeDataPreparation(draft.dataPreparation)) return undefined;
  if (draft.dataTargetPaths !== undefined && (!Array.isArray(draft.dataTargetPaths) || draft.dataTargetPaths.length > 128 || !draft.dataTargetPaths.every((value) => typeof value === "string"))) return undefined;
  if (draft.nativeEvolution !== undefined && (!validNativeManifest(draft.nativeEvolution) || !sameTarget(draft.nativeEvolution.target, target) || target.databaseType !== "oracle" || draft.operation !== "save-spec" || draft.dataMappings?.length)) return undefined;
  const restored = clone(draft);
  restored.history ??= [];
  restored.dataMappings ??= [];
  for (const record of restored.dataMappings) if (record.insertState === "sent") record.insertState = "unknown";
  restored.executable = false;
  restored.requiresReverify = true;
  restored.state = draft.state === "complete" ? "complete" : "stopped";
  restored.issues = [];
  for (const step of restored.steps) if (step.state === "sent") step.state = "unknown";
  return restored;
}
