import * as api from "@/lib/backend/api";
import { BackendErrorException, formatError, normalizeBackendError } from "@/lib/backend/errorUtils";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { exactOracleTriggerMetadata } from "@/lib/database/oracleTriggerIdentity";
import { buildOracleCompileSql, oracleCompileUnsupportedReason } from "@/lib/database/oracleInvalidObjects";
import { buildTriggerToggleSql } from "@/lib/database/triggerToggleSql";
import { oracleTriggerDefinitionScopes, oracleTriggerSourceBinding, type OracleTriggerSqlBinding, type PreparedOracleTriggerSql, type OracleTriggerDatabaseType } from "@/lib/database/oracleTriggerSql";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { assertSourceIdentity, captureSourceIdentity, freezeSourceIdentities, renewSourceIdentity, type SourceIdentitySnapshot } from "@/lib/table/objectSourceIdentity";
import { inspectExactOracleTriggerSource } from "@/lib/table/objectSourceLoad";
import { invalidateObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectDdl } from "@/lib/metadata/objectDdlCache";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import type { ObjectSource, OracleTriggerMetadata, QueryResult } from "@/types/database";
import type { OracleTriggerStructurePlan } from "./oracleTriggerStructurePlan";
import type { OracleTriggerStructureOperation } from "@/lib/table/tableStructureEditorSql";

export interface OracleTriggerTarget {
  connectionId: string;
  database: string;
  catalog?: string;
  owner: string;
  name: string;
  /** Separate from the trigger owner and the owning table/view's owner. */
  executionSchema: string;
}

export interface OracleTriggerSnapshot {
  target: Readonly<OracleTriggerTarget>;
  raw: Readonly<ObjectSource>;
  metadata: Readonly<OracleTriggerMetadata>;
  identity: Readonly<SourceIdentitySnapshot>;
  exists: boolean;
}

export type OracleTriggerAction = "enable" | "disable" | "compile" | "create" | "replace" | "delete";
export interface OracleTriggerStep {
  action: OracleTriggerAction;
  sql: string;
}
export interface OracleTriggerPlan {
  target: Readonly<OracleTriggerTarget>;
  action: OracleTriggerAction;
  before: OracleTriggerSnapshot;
  expectedEnabled?: boolean;
  expectedAfter?: Readonly<{
    binding: Readonly<OracleTriggerSqlBinding>;
    proof: readonly string[];
    definition: string;
    comparisonSource: string;
  }>;
  parentBefore?: readonly string[];
  steps: readonly Readonly<OracleTriggerStep>[];
}

export interface OracleTriggerStepResult extends OracleTriggerStep {
  state: "notExecuted" | "rejected" | "committed" | "unknown";
  verification: "applied" | "deleted" | "unverified" | "mismatch" | "unchanged" | "valid" | "invalid";
  error?: string;
  readbackError?: string;
  receipt?: "accepted" | "unknown" | "rejected" | "notStarted";
  snapshot?: OracleTriggerSnapshot;
}
export interface OracleTriggerExecutionResult {
  steps: OracleTriggerStepResult[];
  snapshot?: OracleTriggerSnapshot;
  cancelled?: boolean;
  refreshError?: string;
}

interface ConnectionIdentity {
  revision: number;
  fingerprint: string;
}
const planConnections = new WeakMap<OracleTriggerPlan, ConnectionIdentity>();
const snapshotConnections = new WeakMap<OracleTriggerSnapshot, ConnectionIdentity>();

function connectionIdentity(target: Pick<OracleTriggerTarget, "connectionId">): ConnectionIdentity {
  const store = useConnectionStore();
  const config = store.getConfig(target.connectionId);
  if (!config || !store.connectedIds.has(target.connectionId)) throw new Error("Reconnect the trigger's connection before preparing a write");
  return { revision: store.connectionStateRevision(target.connectionId), fingerprint: connectionConfigFingerprint(config) };
}

function assertConnection(target: Pick<OracleTriggerTarget, "connectionId">, expected: ConnectionIdentity): void {
  const current = connectionIdentity(target);
  if (current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) throw new Error("The connection changed; reload the trigger and prepare a new preview");
}

function sourceIdentity(target: OracleTriggerTarget): SourceIdentitySnapshot {
  return Object.freeze(captureSourceIdentity({ connectionId: target.connectionId, database: target.database, schema: target.owner, name: target.name, objectType: "TRIGGER" }));
}

function freezeSource(raw: ObjectSource, metadata: OracleTriggerMetadata): void {
  if (metadata.parent) Object.freeze(metadata.parent);
  if (metadata.definition) Object.freeze(metadata.definition);
  metadata.errors?.forEach(Object.freeze);
  if (metadata.errors) Object.freeze(metadata.errors);
  Object.values(metadata.reads).forEach((read) => read && Object.freeze(read));
  Object.freeze(metadata.reads);
  Object.freeze(metadata);
  if (raw.trigger) Object.freeze(raw.trigger);
  Object.freeze(raw);
}

async function fetchSnapshot(target: Readonly<OracleTriggerTarget>, connection: ConnectionIdentity): Promise<OracleTriggerSnapshot> {
  assertConnection(target, connection);
  const identity = sourceIdentity(target);
  const response = await api.getObjectSource(target.connectionId, target.database, target.owner, target.name, "TRIGGER", undefined, undefined, { identityMode: "exact", ...(target.catalog === undefined ? {} : { catalog: target.catalog }) });
  assertConnection(target, connection);
  return snapshotFromResponse(target, response, identity, connection);
}

