export interface NativeJobScope {
  connectionId: string;
  database: string;
  /** Opaque backend identity of the connected database/tenant/container. */
  contextId: string;
}

export type NativeJobRef = { scope: NativeJobScope; kind: "scheduler"; owner: string; name: string } | { scope: NativeJobScope; kind: "legacy"; jobId: string } | { scope: NativeJobScope; kind: "dameng-native"; jobId: string; name: string };

export type NativeJobValue = string | number | boolean | null | NativeJobValue[] | { [key: string]: NativeJobValue };

export type NativeJobMetadata<T> = { status: "available"; value: T } | { status: "truncated"; value: T; limit: number } | { status: "empty" } | { status: "denied" | "unsupported" | "error" | "unknown"; reason: string };

export type NativeJobFieldChange = { kind: "keep" } | { kind: "set"; value: NativeJobValue } | { kind: "clear" };

export type NativeJobArgumentValue = { kind: "unset" } | { kind: "inherit" } | { kind: "null" } | { kind: "value"; value: NativeJobValue } | { kind: "opaque"; value: NativeJobValue };

export interface NativeJobArgument {
  position: number;
  name?: string;
  dataType: string;
  value: NativeJobArgumentValue;
  defaultValue?: NativeJobMetadata<NativeJobArgumentValue>;
  metadataAttribute?: string;
  editable: boolean;
  reason?: string;
}

export interface NativeJobSnapshot {
  ref: NativeJobRef;
  /** Opaque definition baseline issued by the backend, not a UI label. */
  revision: string;
  definition: NativeJobMetadata<Record<string, NativeJobValue>>;
  arguments: NativeJobMetadata<NativeJobArgument[]>;
}

export type NativeJobEngine = "oracle" | "oceanbase-oracle" | "dameng";
export type NativeJobKind = NativeJobRef["kind"];
export type NativeJobRow = Record<string, NativeJobValue>;

export interface NativeJobContext {
  scope: NativeJobScope;
  engine: NativeJobEngine;
  sessionUser: string;
  actualDatabase: string | null;
  productVersion: string | null;
}

export interface NativeJobCatalogSource {
  source: string | null;
  coverage: "database" | "accessible" | "current_user" | null;
}

export interface NativeJobSummary {
  ref: NativeJobRef;
  name: string;
  owner: string | null;
  enabled: boolean | null;
  jobType: string | null;
  state: string | null;
  nextRun: NativeJobValue;
  comments: string | null;
  aliases: NativeJobRef[];
  logUser: string | null;
  privUser: string | null;
  schemaUser: string | null;
}

export interface NativeJobListRequest {
  scope: NativeJobScope;
  kind: NativeJobKind;
  schema?: string | null;
  filter?: string;
  offset?: number;
  limit?: number;
}

export interface NativeJobList {
  jobs: NativeJobMetadata<NativeJobSummary[]>;
  source: NativeJobCatalogSource;
  offset: number;
  limit: number;
}

export type NativeJobReferenceKind = "program" | "program-arguments" | "schedule" | "chain" | "credential" | "destination" | "window" | "window-group" | "file-watcher" | "destination-group" | "destination-group-members";
export interface NativeJobReferenceListRequest {
  scope: NativeJobScope;
  kind: NativeJobReferenceKind;
  schema?: string;
  name?: string;
  filter?: string;
  offset?: number;
  limit?: number;
}
export interface NativeJobReferenceCatalog {
  objects: NativeJobMetadata<NativeJobRow[]>;
  source: NativeJobCatalogSource;
  offset: number;
  limit: number;
}

export interface NativeJobDetails {
  snapshot: NativeJobSnapshot;
  nativeIdentity: NativeJobMetadata<NativeJobRow>;
  consistency: NativeJobMetadata<null>;
  parameterMetadata: NativeJobMetadata<NativeJobRow[]>;
  program?: NativeJobMetadata<NativeJobRow>;
  programArguments?: NativeJobMetadata<NativeJobRow[]>;
  legacyDefinition?: NativeJobMetadata<NativeJobRow>;
  steps: NativeJobMetadata<NativeJobRow[]>;
  schedules: NativeJobMetadata<NativeJobRow[]>;
  running: NativeJobMetadata<NativeJobRow[]>;
  history: NativeJobMetadata<NativeJobRow[]>;
  sources: Record<string, NativeJobCatalogSource>;
}