function snapshotFromResponse(target: Readonly<OracleTriggerTarget>, response: ObjectSource, identity: Readonly<SourceIdentitySnapshot>, connection: ConnectionIdentity): OracleTriggerSnapshot {
  // ObjectSource is the JSON transport DTO. Copy its optional values without
  // structuredClone's inability to read a Vue proxy supplied by a consumer.
  const raw: ObjectSource = JSON.parse(JSON.stringify(response));
  const metadata = exactOracleTriggerMetadata(raw.trigger);
  if (!metadata || raw.object_type !== "TRIGGER" || raw.name !== target.name || raw.schema !== target.owner || metadata.owner !== target.owner || metadata.name !== target.name) throw new Error("Exact trigger identity was not verified; reload or update the metadata provider");
  const state = metadata.reads.identity?.state;
  if (state !== "empty" && (state !== "available" || typeof metadata.objectId !== "string" || metadata.objectId.length === 0)) throw new Error("The trigger object identity is unavailable; keep the draft and reload");
  freezeSource(raw, metadata);
  const snapshot = Object.freeze({ target, raw, metadata, identity, exists: state !== "empty" });
  snapshotConnections.set(snapshot, connection);
  return snapshot;
}

/** Read-only viewing retains old/partial provider text without authorizing an exact write. */
export async function readOracleTriggerSource(target: OracleTriggerTarget): Promise<{ raw: Readonly<ObjectSource>; snapshot?: OracleTriggerSnapshot; identityError?: string }> {
  if (!target.owner.length || !target.name.length || !target.executionSchema.length) throw new Error("Select the exact trigger owner/name and execution schema");
  const fixed = Object.freeze({ ...target });
  const connection = connectionIdentity(fixed);
  const identity = sourceIdentity(fixed);
  const raw = await api.getObjectSource(fixed.connectionId, fixed.database, fixed.owner, fixed.name, "TRIGGER", undefined, undefined, { identityMode: "exact", ...(fixed.catalog === undefined ? {} : { catalog: fixed.catalog }) });
  assertConnection(fixed, connection);
  try {
    const snapshot = snapshotFromResponse(fixed, raw, identity, connection);
    const renewed = Object.freeze({ ...snapshot, identity: Object.freeze(renewSourceIdentity(snapshot.identity)) });
    snapshotConnections.set(renewed, connection);
    return { raw: renewed.raw, snapshot: renewed };
  } catch (error) {
    return { raw, identityError: formatError(error) };
  }
}

export async function readOracleTriggerSnapshot(target: OracleTriggerTarget): Promise<OracleTriggerSnapshot> {
  const loaded = await readOracleTriggerSource(target);
  if (!loaded.snapshot) throw new Error(loaded.identityError);
  return loaded.snapshot;
}

export interface OracleTriggerPlanInput {
  target: OracleTriggerTarget;
  action: OracleTriggerAction;
  source?: string;
  /** The authoritative version loaded before the user's edits, not a fresh replacement for it. */
  baseline?: OracleTriggerSnapshot;
  selection?: OracleTriggerSqlBinding;
  enabled?: boolean;
  /** Optional identity already shown by the calling list/form, never inferred from a label. */
  expectedObjectId?: string;
}