export interface NativeJobEditDraft {
  attributes?: Record<string, NativeJobFieldChange>;
  arguments?: { position: number; value: NativeJobArgumentValue }[];
}

export interface NativeJobEdit {
  action: "update";
  finalEnabled?: boolean;
  argumentTarget?: { program: NativeJobObjectReference | null; arguments: NativeJobCreateArgument[] };
  target: NativeJobRef;
  baseline: string;
  attributes: { name: string; change: Exclude<NativeJobFieldChange, { kind: "keep" }> }[];
  arguments: { position: number; value: Exclude<NativeJobArgumentValue, { kind: "opaque" }> }[];
}

export type NativeJobDamengChildChange = { kind: "add" | "update"; name: string; attributes?: NativeJobEdit["attributes"] } | { kind: "drop"; name: string };

export interface NativeJobDamengConfiguration {
  attributes?: NativeJobEdit["attributes"];
  steps?: NativeJobDamengChildChange[];
  schedules?: NativeJobDamengChildChange[];
}

export interface NativeJobDamengChildDraft {
  kind: "add" | "update" | "drop";
  name: string;
  attributes?: NativeJobEditDraft["attributes"];
}

export interface NativeJobDamengEditDraft {
  attributes?: NativeJobEditDraft["attributes"];
  steps?: NativeJobDamengChildDraft[];
  schedules?: NativeJobDamengChildDraft[];
}

export type NativeJobMutation =
  | NativeJobEdit
  | { target: NativeJobRef; baseline: string; action: "configure-dameng"; configuration: NativeJobDamengConfiguration }
  | { target: NativeJobRef; baseline: string; action: "enable" | "disable" | "run" | "clear-history" }
  | { target: NativeJobRef; baseline: string; action: "stop" | "drop"; force?: boolean };

export interface NativeJobLegacyCreate {
  kind: "legacy";
  what: string;
  nextDate: string;
  interval: string;
  enabled: boolean;
  instance?: number;
  schema?: string;
  zone?: string;
}

export interface NativeJobObjectReference {
  owner: string;
  name: string;
}

export type NativeJobEventSource = { kind: "queue"; owner: string; name: string; agent?: string } | { kind: "file-watcher"; reference: NativeJobObjectReference };

export interface NativeJobCreateArgument {
  position: number;
  dataType: string;
  value: NativeJobArgumentValue;
}

export interface NativeJobSchedulerCreate {
  kind: "scheduler";
  owner: string;
  name: string;
  program?: NativeJobObjectReference;
  jobType?: string;
  jobAction?: string;
  numberOfArguments: number;
  schedule?: NativeJobObjectReference;
  startDate?: string;
  repeatInterval?: string;
  endDate?: string;
  eventCondition?: string;
  eventSource?: NativeJobEventSource;
  enabled: boolean;
  autoDrop: boolean;
  jobClass?: string;
  jobStyle?: string;
  comments?: string;
  credentialName?: string;
  destinationName?: string;
  attributes?: NativeJobEdit["attributes"];
  arguments?: NativeJobCreateArgument[];
}

export interface NativeJobDamengCreate {
  kind: "dameng-native";
  name: string;
  enabled: boolean;
  configuration: NativeJobDamengConfiguration;
}

export type NativeJobRequest = NativeJobMutation | { action: "create"; scope: NativeJobScope; definition: NativeJobLegacyCreate | NativeJobSchedulerCreate | NativeJobDamengCreate };

export interface NativeJobPreparedPlan {
  planId: string;
  operationId: string;
  scope: NativeJobScope;
  target: NativeJobRef | null;
  steps: { id: string; label: string; sql: string }[];
}

export interface NativeJobOperationStatus {
  operationId: string;
  target: NativeJobRef | null;
  observedIdentity?: NativeJobRow;
  createdChildren?: { partition: "steps" | "schedules"; name: string; id: string }[];
  executionObservation?: NativeJobExecutionObservation;
  state: "prepared" | "queued" | "running" | "finished";
  outcome: "not_started" | "not_applied" | "partial" | "unknown" | "verified" | "accepted";
  cancelRequested: boolean;
  steps: {
    id: string;
    state: "pending" | "dispatching" | "applied" | "accepted" | "failed" | "unknown" | "skipped";
    reason: string | null;
    vendorCode: number | null;
  }[];
  reason: string | null;
}

export interface NativeJobExecutionObservation {
  observedAt: string;
  association: "uncertain" | "unavailable";
  reason: string;
  running: NativeJobMetadata<NativeJobRow[]>;
  history: NativeJobMetadata<NativeJobRow[]>;
  sources: Record<string, NativeJobCatalogSource>;
  candidates: { nativeKey: string; phase: "running" | "history" | "not-observed"; evidence: "running-log-id" | "new-history"; row: NativeJobRow }[];
}

function identityPart(value: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new TypeError("native_job_identity_invalid");
  }
  return value;
}

function numericJobId(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError("native_job_id_invalid");
  }
  return value;
}

/** Exact components, not a display label or a SQL-qualified name. */
export function nativeJobRefKey(ref: NativeJobRef): string {
  const scope = [identityPart(ref.scope.connectionId), identityPart(ref.scope.database, true), identityPart(ref.scope.contextId)];
  switch (ref.kind) {
    case "scheduler":
      return JSON.stringify([...scope, ref.kind, identityPart(ref.owner), identityPart(ref.name)]);
    case "legacy":
      return JSON.stringify([...scope, ref.kind, numericJobId(ref.jobId)]);
    case "dameng-native":
      return JSON.stringify([...scope, ref.kind, numericJobId(ref.jobId), identityPart(ref.name)]);
  }
}

/** Oracle's object-name argument; SQL string binding/escaping is a separate step. */
export function oracleSchedulerObjectName(ref: NativeJobRef): string {
  if (ref.kind !== "scheduler") throw new TypeError("native_job_not_scheduler");
  const quote = (value: string) => `"${identityPart(value).replace(/"/g, '""')}"`;
  return `${quote(ref.owner)}.${quote(ref.name)}`;
}

function sameValue(left: NativeJobValue | undefined, right: NativeJobValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]!));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]!));
}

function copyValue(value: NativeJobValue): NativeJobValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copyValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyValue(entry)]));
}

function attributeChanges(definition: NativeJobSnapshot["definition"], draft: NativeJobEditDraft["attributes"]): NativeJobEdit["attributes"] {
  const requested = Object.entries(draft ?? {}).filter(([, change]) => change.kind !== "keep");
  if (requested.length && definition.status !== "available") {
    throw new Error("native_job_definition_unavailable");
  }
  const attributes: NativeJobEdit["attributes"] = [];
  if (definition.status === "available") {
    for (const [name, change] of requested) {
      const previous = definition.value[name];
      if (change.kind === "set" && !sameValue(previous, change.value)) {
        attributes.push({ name, change: { kind: "set", value: copyValue(change.value) } });
      } else if (change.kind === "clear" && previous !== null) {
        attributes.push({ name, change: { kind: "clear" } });
      }
    }
  }
  return attributes;
}

/** Build the minimal edit request; the backend prepares and validates its execution plan. */
export function buildNativeJobEdit(snapshot: NativeJobSnapshot, draft: NativeJobEditDraft): NativeJobEdit {
  nativeJobRefKey(snapshot.ref);
  if (!snapshot.revision) throw new TypeError("native_job_baseline_missing");
  const attributes = attributeChanges(snapshot.definition, draft.attributes);
  const argumentEdits: NativeJobEdit["arguments"] = [];
  if (draft.arguments?.length) {
    if (snapshot.arguments.status !== "available" && snapshot.arguments.status !== "empty") {
      throw new Error("native_job_arguments_unavailable");
    }
    const original = new Map(snapshot.arguments.status === "available" ? snapshot.arguments.value.map((argument) => [argument.position, argument]) : []);
    const seen = new Set<number>();
    for (const change of draft.arguments) {
      if (!Number.isSafeInteger(change.position) || change.position < 1 || seen.has(change.position)) {
        throw new TypeError("native_job_argument_position_invalid");
      }
      seen.add(change.position);
      const argument = original.get(change.position);
      if (!argument) throw new Error("native_job_argument_missing");
      if (sameValue(argument.value, change.value)) continue;
      if (!argument.editable || change.value.kind === "opaque") throw new Error("native_job_argument_not_editable");
      const value = change.value.kind === "value" ? { kind: "value" as const, value: copyValue(change.value.value) } : { ...change.value };
      argumentEdits.push({ position: change.position, value });
    }
    argumentEdits.sort((left, right) => left.position - right.position);
  }
  return {
    action: "update",
    target: { ...snapshot.ref, scope: { ...snapshot.ref.scope } },
    baseline: snapshot.revision,
    attributes,
    arguments: argumentEdits,
  };
}