export async function prepareOracleTriggerPlan(input: OracleTriggerPlanInput): Promise<OracleTriggerPlan> {
  const action = input.action;
  const draft = input.source,
    baseline = input.baseline,
    requestedEnabled = input.enabled;
  const selection = input.selection && { ...input.selection };
  const expectedObjectId = input.expectedObjectId;
  if (!["enable", "disable", "compile", "create", "replace", "delete"].includes(action)) throw new Error("Unsupported trigger action");
  if (action === "replace") {
    if (!baseline || !sameTarget(baseline.target, input.target)) throw new Error("Reload the complete trigger baseline before replacing it");
    const loadedConnection = snapshotConnections.get(baseline);
    if (!loadedConnection) throw new Error("Reload the authoritative trigger baseline before replacing it");
    assertConnection(input.target, loadedConnection);
    assertSourceIdentity(baseline.identity);
  }
  const connection = connectionIdentity(input.target);
  const before = await readOracleTriggerSnapshot(input.target);
  assertConnection(before.target, connection);
  if (expectedObjectId !== undefined && before.metadata.objectId !== expectedObjectId) throw new Error("The displayed trigger was replaced; keep the draft and reread its identity");
  if (action === "create" ? before.exists : !before.exists) throw new Error(action === "create" ? "A visible trigger already exists; reload it before preparing a replacement" : "No visible trigger matches this target; refresh before preparing the action");
  if (baseline && action === "replace" && !sameSnapshot(baseline, before)) throw new Error("The trigger changed since the loaded baseline; keep the draft and reload");
  const metadata = before.metadata;
  const relation = metadata.scope === "TABLE" || metadata.scope === "VIEW";
  assertActionReadability(before, action);
  if (metadata.engine === "dm" && !/(?:^|\D)8\./.test(metadata.engineVersion ?? "")) throw new Error("The connected DM8 version could not be verified for this action");
  const databaseType: OracleTriggerDatabaseType = metadata.engine === "dm" ? "dameng" : metadata.engine;
  let expectedEnabled: boolean | undefined;
  let expectedAfter: OracleTriggerPlan["expectedAfter"];
  let parentBefore: readonly string[] | undefined;
  let steps: OracleTriggerStep[];
  if (action === "compile" && oracleCompileUnsupportedReason(databaseType, "TRIGGER", { triggerProfile: metadata })) throw new Error("Trigger compilation has not been verified for the connected engine/version");
  if (action === "create" || action === "replace") {
    if (typeof draft !== "string" || !draft.trim()) throw new Error("Enter one complete trigger definition");
    if (action === "replace") {
      const loaded = await inspectExactOracleTriggerSource(before.raw, metadata.owner, metadata.name);
      if (!loaded.triggerSource.complete) throw new Error(loaded.triggerSource.error || "Reload the complete trigger baseline before replacing it");
      if (metadata.reads.enabled?.state !== "available" || typeof before.raw.trigger?.enabled !== "boolean") throw new Error("Read the actual enabled state before replacing the trigger");
    }
    const fallback = selection ?? (action === "replace" ? oracleTriggerSourceBinding(metadata) : undefined);
    const inspected = await api.prepareOracleTriggerSql({ databaseType, owner: metadata.owner, name: metadata.name, source: draft, purpose: "inspect", binding: selection });
    const binding = candidateBinding(inspected, fallback);
    if (!oracleTriggerDefinitionScopes(metadata).includes(binding.scope)) throw new Error("Full trigger creation/replacement is unavailable for this scope on the connected engine/version; OceanBase Oracle 4.2.5.7 supports TABLE/VIEW in this workflow");
    if (metadata.engine === "dm" && action === "replace" && !matchesBinding(metadata, binding)) throw new Error("DM cannot replace this trigger with a different owning object or scope; keep the draft");
    const proof = await verifyBinding(before.target, metadata.engine, binding);
    const desiredEnabled = requestedEnabled ?? (action === "replace" ? before.raw.trigger!.enabled : (inspected.inlineEnabled ?? true));
    if (typeof desiredEnabled !== "boolean") throw new Error("Read or select the trigger's enabled state before preparing the definition");
    expectedEnabled = desiredEnabled;
    const prepared = await api.prepareOracleTriggerSql({ databaseType, owner: metadata.owner, name: metadata.name, source: draft, purpose: action, binding, enabled: expectedEnabled });
    if (typeof prepared.comparisonSource !== "string") throw new Error("Update the trigger SQL provider before preparing this write");
    expectedAfter = Object.freeze({ binding: Object.freeze(binding), proof: Object.freeze(proof), definition: prepared.definition, comparisonSource: prepared.comparisonSource });
    steps = [{ action, sql: prepared.definition }];
    if (prepared.requiresStateRestore) {
      const sql = buildTriggerToggleSql({ databaseType, schema: metadata.owner, triggerName: metadata.name, enabled: false, identityMode: "exact", scope: binding.scope });
      if (!sql) throw new Error("Native disabled-state restoration is unavailable for this trigger scope");
      steps.push({ action: "disable", sql });
    }
  } else if (action === "delete") {
    const binding = oracleTriggerSourceBinding(metadata);
    if (binding && relation) {
      // The optional parent read is evidence for the result, not a new DROP privilege prerequisite.
      try {
        parentBefore = Object.freeze(await verifyBinding(before.target, metadata.engine, binding));
      } catch {
        /* report unverifiable parent on readback */
      }
    }
    const sql = await api.buildDropObjectSql({ databaseType, objectType: "TRIGGER", schema: metadata.owner, name: metadata.name });
    steps = [{ action, sql }];
  } else {
    expectedEnabled = action === "compile" ? undefined : action === "enable";
    const sql =
      action === "compile"
        ? buildOracleCompileSql(databaseType, metadata.owner, { name: metadata.name, type: "TRIGGER" }, { triggerProfile: metadata })
        : buildTriggerToggleSql({ databaseType, schema: metadata.owner, triggerName: metadata.name, enabled: expectedEnabled!, identityMode: "exact", scope: metadata.scope });
    if (!sql) throw new Error("This native trigger action is unavailable for the verified engine and scope");
    steps = action !== "compile" && metadata.reads.enabled?.state === "available" && before.raw.trigger?.enabled === expectedEnabled ? [] : [{ action, sql }];
  }
  const plan: OracleTriggerPlan = Object.freeze({ target: before.target, action, before, expectedEnabled, expectedAfter, parentBefore, steps: Object.freeze(steps.map((step) => Object.freeze(step))) });
  assertSourceIdentity(before.identity);
  assertConnection(before.target, connection);
  planConnections.set(plan, connection);
  return plan;
}

export async function executeOracleTriggerPlan(
  plan: OracleTriggerPlan,
  options: { confirmed: boolean; confirmationScope?: string; isCurrent?: () => boolean; timeoutSecs?: number; refresh?: (target: Readonly<OracleTriggerTarget>, snapshot?: OracleTriggerSnapshot) => Promise<void> },
): Promise<OracleTriggerExecutionResult> {
  return executePreparedTriggerPlan(plan, options, true);
}