function damengAttributeChanges(row: NativeJobRow, draft: NativeJobEditDraft["attributes"]): NativeJobEdit["attributes"] {
  const comparison = { ...row };
  for (const name of ["ENABLE", "ENABLE_EMAIL", "ENABLE_NETSEND", "APPEND_FLAG"]) {
    const change = draft?.[name];
    if (change?.kind === "set" && typeof change.value === "boolean" && [0, 1, "0", "1", true, false].includes(row[name] as string | number | boolean)) comparison[name] = row[name] === 1 || row[name] === "1" || row[name] === true;
  }
  return attributeChanges({ status: "available", value: comparison }, draft);
}

function damengChildChanges(metadata: NativeJobMetadata<NativeJobRow[]>, part: "steps" | "schedules", drafts: NativeJobDamengChildDraft[] = []): NativeJobDamengChildChange[] {
  if (!drafts.length) return [];
  if (metadata.status !== "available" && metadata.status !== "empty") throw new Error("native_job_metadata_incomplete");
  const rows = metadata.status === "available" ? metadata.value : [];
  const byName = new Map<string, NativeJobRow>();
  for (const row of rows) {
    if (typeof row.NAME !== "string" || byName.has(row.NAME)) throw new Error("native_job_child_identity_ambiguous");
    byName.set(row.NAME, row);
  }
  const changes: NativeJobDamengChildChange[] = [];
  for (const draft of drafts) {
    const previous = byName.get(draft.name);
    if (draft.kind !== "add" && !previous) throw new Error("native_job_child_missing");
    if (draft.kind === "drop") {
      changes.push({ kind: "drop", name: draft.name });
      continue;
    }
    const fields = { ...(draft.kind === "add" ? {} : previous) };
    const wantedType = draft.attributes?.TYPE;
    const sqlType = (value: NativeJobValue | undefined) => value === 0 || value === "0";
    if (part === "steps" && previous?.COMMAND !== undefined && sqlType(previous.TYPE) && (wantedType?.kind === "set" ? sqlType(wantedType.value) : wantedType?.kind !== "clear")) {
      fields.COMMAND_INPUT = previous.COMMAND;
    }
    const attributes = damengAttributeChanges(fields, draft.attributes);
    if (draft.kind === "add" || attributes.length) changes.push({ kind: draft.kind, name: draft.name, attributes });
  }
  return changes;
}

/** Rebase a retained draft onto a fresh complete read; generated backup/DTS commands stay opaque. */
export function buildNativeJobDamengEdit(details: NativeJobDetails, draft: NativeJobDamengEditDraft): Extract<NativeJobMutation, { action: "configure-dameng" }> {
  const base = buildNativeJobEdit(details.snapshot, { attributes: draft.attributes });
  if (base.target.kind !== "dameng-native") throw new TypeError("native_job_kind_invalid");
  return {
    action: "configure-dameng",
    target: base.target,
    baseline: base.baseline,
    configuration: {
      attributes: details.snapshot.definition.status === "available" ? damengAttributeChanges(details.snapshot.definition.value, draft.attributes) : base.attributes,
      steps: damengChildChanges(details.steps, "steps", draft.steps),
      schedules: damengChildChanges(details.schedules, "schedules", draft.schedules),
    },
  };
}

export function buildNativeJobDamengCreate(scope: NativeJobScope, name: string, draft: NativeJobDamengEditDraft): Extract<NativeJobRequest, { action: "create" }> {
  identityPart(scope.connectionId);
  identityPart(scope.contextId);
  identityPart(scope.database, true);
  identityPart(name);
  const enable = draft.attributes?.ENABLE;
  if (enable?.kind === "clear" || (enable?.kind === "set" && typeof enable.value !== "boolean")) throw new TypeError("native_job_attribute_type_invalid");
  for (const part of ["steps", "schedules"] as const) {
    if (draft[part]?.some((child) => child.kind !== "add")) throw new TypeError("native_job_creation_children_must_be_new");
  }
  return {
    action: "create",
    scope: { ...scope },
    definition: {
      kind: "dameng-native",
      name,
      enabled: enable?.kind === "set" ? (enable.value as boolean) : true,
      configuration: {
        attributes: damengAttributeChanges({}, draft.attributes).filter((attribute) => attribute.name !== "ENABLE"),
        steps: damengChildChanges({ status: "empty" }, "steps", draft.steps),
        schedules: damengChildChanges({ status: "empty" }, "schedules", draft.schedules),
      },
    },
  };
}