async function executePreparedTriggerPlan(
  plan: OracleTriggerPlan,
  options: { confirmed: boolean; confirmationScope?: string; isCurrent?: () => boolean; timeoutSecs?: number; refresh?: (target: Readonly<OracleTriggerTarget>, snapshot?: OracleTriggerSnapshot) => Promise<void> },
  guard: boolean,
): Promise<OracleTriggerExecutionResult> {
  const cancelled = (): OracleTriggerExecutionResult => ({ steps: plan.steps.map((step) => ({ ...step, state: "notExecuted", verification: "unverified" })), cancelled: true });
  if (!options.confirmed || options.isCurrent?.() === false) return cancelled();
  const connection = planConnections.get(plan);
  if (!connection) throw new Error("Prepare a new trigger preview before executing it");
  assertSourceIdentity(plan.before.identity);
  assertConnection(plan.target, connection);
  const run = async (): Promise<OracleTriggerExecutionResult> => {
    if (options.isCurrent?.() === false) return cancelled();
    assertSourceIdentity(plan.before.identity);
    assertConnection(plan.target, connection);
    const frozen = freezeSourceIdentities([plan.before.identity]);
    let dispatched = false;
    try {
      let latest = await fetchSnapshot(plan.target, connection);
      if (!sameSnapshot(plan.before, latest)) throw new Error("The trigger changed after the preview; keep the draft and reload");
      assertActionReadability(latest, plan.action);
      if (plan.expectedAfter && !sameProof(plan.expectedAfter.proof, await verifyBinding(plan.target, latest.metadata.engine, plan.expectedAfter.binding))) throw new Error("The owning object or scope changed after the preview; keep the draft and reload");
      if (options.isCurrent?.() === false) return cancelled();
      const result: OracleTriggerExecutionResult = { steps: [], snapshot: latest };
      for (const [index, step] of plan.steps.entries()) {
        if (index && (result.steps[index - 1].state !== "committed" || result.steps[index - 1].verification === "invalid" || options.isCurrent?.() === false)) {
          result.steps.push({ ...step, state: "notExecuted", verification: "unverified" });
          continue;
        }
        try {
          assertConnection(plan.target, connection);
        } catch (error) {
          if (!index) throw error;
          result.steps.push({ ...step, state: "notExecuted", verification: "unverified", error: formatError(error) });
          continue;
        }
        frozen.markDispatched();
        dispatched = true;
        let accepted = false;
        let writeError: unknown;
        try {
          const timeoutSecs = options.timeoutSecs ?? queryTimeoutSecsForConnection(useConnectionStore().getConfig(plan.target.connectionId), useSettingsStore().editorSettings.globalQueryTimeoutSecs);
          const receipt = await api.executeQuery(plan.target.connectionId, plan.target.database, step.sql, plan.target.executionSchema, undefined, { catalog: plan.target.catalog, timeoutSecs });
          if (receipt.execution_error) throw new BackendErrorException(receipt.error || "Trigger statement failed");
          accepted = true;
        } catch (error) {
          writeError = error;
        }
        // A failed/lost receipt does not establish rejection. Always read the
        // fixed target; an attempted statement is never dispatched a second time.
        let after: OracleTriggerSnapshot | undefined;
        let readbackError: string | undefined;
        let verification: OracleTriggerStepResult["verification"] = "unverified";
        try {
          after = await fetchSnapshot(plan.target, connection);
          verification = await verifyStep(plan, step, latest, after, index);
        } catch (error) {
          readbackError = formatError(error);
        }
        const refusal = writeError === undefined ? "unknown" : knownReceiptFailure(writeError, latest.metadata.engine);
        if (refusal !== "unknown" && after && sameSnapshot(latest, after)) verification = "unchanged";
        const verified = verification === "applied" || verification === "deleted" || verification === "valid" || verification === "invalid";
        const state: OracleTriggerStepResult["state"] = refusal === "notStarted" ? "notExecuted" : refusal === "rejected" ? "rejected" : accepted && verified ? "committed" : "unknown";
        result.steps.push({ ...step, state, verification, snapshot: after, receipt: accepted ? "accepted" : refusal, ...(writeError === undefined ? {} : { error: formatError(writeError) }), ...(readbackError === undefined ? {} : { readbackError }) });
        result.snapshot = after;
        if (after) latest = after;
      }
      return result;
    } finally {
      if (dispatched) frozen.finish();
      else frozen.cancel();
    }
  };
  const guarded =
    !guard || plan.steps.length === 0
      ? await run()
      : await executeWithProductionSqlGuard<OracleTriggerExecutionResult>({
          connection: useConnectionStore().getConfig(plan.target.connectionId),
          database: plan.target.database,
          sql: plan.steps.map((step) => step.sql).join("\n"),
          scopeId: options.confirmationScope,
          execute: run,
        });
  if (!guarded) return cancelled();
  if (guarded.snapshot) {
    const snapshot = guarded.snapshot;
    try {
      const renewed = Object.freeze({ ...snapshot, identity: Object.freeze(renewSourceIdentity(snapshot.identity)) });
      snapshotConnections.set(renewed, connection);
      guarded.snapshot = renewed;
      for (const step of guarded.steps) if (step.snapshot === snapshot) step.snapshot = renewed;
    } catch (error) {
      guarded.refreshError = formatError(error);
    }
  }
  if (guarded.steps.some((step) => step.receipt !== undefined)) {
    try {
      const parents = [plan.before.metadata.parent, guarded.snapshot?.metadata.parent].filter((parent): parent is NonNullable<OracleTriggerMetadata["parent"]> => !!parent);
      const request = { connectionId: plan.target.connectionId, database: plan.target.database, catalog: plan.target.catalog, schema: plan.target.owner, tableName: plan.target.name, objectType: "TRIGGER" as const };
      const invalidations: Promise<unknown>[] = [invalidateObjectDdl(request, { metadata: false, strict: true }), useConnectionStore().invalidateOracleTriggerLists(plan.target, parents)];
      for (const parent of parents) {
        for (const objectType of parent.objectType === "VIEW" ? (["VIEW", undefined] as const) : ([undefined] as const)) invalidations.push(invalidateObjectMetadataFacet({ ...request, schema: parent.owner, tableName: parent.name, objectType }, "triggers", { strict: true }));
      }
      const results = await Promise.allSettled(invalidations);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } catch (error) {
      guarded.refreshError = [guarded.refreshError, formatError(error)].filter(Boolean).join("\n");
    }
  }
  if (
    ["enable", "disable", "compile"].includes(plan.action) &&
    !guarded.cancelled &&
    guarded.snapshot?.exists &&
    guarded.snapshot.metadata.objectId === plan.before.metadata.objectId &&
    guarded.snapshot.raw.trigger &&
    guarded.steps.every((step) => step.state === "committed" && ["applied", "valid", "invalid", "unchanged"].includes(step.verification))
  ) {
    try {
      assertConnection(plan.target, connection);
      assertSourceIdentity(guarded.snapshot.identity);
      useConnectionStore().syncOracleTriggerNodeState(plan.target, guarded.snapshot.raw.trigger);
    } catch (error) {
      guarded.refreshError = [guarded.refreshError, formatError(error)].filter(Boolean).join("\n");
    }
  }
  if (!guarded.cancelled && options.refresh) {
    try {
      assertConnection(plan.target, connection);
      await options.refresh(plan.target, guarded.snapshot);
    } catch (error) {
      guarded.refreshError = [guarded.refreshError, formatError(error)].filter(Boolean).join("\n");
    }
  }
  return guarded;
}

export interface OracleTriggerStructureStepResult {
  statementIndex: number;
  sql: string;
  state: OracleTriggerStepResult["state"];
  elapsedMs?: number;
  error?: string;
  trigger?: OracleTriggerStepResult;
}
export function assertTriggerStructureSql(statements: readonly string[], operation: Readonly<OracleTriggerStructureOperation>, plan: OracleTriggerPlan): void {
  if (plan.steps.length !== operation.statementCount || plan.steps.some((step, index) => step.sql !== statements[operation.statementIndex + index])) throw new Error("The actual trigger SQL differs from the confirmed table preview; regenerate it");
}
export interface OracleTriggerStructureExecutionResult {
  steps: OracleTriggerStructureStepResult[];
  triggerResults: { draftId: string; action: OracleTriggerAction; result: OracleTriggerExecutionResult }[];
  cancelled?: boolean;
}
const attemptedStructurePlans = new WeakSet<OracleTriggerStructurePlan>();

/** The original allowed structure order, through the existing single-statement seam. */
export async function executeOracleTriggerStructurePlan(plan: OracleTriggerStructurePlan, options: { confirmed: boolean; confirmationScope?: string; isCurrent: () => boolean; timeoutSecs?: number; preflight?: () => Promise<void> }): Promise<OracleTriggerStructureExecutionResult> {
  if (attemptedStructurePlans.has(plan)) throw new Error("This structure sequence was already attempted; reread and preview only the remaining changes");
  return executeTriggerSequence(
    {
      target: plan.target,
      connection: { revision: plan.revision, fingerprint: plan.configFingerprint },
      engine: plan.target.databaseType === "dameng" ? "dm" : plan.target.databaseType,
      statements: plan.statements,
      groups: plan.groups.map((group) => ({
        id: group.operation.draftId,
        action: group.operation.action,
        statementIndex: group.operation.statementIndex,
        statementCount: group.operation.statementCount,
        // CREATE TABLE has to precede the new parent's identity proof.
        prepare: () => (group.plan ? Promise.resolve(group.plan) : prepareOracleTriggerPlan(group.afterTableCreate!)),
      })),
      markAttempted: () => attemptedStructurePlans.add(plan),
    },
    options,
  );
}

export interface OracleTriggerDropBatchEntry {
  id: string;
  sql: string;
  triggerPlan?: OracleTriggerPlan;
  executionSchema?: string;
}
export interface OracleTriggerDropBatchPlan {
  target: Readonly<Pick<OracleTriggerTarget, "connectionId" | "database" | "catalog" | "executionSchema">>;
  entries: readonly Readonly<OracleTriggerDropBatchEntry>[];
  engine: OracleTriggerMetadata["engine"];
}
const dropBatchConnections = new WeakMap<OracleTriggerDropBatchPlan, ConnectionIdentity>();
const attemptedDropBatches = new WeakSet<OracleTriggerDropBatchPlan>();

/** Bind generated non-trigger SQL and authoritative trigger plans before confirmation. */
export function prepareOracleTriggerDropBatchPlan(input: OracleTriggerDropBatchPlan): OracleTriggerDropBatchPlan {
  const target = Object.freeze({ ...input.target });
  const connection = connectionIdentity(target);
  const ids = new Set<string>();
  let triggerCount = 0;
  const entries = input.entries.map((entry) => {
    if (!entry.sql.trim() || ids.has(entry.id)) throw new Error("Regenerate the complete object deletion preview");
    ids.add(entry.id);
    if (entry.triggerPlan) {
      const trigger = entry.triggerPlan;
      const originalConnection = planConnections.get(trigger);
      if (
        !originalConnection ||
        trigger.action !== "delete" ||
        trigger.steps.length !== 1 ||
        trigger.steps[0].sql !== entry.sql ||
        trigger.before.metadata.engine !== input.engine ||
        trigger.target.connectionId !== target.connectionId ||
        trigger.target.database !== target.database ||
        trigger.target.catalog !== target.catalog
      )
        throw new Error("The trigger deletion differs from the confirmed object selection");
      assertConnection(target, originalConnection);
      assertSourceIdentity(trigger.before.identity);
      triggerCount++;
    }
    return Object.freeze({ ...entry });
  });
  if (!triggerCount) throw new Error("Use the existing object deletion path for a selection without exact triggers");
  const plan = Object.freeze({ target, entries: Object.freeze(entries), engine: input.engine });
  dropBatchConnections.set(plan, connection);
  return plan;
}

export async function executeOracleTriggerDropBatchPlan(plan: OracleTriggerDropBatchPlan, options: { confirmed: boolean; confirmationScope?: string; isCurrent: () => boolean; timeoutSecs?: number; onProgress?: (completed: number) => void }): Promise<OracleTriggerStructureExecutionResult> {
  const connection = dropBatchConnections.get(plan);
  if (!connection || attemptedDropBatches.has(plan)) throw new Error("Reread the objects and preview only the remaining deletions");
  return executeTriggerSequence(
    {
      target: plan.target,
      connection,
      engine: plan.engine,
      statements: plan.entries.map((entry) => entry.sql),
      statementSchemas: plan.entries.map((entry) => (Object.prototype.hasOwnProperty.call(entry, "executionSchema") ? entry.executionSchema : plan.target.executionSchema)),
      groups: plan.entries.flatMap((entry, statementIndex) => (entry.triggerPlan ? [{ id: entry.id, action: "delete" as const, statementIndex, statementCount: 1, prepare: () => Promise.resolve(entry.triggerPlan!) }] : [])),
      markAttempted: () => attemptedDropBatches.add(plan),
    },
    options,
  );
}