function damengChildId(row: NativeJobRow): string | undefined {
  const value = row.DBX_CHILD_ID ?? row.ID;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
}

/** Only this operation's acknowledged child IDs may turn retained creates into edits. */
export function rebaseNativeJobDamengCreation(details: NativeJobDetails, draft: NativeJobDamengEditDraft, status: NativeJobOperationStatus): NativeJobDamengEditDraft {
  if (!status.target || nativeJobRefKey(status.target) !== nativeJobRefKey(details.snapshot.ref)) throw new TypeError("native_job_identity_mismatch");
  const result: NativeJobDamengEditDraft = { attributes: Object.fromEntries(Object.entries(draft.attributes ?? {}).map(([name, change]) => [name, change.kind === "set" ? { ...change, value: copyValue(change.value) } : { ...change }])) };
  for (const part of ["steps", "schedules"] as const) {
    const metadata = details[part];
    const rows = metadata.status === "available" ? metadata.value : [];
    result[part] = (draft[part] ?? []).map((child) => {
      const receipt = status.createdChildren?.find((created) => created.partition === part && created.name === child.name);
      const matched = receipt && rows.some((row) => row.NAME === child.name && damengChildId(row) === receipt.id);
      return { ...child, kind: child.kind === "add" && matched ? "update" : child.kind, attributes: Object.fromEntries(Object.entries(child.attributes ?? {}).map(([name, change]) => [name, change.kind === "set" ? { ...change, value: copyValue(change.value) } : { ...change }])) };
    });
  }
  return result;
}

export function rebaseNativeJobDamengDraft(before: NativeJobDetails, after: NativeJobDetails, draft: NativeJobDamengEditDraft, status: NativeJobOperationStatus, sessionUser: string): NativeJobDamengEditDraft {
  const original = before.snapshot.ref;
  const effective = after.snapshot.ref;
  if (original.kind !== "dameng-native" || effective.kind !== "dameng-native" || original.jobId !== effective.jobId || ["connectionId", "database", "contextId"].some((key) => original.scope[key as keyof NativeJobScope] !== effective.scope[key as keyof NativeJobScope]))
    throw new TypeError("native_job_identity_mismatch");
  if (
    before.nativeIdentity.status !== "available" ||
    after.nativeIdentity.status !== "available" ||
    ["DBX_JOB_ID", "DBX_CREATED_AT"].some((key) => before.nativeIdentity.status !== "available" || after.nativeIdentity.status !== "available" || before.nativeIdentity.value[key] !== after.nativeIdentity.value[key])
  )
    throw new TypeError("native_job_identity_mismatch");
  const result = rebaseNativeJobDamengCreation(after, draft, status);
  const known = status.outcome !== "unknown";
  if (known && after.snapshot.definition.status === "available") result.attributes = Object.fromEntries(damengAttributeChanges(after.snapshot.definition.value, result.attributes).map(({ name, change }) => [name, change]));
  for (const part of ["steps", "schedules"] as const) {
    const previous = before[part];
    const current = after[part];
    if ((current.status !== "available" && current.status !== "empty") || previous.status !== "available") continue;
    const coverage = after.sources[part]?.coverage;
    const complete = coverage === "database" || coverage === "accessible" || (coverage === "current_user" && after.snapshot.definition.status === "available" && after.snapshot.definition.value.USERNAME === sessionUser);
    const rows = current.status === "available" ? current.value : [];
    result[part] = (result[part] ?? []).flatMap<NativeJobDamengChildDraft>((child) => {
      if (child.kind === "add") return [child];
      const original = previous.value.find((row) => row.NAME === child.name);
      const originalId = original && damengChildId(original);
      const matches = originalId ? rows.filter((row) => damengChildId(row) === originalId) : [];
      if (matches.length !== 1) return known && complete && child.kind === "drop" && originalId && !matches.length ? [] : [child];
      const row = matches[0]!;
      if (typeof row.NAME !== "string") return [child];
      const renamed = { ...child, name: row.NAME };
      if (!known || child.kind === "drop") return [renamed];
      const baseline = { ...row, ...(part === "steps" && (row.TYPE === 0 || row.TYPE === "0") ? { COMMAND_INPUT: row.COMMAND! } : {}) };
      renamed.attributes = Object.fromEntries(damengAttributeChanges(baseline, child.attributes).map(({ name, change }) => [name, change]));
      return Object.keys(renamed.attributes).length ? [renamed] : [];
    });
  }
  return result;
}