/** Shared serial seam: one production/readonly confirmation, stop on unknown. */
async function executeTriggerSequence(
  sequence: {
    target: Pick<OracleTriggerTarget, "connectionId" | "database" | "catalog" | "executionSchema">;
    connection: ConnectionIdentity;
    engine: OracleTriggerMetadata["engine"];
    statements: readonly string[];
    statementSchemas?: readonly (string | undefined)[];
    groups: { id: string; action: OracleTriggerAction; statementIndex: number; statementCount: number; prepare: () => Promise<OracleTriggerPlan> }[];
    markAttempted: () => unknown;
  },
  options: { confirmed: boolean; confirmationScope?: string; isCurrent: () => boolean; timeoutSecs?: number; preflight?: () => Promise<void>; onProgress?: (completed: number) => void },
): Promise<OracleTriggerStructureExecutionResult> {
  const result: OracleTriggerStructureExecutionResult = { steps: sequence.statements.map((sql, statementIndex) => ({ statementIndex, sql, state: "notExecuted" })), triggerResults: [] };
  if (!options.confirmed || !options.isCurrent()) return { ...result, cancelled: true };
  const fixed = sequence.target;
  const run = async () => {
    if (!options.isCurrent()) return { ...result, cancelled: true };
    try {
      await options.preflight?.();
    } catch (error) {
      if (result.steps[0]) result.steps[0].error = formatError(error);
      return result;
    }
    for (let index = 0; index < sequence.statements.length;) {
      if (!options.isCurrent()) break;
      const row = result.steps[index];
      try {
        assertConnection(fixed, sequence.connection);
        const group = sequence.groups.find((item) => item.statementIndex === index);
        if (group) {
          const triggerPlan = await group.prepare();
          if (triggerPlan.steps.length !== group.statementCount || triggerPlan.steps.some((step, offset) => step.sql !== sequence.statements[index + offset])) throw new Error("The trigger SQL differs from the confirmed preview; regenerate it");
          sequence.markAttempted();
          const outcome = await executePreparedTriggerPlan(triggerPlan, { confirmed: true, isCurrent: options.isCurrent, timeoutSecs: options.timeoutSecs }, false);
          result.triggerResults.push({ draftId: group.id, action: group.action, result: outcome });
          outcome.steps.forEach((step, offset) => Object.assign(result.steps[index + offset], { state: step.state, error: step.error || step.readbackError, trigger: step }));
          options.onProgress?.(index + outcome.steps.filter((step) => step.state !== "notExecuted").length);
          if (outcome.cancelled || outcome.steps.some((step) => step.state !== "committed" || step.verification === "invalid")) break;
          index += group.statementCount;
        } else {
          sequence.markAttempted();
          const startedAt = Date.now();
          let dispatched = false;
          try {
            dispatched = true;
            const receipt = await api.executeQuery(fixed.connectionId, fixed.database, row.sql, sequence.statementSchemas ? sequence.statementSchemas[index] : fixed.executionSchema, undefined, { catalog: fixed.catalog, timeoutSecs: options.timeoutSecs });
            if (receipt.execution_error) throw new BackendErrorException(receipt.error || "Structure statement failed");
            row.state = "committed";
          } catch (error) {
            const refusal = knownReceiptFailure(error, sequence.engine);
            row.state = !dispatched || refusal === "notStarted" ? "notExecuted" : refusal === "rejected" ? "rejected" : "unknown";
            row.error = formatError(error);
            break;
          } finally {
            row.elapsedMs = Date.now() - startedAt;
          }
          index++;
          options.onProgress?.(index);
        }
      } catch (error) {
        row.error = formatError(error);
        break;
      }
    }
    return result;
  };
  return (await executeWithProductionSqlGuard({ connection: useConnectionStore().getConfig(fixed.connectionId), database: fixed.database, sql: sequence.statements.join("\n\n"), scopeId: options.confirmationScope, execute: run })) ?? { ...result, cancelled: true };
}

function samePhysicalTrigger(before: OracleTriggerSnapshot, after: OracleTriggerSnapshot): boolean {
  const a = before.metadata,
    b = after.metadata;
  return (
    before.exists &&
    after.exists &&
    a.objectId === b.objectId &&
    a.engine === b.engine &&
    a.engineVersion === b.engineVersion &&
    a.scope === b.scope &&
    (a.scopeOwner ?? null) === (b.scopeOwner ?? null) &&
    (a.parent?.owner ?? null) === (b.parent?.owner ?? null) &&
    (a.parent?.name ?? null) === (b.parent?.name ?? null) &&
    (a.parent?.objectType ?? null) === (b.parent?.objectType ?? null) &&
    (a.parent?.objectId ?? null) === (b.parent?.objectId ?? null)
  );
}

function sameSnapshot(before: OracleTriggerSnapshot, after: OracleTriggerSnapshot): boolean {
  return (
    (before.exists ? samePhysicalTrigger(before, after) : !after.exists && before.metadata.engine === after.metadata.engine && before.metadata.engineVersion === after.metadata.engineVersion) &&
    (before.metadata.lastDdlTime ?? null) === (after.metadata.lastDdlTime ?? null) &&
    (before.raw.trigger?.enabled ?? null) === (after.raw.trigger?.enabled ?? null) &&
    (before.raw.trigger?.valid ?? null) === (after.raw.trigger?.valid ?? null) &&
    before.raw.source === after.raw.source
  );
}

function sameTarget(a: OracleTriggerTarget, b: OracleTriggerTarget): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && a.catalog === b.catalog && a.owner === b.owner && a.name === b.name;
}

function assertActionReadability(snapshot: OracleTriggerSnapshot, action: OracleTriggerAction): void {
  const metadata = snapshot.metadata;
  const relation = metadata.scope === "TABLE" || metadata.scope === "VIEW";
  if ((action === "enable" || action === "disable") && (metadata.reads.scope?.state !== "available" || (relation && (metadata.reads.parent?.state !== "available" || !metadata.parent || metadata.parent.objectType !== metadata.scope))))
    throw new Error("Verify the trigger scope and owning object before preparing this action");
  if (action === "replace" && (!metadata.definition?.complete || metadata.reads.definition?.state !== "available" || metadata.reads.enabled?.state !== "available" || typeof snapshot.raw.trigger?.enabled !== "boolean"))
    throw new Error("The complete trigger definition or enabled state is unavailable; keep the draft and reload");
}

function candidateBinding(prepared: PreparedOracleTriggerSql, selection?: OracleTriggerSqlBinding): OracleTriggerSqlBinding {
  const header = prepared.header;
  if (header.scope === "RELATION") {
    if (selection && (selection.scope === "TABLE" || selection.scope === "VIEW") && selection.name === header.name && (header.owner === undefined || header.owner === null || header.owner === selection.owner)) return { ...selection, pluggable: false };
    if (header.owner && header.name) return { scope: header.viewOnly ? "VIEW" : "TABLE", owner: header.owner, name: header.name, pluggable: false };
  } else if (header.scope === "SCHEMA") {
    const owner = header.owner ?? (selection?.scope === "SCHEMA" ? selection.owner : undefined);
    if (owner) return { scope: "SCHEMA", owner, pluggable: false };
  } else if (header.scope === "DATABASE" || header.scope === "TIMER") return { scope: header.scope, pluggable: header.pluggable };
  throw new Error("Select or explicitly qualify the candidate's actual owning object/scope before preparing a write");
}

function matchesBinding(metadata: Readonly<OracleTriggerMetadata>, binding: Readonly<OracleTriggerSqlBinding>): boolean {
  if (metadata.scope !== binding.scope) return false;
  if (binding.scope === "TABLE" || binding.scope === "VIEW") return metadata.parent?.owner === binding.owner && metadata.parent?.name === binding.name && metadata.parent?.objectType === binding.scope;
  if (binding.scope === "SCHEMA") return metadata.scopeOwner === binding.owner;
  return true;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function metadataQuery(target: Readonly<OracleTriggerTarget>, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.executionSchema, undefined, { catalog: target.catalog, maxRows: 2 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Trigger metadata query failed");
  if (result.truncated || result.has_more || result.rows.length > 1 || result.large_value_cells?.length) throw new Error("Trigger metadata is incomplete or ambiguous; keep the draft and reload");
  return result;
}

/** Only action-relevant scope queries run: TABLE/VIEW never require a database-wide privilege. */
async function verifyBinding(target: Readonly<OracleTriggerTarget>, engine: OracleTriggerMetadata["engine"], binding: Readonly<OracleTriggerSqlBinding>): Promise<string[]> {
  let sql: string;
  let expected: (string | undefined)[];
  if (binding.scope === "TABLE" || binding.scope === "VIEW") {
    if (!binding.owner || !binding.name) throw new Error("Select the exact owning object");
    sql = `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TO_CHAR(OBJECT_ID) AS OBJECT_ID FROM ALL_OBJECTS WHERE OWNER = ${sqlString(binding.owner)} AND OBJECT_NAME = ${sqlString(binding.name)} AND OBJECT_TYPE = ${sqlString(binding.scope)}`;
    expected = [binding.owner, binding.name, binding.scope];
  } else if (binding.scope === "SCHEMA") {
    if (!binding.owner) throw new Error("Select the actual scope owner, not the trigger owner or execution schema");
    sql = engine === "dm" ? `SELECT NAME, TO_CHAR(ID) AS SCHEMA_ID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = ${sqlString(binding.owner)}` : `SELECT USERNAME, TO_CHAR(USER_ID) AS SCHEMA_ID FROM ALL_USERS WHERE USERNAME = ${sqlString(binding.owner)}`;
    expected = [binding.owner];
  } else {
    sql = engine === "dm" ? "SELECT NAME, TO_CHAR(CREATE_TIME, 'YYYY-MM-DD HH24:MI:SS') AS CREATED FROM V$DATABASE" : "SELECT SYS_CONTEXT('USERENV','DB_UNIQUE_NAME') AS DATABASE_NAME, SYS_CONTEXT('USERENV','CON_ID') AS CONTAINER_ID, SYS_CONTEXT('USERENV','CON_NAME') AS CONTAINER_NAME FROM DUAL";
    expected = [];
  }
  const result = await metadataQuery(target, sql);
  const row = result.rows[0];
  if (!row || row.some((value) => typeof value !== "string" || !value.length) || expected.some((value, index) => row[index] !== value) || row.length !== (binding.scope === "TABLE" || binding.scope === "VIEW" ? 4 : binding.scope === "SCHEMA" || engine === "dm" ? 2 : 3))
    throw new Error("The actual owning object or scope could not be verified");
  if (binding.pluggable && (engine !== "oracle" || row[1] === "0" || row[1] === "1")) throw new Error("The current pluggable database context could not be verified");
  return row as string[];
}

function sameProof(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function verifyStep(plan: OracleTriggerPlan, step: Readonly<OracleTriggerStep>, before: OracleTriggerSnapshot, after: OracleTriggerSnapshot, index: number): Promise<OracleTriggerStepResult["verification"]> {
  if (step.action === "delete") {
    if (after.exists) return "mismatch";
    await verifyDeleted(plan.target, after.metadata.engine);
    if (before.metadata.scope === "TABLE" || before.metadata.scope === "VIEW") {
      const binding = oracleTriggerSourceBinding(before.metadata);
      if (!binding) throw new Error("The owning object could not be verified after deletion");
      const proof = await verifyBinding(plan.target, before.metadata.engine, binding);
      if (plan.parentBefore && !sameProof(plan.parentBefore, proof)) return "mismatch";
    }
    return "deleted";
  }
  if (!after.exists || after.metadata.engine !== before.metadata.engine || after.metadata.engineVersion !== before.metadata.engineVersion) return "unverified";
  if (step.action !== "create" && before.metadata.objectId !== after.metadata.objectId) return "mismatch";
  if (step.action === "create" || step.action === "replace") {
    const expected = plan.expectedAfter!;
    if (!matchesBinding(after.metadata, expected.binding) || !sameProof(expected.proof, await verifyBinding(plan.target, after.metadata.engine, expected.binding))) return "mismatch";
    const inspected = await inspectExactOracleTriggerSource(after.raw, plan.target.owner, plan.target.name);
    if (!inspected.triggerSource.complete) return "unverified";
    const databaseType = after.metadata.engine === "dm" ? "dameng" : after.metadata.engine;
    const prepared = await api.prepareOracleTriggerSql({ databaseType, owner: plan.target.owner, name: plan.target.name, source: inspected.editableSource, purpose: "replace", binding: expected.binding, enabled: plan.expectedEnabled });
    if (typeof prepared.comparisonSource !== "string") return "unverified";
    if (prepared.comparisonSource !== expected.comparisonSource) return "mismatch";
    const restorePending = plan.steps.slice(index + 1).some((next) => next.action === "disable");
    if (after.metadata.reads.enabled?.state !== "available" || typeof after.raw.trigger?.enabled !== "boolean") return "unverified";
    if (!restorePending && after.raw.trigger.enabled !== plan.expectedEnabled) return "mismatch";
    return after.metadata.reads.validity?.state === "available" && after.raw.trigger?.valid === false ? "invalid" : "applied";
  }
  if (!samePhysicalTrigger(before, after)) return "mismatch";
  const preserved = await preservedTriggerSource(before, after);
  if (preserved !== true) return preserved === false ? "mismatch" : "unverified";
  if (step.action === "compile") return after.metadata.reads.validity?.state !== "available" || typeof after.raw.trigger?.valid !== "boolean" ? "unverified" : after.raw.trigger.valid ? "valid" : "invalid";
  return after.metadata.reads.enabled?.state !== "available" || typeof after.raw.trigger?.enabled !== "boolean" ? "unverified" : after.raw.trigger.enabled === (step.action === "enable") ? "applied" : "mismatch";
}

async function preservedTriggerSource(before: OracleTriggerSnapshot, after: OracleTriggerSnapshot): Promise<boolean | undefined> {
  if (!before.metadata.definition?.complete || before.metadata.reads.definition?.state !== "available") return true; // Native actions do not require a replaceable body.
  const previous = await inspectExactOracleTriggerSource(before.raw, before.target.owner, before.target.name);
  const current = await inspectExactOracleTriggerSource(after.raw, after.target.owner, after.target.name);
  if (!previous.triggerSource.complete || !current.triggerSource.complete || !previous.triggerSource.prepared || !current.triggerSource.prepared) return;
  const binding = candidateBinding(previous.triggerSource.prepared, oracleTriggerSourceBinding(before.metadata));
  const databaseType = before.metadata.engine === "dm" ? "dameng" : before.metadata.engine;
  // Only the already-validated CREATE/owner/state export wrapper is controlled.
  // The actual header clauses, comments, body and literal whitespace stay in
  // the whole definition comparison; no token fingerprint or newline folding.
  const normalized = await Promise.all([previous.editableSource, current.editableSource].map((source) => api.prepareOracleTriggerSql({ databaseType, owner: before.target.owner, name: before.target.name, source, purpose: "replace", binding, enabled: false })));
  if (normalized.some((definition) => typeof definition.comparisonSource !== "string")) return;
  return normalized[0].comparisonSource === normalized[1].comparisonSource;
}

async function verifyDeleted(target: Readonly<OracleTriggerTarget>, engine: OracleTriggerMetadata["engine"]): Promise<void> {
  if (engine !== "dm") {
    const own = await metadataQuery(target, "SELECT USER AS SESSION_USER FROM DUAL");
    if (own.rows[0]?.[0] === target.owner) return; // Successful exact empty read covers this user's own objects.
  }
  // Cross-owner ALL_* visibility can disappear after permission changes. Only
  // a readable global catalog can prove absence, never the connection username.
  const sql = `SELECT OWNER, OBJECT_NAME FROM DBA_OBJECTS WHERE OWNER = ${sqlString(target.owner)} AND OBJECT_NAME = ${sqlString(target.name)} AND OBJECT_TYPE = 'TRIGGER'`;
  if ((await metadataQuery(target, sql)).rows.length) throw new Error("The trigger still exists in the global dictionary");
}

export async function verifyOracleTriggerDeletion(target: OracleTriggerTarget, plan?: OracleTriggerPlan): Promise<void> {
  const connection = plan && planConnections.get(plan);
  if (plan) {
    if (!connection || plan.action !== "delete" || !sameTarget(target, plan.target)) throw new Error("Reload the original trigger deletion target");
    assertConnection(target, connection);
  }
  const current = await readOracleTriggerSnapshot(target);
  if (current.exists) throw new Error("The trigger still exists; retain its delete draft");
  if (plan) {
    if ((await verifyStep(plan, plan.steps[0], plan.before, current, 0)) !== "deleted") throw new Error("The owning object changed; retain the deletion result and refresh its identity");
    assertConnection(target, connection!);
  } else await verifyDeleted(current.target, current.metadata.engine);
}

function knownReceiptFailure(error: unknown, engine: OracleTriggerMetadata["engine"]): "notStarted" | "rejected" | "unknown" {
  const normalized = normalizeBackendError(error);
  if (normalized?.operationOutcome === "not_started") return "notStarted";
  const diagnostics = normalized?.diagnostics;
  if (normalized?.origin?.subsystem !== "database" || diagnostics?.category !== "sql" || diagnostics.stage !== "execute") return "unknown";
  // A permission code in a transport/fetch error or in the submitted source is
  // not a native SQL rejection. Inspect only the structured native SQL origin.
  const vendor = typeof diagnostics.vendorCode === "number" ? Math.abs(diagnostics.vendorCode) : undefined;
  const oraclePermission = engine !== "dm" && (vendor === 1031 || (vendor === undefined && /^\s*ORA-01031\b/.test(normalized.detail ?? "")));
  return oraclePermission || (diagnostics.sqlState === "42501" && vendor !== 24344) ? "rejected" : "unknown";
}
