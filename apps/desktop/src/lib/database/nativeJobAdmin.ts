import { effectiveDatabaseTypeForConnection, type JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import {
  buildNativeJobEdit,
  nativeJobRefKey,
  type NativeJobArgument,
  type NativeJobArgumentValue,
  type NativeJobCreateArgument,
  type NativeJobDetails,
  type NativeJobEdit,
  type NativeJobEditDraft,
  type NativeJobEngine,
  type NativeJobEventSource,
  type NativeJobKind,
  type NativeJobMetadata,
  type NativeJobObjectReference,
  type NativeJobOperationStatus,
  type NativeJobReferenceKind,
  type NativeJobRequest,
  type NativeJobRow,
  type NativeJobScope,
  type NativeJobSnapshot,
  type NativeJobValue,
} from "@/lib/database/nativeJobs";

export interface NativeJobDefinitionDraft extends NativeJobEditDraft {
  finalEnabled?: boolean;
  originalSnapshot?: NativeJobSnapshot;
  reconcileArguments?: boolean;
  transitionRetained?: boolean;
  argumentLayouts?: Record<string, NativeJobMetadata<NativeJobArgument[]>>;
  referenceKinds?: Record<string, NativeJobReferenceKind>;
  scheduleMode?: NativeJobScheduleMode;
  destinationMode?: NativeJobDestinationMode;
  eventDraft?: NativeJobEventDraft;
  argumentTypes?: Record<number, string>;
  argumentContext?: string;
  argumentDrafts?: Record<string, { arguments: NonNullable<NativeJobEditDraft["arguments"]>; argumentTypes: Record<number, string> }>;
}

export type NativeJobScheduleMode = "inline" | "named" | "queue" | "file-watcher";
export type NativeJobDestinationMode = "local" | "legacy" | "named";
export function nativeJobDestinationMode(draft: NativeJobDefinitionDraft, definition: NativeJobRow): NativeJobDestinationMode {
  if (draft.destinationMode) return draft.destinationMode;
  if (typeof definition.DESTINATION_OWNER === "string" && definition.DESTINATION_OWNER) return "named";
  return typeof definition.DESTINATION === "string" && definition.DESTINATION ? "legacy" : "local";
}
export interface NativeJobEventDraft {
  condition: string;
  queueOwner: string;
  queueName: string;
  agent: string;
  watcherOwner: string;
  watcherName: string;
}

export function nativeJobEventDraft(definition: NativeJobRow): NativeJobEventDraft {
  const text = (name: string) => (typeof definition[name] === "string" ? definition[name] : "");
  return { condition: text("EVENT_CONDITION"), queueOwner: text("EVENT_QUEUE_OWNER"), queueName: text("EVENT_QUEUE_NAME"), agent: text("EVENT_QUEUE_AGENT"), watcherOwner: text("FILE_WATCHER_OWNER"), watcherName: text("FILE_WATCHER_NAME") };
}

export function nativeJobScheduleMode(draft: NativeJobDefinitionDraft, definition: NativeJobRow = {}): NativeJobScheduleMode {
  if (draft.scheduleMode) return draft.scheduleMode;
  const change = draft.attributes?.SCHEDULE_NAME;
  const name = change?.kind === "set" ? change.value : change?.kind === "clear" ? null : definition.SCHEDULE_NAME;
  if (name) return "named";
  if (definition.FILE_WATCHER_NAME) return "file-watcher";
  if (definition.EVENT_QUEUE_NAME) return "queue";
  return "inline";
}

function eventTrigger(draft: NativeJobDefinitionDraft): { condition: string | null; source: NativeJobEventSource & NativeJobValue } {
  const input = draft.eventDraft;
  if (!input) throw new TypeError("native_job_event_queue_required");
  const valid = (value: string) => value !== "" && !value.includes("\0");
  if (draft.scheduleMode === "file-watcher") {
    if (!valid(input.watcherOwner) || !valid(input.watcherName)) throw new TypeError("native_job_event_queue_required");
    return { condition: input.condition || null, source: { kind: "file-watcher", reference: { owner: input.watcherOwner, name: input.watcherName } } };
  }
  if (!valid(input.queueOwner) || !valid(input.queueName) || (input.agent && !valid(input.agent))) throw new TypeError("native_job_event_queue_required");
  return { condition: input.condition || null, source: { kind: "queue", owner: input.queueOwner, name: input.queueName, ...(input.agent ? { agent: input.agent } : {}) } };
}

/** Change the next draft, not the database; the normal fresh read/preview/confirm path still applies. */
export function restoreNativeJobDefinitionDraft(draft: NativeJobDefinitionDraft, details?: NativeJobDetails): void {
  const initial = draft.originalSnapshot;
  if (initial?.ref.kind !== "scheduler" || initial.definition.status !== "available") throw new TypeError("native_job_definition_unavailable");
  const projected = nativeJobDefinitionForEdit("oracle", "scheduler", initial.definition);
  if (projected.status !== "available") return;
  const original = projected.value;
  const names = new Set([...Object.keys(draft.attributes ?? {}), "PROGRAM_OWNER", "PROGRAM_NAME", "JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS", "SCHEDULE_OWNER", "SCHEDULE_NAME", "START_DATE", "END_DATE", "REPEAT_INTERVAL", "EVENT_SPEC", "DESTINATION", "DESTINATION_NAME"]);
  const attributes: NonNullable<NativeJobEditDraft["attributes"]> = {};
  for (const name of names) {
    const value = original[name];
    if (name !== "ENABLED" && value !== undefined) attributes[name] = value === null ? { kind: "clear" } : { kind: "set", value: structuredCloneValue(value) };
  }
  selectNativeJobArgumentContext(draft, typeof original.PROGRAM_OWNER === "string" ? original.PROGRAM_OWNER : "", typeof original.PROGRAM_NAME === "string" ? original.PROGRAM_NAME : undefined);
  draft.attributes = details ? Object.fromEntries(buildNativeJobEdit({ ...details.snapshot, definition: nativeJobDefinitionForEdit("oracle", "scheduler", details.snapshot.definition) }, { attributes }).attributes.map((attribute) => [attribute.name, attribute.change])) : attributes;
  draft.arguments = [];
  draft.argumentTypes = {};
  draft.eventDraft = nativeJobEventDraft(initial.definition.value);
  draft.scheduleMode = nativeJobScheduleMode({}, initial.definition.value);
  draft.destinationMode = nativeJobDestinationMode({}, initial.definition.value);
  draft.referenceKinds = { SCHEDULE_NAME: initial.definition.value.SCHEDULE_TYPE === "WINDOW" ? "window" : initial.definition.value.SCHEDULE_TYPE === "WINDOW_GROUP" ? "window-group" : "schedule" };
  draft.reconcileArguments ||= initial.arguments.status === "available";
  draft.transitionRetained = true;
  const enabled = initial.definition.value.ENABLED;
  if ([true, 1, "1", "TRUE", "true"].includes(enabled as string | number | boolean)) draft.finalEnabled = true;
  else if ([false, 0, "0", "FALSE", "false"].includes(enabled as string | number | boolean)) draft.finalEnabled = false;
}

/** Keep the pre-conversion intent even when a later read observes the paused job. */
export function initializeNativeJobDefinitionEdit(details: NativeJobDetails, draft: NativeJobDefinitionDraft): void {
  if (details.snapshot.ref.kind !== "scheduler" || details.snapshot.definition.status !== "available") return;
  const original = details.snapshot.definition.value;
  draft.originalSnapshot ??= structuredCloneValue(details.snapshot);
  if (draft.finalEnabled === undefined) {
    const enabled = original.ENABLED;
    if ([true, 1, "1", "TRUE", "true"].includes(enabled as string | number | boolean)) draft.finalEnabled = true;
    else if ([false, 0, "0", "FALSE", "false"].includes(enabled as string | number | boolean)) draft.finalEnabled = false;
  }
  if (!draft.argumentContext) {
    selectNativeJobArgumentContext(draft, typeof original.PROGRAM_OWNER === "string" ? original.PROGRAM_OWNER : "", typeof original.PROGRAM_NAME === "string" ? original.PROGRAM_NAME : undefined);
    draft.argumentLayouts ??= {};
    draft.argumentLayouts[draft.argumentContext!] = structuredCloneValue(details.snapshot.arguments);
  }
}

function argumentContext(owner: string, program?: string): string {
  return program ? JSON.stringify([owner, program]) : "inline";
}

/** Keep inactive inline/Program overrides in the draft, never apply them to another program. */
export function selectNativeJobArgumentContext(draft: NativeJobDefinitionDraft, owner: string, program?: string): void {
  const key = argumentContext(owner, program);
  if (draft.argumentContext && draft.argumentContext !== key) {
    if (draft.originalSnapshot) draft.reconcileArguments = true;
    draft.argumentDrafts ??= {};
    draft.argumentDrafts[draft.argumentContext] = { arguments: structuredCloneValue(draft.arguments ?? []), argumentTypes: { ...draft.argumentTypes } };
    const saved = draft.argumentDrafts[key];
    draft.arguments = structuredCloneValue(saved?.arguments ?? []);
    draft.argumentTypes = { ...saved?.argumentTypes };
  }
  draft.argumentContext = key;
}

/** Exact component references and the retained target inventory use the existing edit request. */
export function buildNativeJobDefinitionEdit(details: NativeJobDetails, engine: NativeJobEngine, draft: NativeJobDefinitionDraft): NativeJobEdit {
  const snapshot = { ...details.snapshot, definition: nativeJobDefinitionForEdit(engine, details.snapshot.ref.kind, details.snapshot.definition, details.legacyDefinition) };
  if (snapshot.ref.kind !== "scheduler") return buildNativeJobEdit(snapshot, draft);
  if (snapshot.definition.status !== "available") return buildNativeJobEdit(snapshot, draft);
  const original = snapshot.definition.value;
  const explicitFinalChange = draft.finalEnabled !== undefined && draft.originalSnapshot?.definition.status === "available" && [true, "TRUE", "true", 1, "1"].includes(draft.originalSnapshot.definition.value.ENABLED as string | number | boolean) !== draft.finalEnabled;
  if (
    !draft.reconcileArguments &&
    !draft.transitionRetained &&
    !draft.scheduleMode &&
    !draft.destinationMode &&
    !explicitFinalChange &&
    !Object.entries(draft.attributes ?? {}).some(
      ([name, change]) => change.kind !== "keep" && ["PROGRAM_OWNER", "PROGRAM_NAME", "SCHEDULE_OWNER", "SCHEDULE_NAME", "JOB_TYPE", "NUMBER_OF_ARGUMENTS", "CREDENTIAL_NAME", "CONNECT_CREDENTIAL_NAME", "DESTINATION", "DESTINATION_NAME", "EVENT_SPEC"].includes(name),
    )
  )
    return buildNativeJobEdit(snapshot, draft);
  const attributes = structuredCloneValue(draft.attributes ?? {});
  if (engine === "oracle" && draft.destinationMode) {
    if (draft.destinationMode === "local") {
      delete attributes.DESTINATION;
      delete attributes.DESTINATION_NAME;
      if (original.DESTINATION_NAME !== undefined && original.DESTINATION_NAME !== null) attributes.DESTINATION_NAME = { kind: "clear" };
      else if (original.DESTINATION !== undefined && original.DESTINATION !== null) attributes.DESTINATION = { kind: "clear" };
    } else {
      const active = draft.destinationMode === "legacy" ? "DESTINATION" : "DESTINATION_NAME";
      delete attributes[active === "DESTINATION" ? "DESTINATION_NAME" : "DESTINATION"];
      const previous = active === "DESTINATION" && original.DESTINATION_OWNER !== null ? null : original[active];
      const selected = attributes[active]?.kind === "set" ? attributes[active].value : attributes[active]?.kind === "clear" ? null : previous;
      if (selected === null || selected === undefined || selected === "") throw new TypeError("native_job_reference_input_invalid");
    }
  }
  if (draft.scheduleMode) {
    if (draft.scheduleMode !== "named") {
      attributes.SCHEDULE_NAME = { kind: "clear" };
      delete attributes.SCHEDULE_OWNER;
    }
    if (draft.scheduleMode === "queue" || draft.scheduleMode === "file-watcher") {
      attributes.EVENT_SPEC = { kind: "set", value: eventTrigger(draft) };
      delete attributes.REPEAT_INTERVAL;
    } else if (draft.scheduleMode === "inline") {
      if (original.EVENT_SPEC !== undefined && original.EVENT_SPEC !== null) attributes.EVENT_SPEC = { kind: "clear" };
      else delete attributes.EVENT_SPEC;
    }
  }
  const value = (name: string) => (attributes[name]?.kind === "set" ? attributes[name].value : attributes[name]?.kind === "clear" ? null : original[name]);
  const componentReference = (prefix: "PROGRAM" | "SCHEDULE"): NativeJobObjectReference | null => {
    const name = value(`${prefix}_NAME`);
    if (name === undefined || name === null || name === "") return null;
    if (typeof name === "object" && !Array.isArray(name) && typeof name.owner === "string" && typeof name.name === "string") return { owner: name.owner, name: name.name };
    const owner = value(`${prefix}_OWNER`);
    if (typeof owner !== "string" || !owner || typeof name !== "string" || !name || owner.includes("\0") || name.includes("\0")) throw new TypeError("native_job_reference_input_invalid");
    return { owner, name };
  };
  const touches = (names: string[]) => names.some((name) => attributes[name] && attributes[name].kind !== "keep");
  const programSelected = value("PROGRAM_NAME") !== undefined && value("PROGRAM_NAME") !== null && value("PROGRAM_NAME") !== "";
  const program = draft.reconcileArguments || touches(["PROGRAM_OWNER", "PROGRAM_NAME", "JOB_TYPE", "NUMBER_OF_ARGUMENTS"]) ? componentReference("PROGRAM") : null;
  for (const prefix of ["PROGRAM", "SCHEDULE"] as const) {
    const name = `${prefix}_NAME`,
      owner = `${prefix}_OWNER`;
    const supplied = touches([name, owner]);
    const reference = supplied ? componentReference(prefix) : null;
    delete attributes[owner];
    if (supplied) {
      const originalKind = prefix === "PROGRAM" ? "program" : original.SCHEDULE_TYPE === "WINDOW" ? "window" : original.SCHEDULE_TYPE === "WINDOW_GROUP" ? "window-group" : "schedule";
      const wantedKind = draft.referenceKinds?.[name] ?? originalKind;
      const same = reference ? original[name] === reference.name && original[owner] === reference.owner && wantedKind === originalKind : original[name] === null || original[name] === undefined;
      if (same) delete attributes[name];
      else attributes[name] = reference ? { kind: "set", value: { ...reference, ...(wantedKind !== (prefix === "PROGRAM" ? "program" : "schedule") ? { kind: wantedKind } : {}) } } : { kind: "clear" };
    }
  }
  if (programSelected) for (const name of ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"]) delete attributes[name];
  if (value("SCHEDULE_NAME") !== undefined && value("SCHEDULE_NAME") !== null && value("SCHEDULE_NAME") !== "") for (const name of ["START_DATE", "END_DATE", "REPEAT_INTERVAL", "EVENT_SPEC"]) delete attributes[name];
  const request = buildNativeJobEdit(snapshot, { attributes });
  const contextChanged = request.attributes.some(({ name }) => ["PROGRAM_NAME", "JOB_TYPE", "NUMBER_OF_ARGUMENTS"].includes(name));
  const reconcile = contextChanged || draft.reconcileArguments === true;
  const transition =
    reconcile ||
    draft.transitionRetained ||
    request.attributes.some(({ name }) => ["PROGRAM_NAME", "SCHEDULE_NAME", "CREDENTIAL_NAME", "CONNECT_CREDENTIAL_NAME", "DESTINATION", "DESTINATION_NAME", "EVENT_SPEC"].includes(name)) ||
    (draft.finalEnabled !== undefined && draft.originalSnapshot?.definition.status === "available" && [true, "TRUE", "true", 1, "1"].includes(draft.originalSnapshot.definition.value.ENABLED as string | number | boolean) !== draft.finalEnabled);
  if (!transition) return buildNativeJobEdit(snapshot, { attributes, arguments: draft.arguments });
  if (draft.finalEnabled !== undefined) request.finalEnabled = draft.finalEnabled;
  if (!reconcile) {
    request.arguments = buildNativeJobEdit(snapshot, { arguments: draft.arguments }).arguments;
    return request;
  }
  const context = argumentContext(program?.owner ?? snapshot.ref.owner, program?.name);
  let layout = draft.argumentLayouts?.[context];
  if (!program) {
    const nativeCount = value("NUMBER_OF_ARGUMENTS");
    const count = typeof nativeCount === "string" && /^\d+$/.test(nativeCount) ? Number(nativeCount) : nativeCount;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 255) throw new TypeError("native_job_argument_count_invalid");
    const saved = layout?.status === "available" ? layout.value : [];
    layout = { status: "available", value: Array.from({ length: count }, (_, index) => saved.find((argument) => argument.position === index + 1) ?? { position: index + 1, dataType: draft.argumentTypes?.[index + 1] ?? "UNKNOWN", value: { kind: "unset" }, editable: true }) };
  }
  if (layout?.status !== "available") throw new TypeError("native_job_argument_target_unavailable");
  const active = draft.argumentContext === context ? draft : draft.argumentDrafts?.[context];
  request.argumentTarget = {
    program,
    arguments: nativeJobArgumentBaseline(draft, context, layout.value).map((argument) => {
      const change = active?.arguments?.find((change) => change.position === argument.position);
      const value = change?.value ?? argument.value;
      if (value.kind === "opaque") throw new TypeError("native_job_argument_not_editable");
      return { position: argument.position, dataType: active?.argumentTypes?.[argument.position] ?? argument.dataType, value: structuredCloneValue(value) };
    }),
  };
  return request;
}

/** Original overrides belong only to their original context, not the same position in a new one. */
export function nativeJobArgumentBaseline(draft: NativeJobDefinitionDraft, context: string, layout: NativeJobArgument[]): NativeJobArgument[] {
  const initial = draft.originalSnapshot;
  const definition = initial?.definition.status === "available" ? initial.definition.value : undefined;
  const originalContext = argumentContext(typeof definition?.PROGRAM_OWNER === "string" ? definition.PROGRAM_OWNER : "", typeof definition?.PROGRAM_NAME === "string" ? definition.PROGRAM_NAME : undefined);
  const originals = context === originalContext && initial?.arguments.status === "available" ? initial.arguments.value : [];
  return layout.map((argument) => {
    const original = originals.find((original) => original.position === argument.position);
    return { ...argument, value: structuredCloneValue(original?.value ?? argument.value), editable: argument.editable && original?.value.kind !== "opaque" };
  });
}

export function nativeJobProgramArgumentLayout(program: NativeJobMetadata<NativeJobRow> | undefined, argumentsMetadata: NativeJobMetadata<NativeJobRow[]> | undefined): NativeJobMetadata<NativeJobArgument[]> {
  if (program?.status !== "available") return { status: "unknown", reason: "native_job_program_argument_count_unavailable" };
  const count = Number(program.value.NUMBER_OF_ARGUMENTS);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000 || program.value.NUMBER_OF_ARGUMENTS === null) return { status: "unknown", reason: "native_job_argument_count_unavailable" };
  if (argumentsMetadata?.status !== "available" && argumentsMetadata?.status !== "empty")
    return argumentsMetadata?.status === "truncated" ? { status: "unknown", reason: "native_job_arguments_truncated" } : (argumentsMetadata ?? { status: "unknown", reason: "native_job_argument_target_unavailable" });
  const rows = argumentsMetadata.status === "available" ? argumentsMetadata.value : [];
  if (rows.length !== count || new Set(rows.map((row) => Number(row.ARGUMENT_POSITION))).size !== count || rows.some((row) => !Number.isInteger(Number(row.ARGUMENT_POSITION)) || Number(row.ARGUMENT_POSITION) < 1 || Number(row.ARGUMENT_POSITION) > count))
    return { status: "unknown", reason: "native_job_argument_target_unavailable" };
  return {
    status: "available",
    value: rows
      .map<NativeJobArgument>((row) => {
        const metadataAttribute = typeof row.METADATA_ATTRIBUTE === "string" && row.METADATA_ATTRIBUTE ? row.METADATA_ATTRIBUTE : undefined;
        const decodedDefault = row.DBX_ARGUMENT_DEFAULT as unknown as NativeJobMetadata<NativeJobArgumentValue> | undefined;
        const hasAnydata = Object.prototype.hasOwnProperty.call(row, "DBX_ANYDATA_PRESENT") ? ![false, 0, "0", "FALSE", "false"].includes(row.DBX_ANYDATA_PRESENT as string | number | boolean) : row.DEFAULT_ANYDATA_VALUE !== undefined && row.DEFAULT_ANYDATA_VALUE !== null;
        return {
          position: Number(row.ARGUMENT_POSITION),
          name: typeof row.ARGUMENT_NAME === "string" ? row.ARGUMENT_NAME : undefined,
          dataType: typeof row.ARGUMENT_TYPE === "string" ? row.ARGUMENT_TYPE : "UNKNOWN",
          value: { kind: "inherit" },
          metadataAttribute,
          editable: !metadataAttribute && [undefined, null, false, 0, "0", "FALSE", "false"].includes(row.OUT_ARGUMENT as string | number | boolean | null | undefined),
          defaultValue: metadataAttribute
            ? undefined
            : decodedDefault
              ? decodedDefault
              : hasAnydata
                ? { status: "available", value: { kind: "opaque", value: row.DEFAULT_ANYDATA_VALUE ?? row } }
                : row.DEFAULT_VALUE !== undefined && row.DEFAULT_VALUE !== null
                  ? { status: "available", value: { kind: "value", value: row.DEFAULT_VALUE } }
                  : { status: "unknown", reason: "native_job_program_default_ambiguous" },
        };
      })
      .sort((a, b) => a.position - b.position),
  };
}

export function nativeJobAdminEngine(connection?: JdbcDialectConnection): NativeJobEngine | undefined {
  if (connection?.db_type === "jdbc" && connection.database_info?.productName?.toLowerCase() === "oceanbase") {
    return connection.database_info.compatibilityMode?.toLowerCase() === "oracle" ? "oceanbase-oracle" : undefined;
  }
  const type = effectiveDatabaseTypeForConnection(connection);
  return type === "oracle" || type === "oceanbase-oracle" || type === "dameng" ? type : undefined;
}

export function nativeJobAdminSupported(connection?: JdbcDialectConnection): boolean {
  return nativeJobAdminEngine(connection) !== undefined;
}

export function nativeJobAdminKinds(engine: NativeJobEngine): NativeJobKind[] {
  return engine === "dameng" ? ["dameng-native", "scheduler", "legacy"] : ["scheduler", "legacy"];
}

/** Editor aliases retain native columns and exact reference components; they never mutate the read. */
export function nativeJobDefinitionForEdit(engine: NativeJobEngine, kind: NativeJobKind, definition: NativeJobDetails["snapshot"]["definition"], legacyDefinition?: NativeJobDetails["legacyDefinition"]): NativeJobDetails["snapshot"]["definition"] {
  if (engine === "dameng" && kind === "legacy" && definition.status === "available" && legacyDefinition?.status === "available") {
    return { status: "available", value: { ...definition.value, ...legacyDefinition.value } };
  }
  if (engine === "oceanbase-oracle" && kind === "legacy" && definition.status === "available" && Object.prototype.hasOwnProperty.call(definition.value, "INSTANCE")) {
    return { status: "available", value: { ...definition.value, ZONE: definition.value.INSTANCE! } };
  }
  if (engine === "oracle" && kind === "scheduler" && definition.status === "available") {
    const value = { ...definition.value };
    for (const [field, owner, name] of [
      ["CREDENTIAL_NAME", "CREDENTIAL_OWNER", "CREDENTIAL_NAME"],
      ["CONNECT_CREDENTIAL_NAME", "CONNECT_CREDENTIAL_OWNER", "CONNECT_CREDENTIAL_NAME"],
      ["DESTINATION_NAME", "DESTINATION_OWNER", "DESTINATION"],
    ]) {
      if (value[name!] === null) value[field!] = null;
      else if (typeof value[owner!] === "string" && value[owner!] && typeof value[name!] === "string" && value[name!]) value[field!] = { owner: value[owner!]!, name: value[name!]! };
    }
    if (value.FILE_WATCHER_OWNER && value.FILE_WATCHER_NAME) value.EVENT_SPEC = { condition: value.EVENT_CONDITION ?? null, source: { kind: "file-watcher", reference: { owner: value.FILE_WATCHER_OWNER, name: value.FILE_WATCHER_NAME } } };
    else if (value.EVENT_QUEUE_OWNER && value.EVENT_QUEUE_NAME) value.EVENT_SPEC = { condition: value.EVENT_CONDITION ?? null, source: { kind: "queue", owner: value.EVENT_QUEUE_OWNER, name: value.EVENT_QUEUE_NAME, ...(value.EVENT_QUEUE_AGENT ? { agent: value.EVENT_QUEUE_AGENT } : {}) } };
    else if (["EVENT_CONDITION", "EVENT_QUEUE_NAME", "FILE_WATCHER_NAME"].some((name) => Object.prototype.hasOwnProperty.call(value, name))) value.EVENT_SPEC = null;
    return { status: "available", value };
  }
  return definition;
}

export type NativeJobAdminSelection = { kind: "scheduler"; owner: string; name: string } | { kind: "legacy"; jobId: string } | { kind: "dameng-native"; jobId: string; name: string };

export function nativeJobAdminSelection(ref: NativeJobAdminSelection): NativeJobAdminSelection {
  switch (ref.kind) {
    case "scheduler":
      return { kind: ref.kind, owner: ref.owner, name: ref.name };
    case "legacy":
      return { kind: ref.kind, jobId: ref.jobId };
    case "dameng-native":
      return { kind: ref.kind, jobId: ref.jobId, name: ref.name };
  }
}

export function nativeJobAdminSelectionKey(ref: NativeJobAdminSelection): string {
  return JSON.stringify(nativeJobAdminSelection(ref));
}

function localDateTime(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function newNativeJobDefinitionDraft(kind: "scheduler" | "legacy"): NativeJobDefinitionDraft {
  const values: Record<string, NativeJobValue> =
    kind === "legacy" ? { WHAT: "BEGIN NULL; END;", NEXT_DATE: localDateTime(), INTERVAL: "NULL", INSTANCE: 0, ENABLED: false } : { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN NULL; END;", NUMBER_OF_ARGUMENTS: 0, START_DATE: new Date().toISOString(), AUTO_DROP: true, ENABLED: false };
  return { attributes: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { kind: "set" as const, value }])), arguments: [], argumentContext: "inline" };
}

export function buildNativeJobDefinitionCreate(scope: NativeJobScope, engine: NativeJobEngine, kind: "scheduler" | "legacy", owner: string, name: string, draft: NativeJobDefinitionDraft): Extract<NativeJobRequest, { action: "create" }> {
  const value = (key: string, fallback?: NativeJobValue) => {
    const change = draft.attributes?.[key];
    return change?.kind === "set" ? change.value : change?.kind === "clear" ? null : fallback;
  };
  const text = (key: string, fallback = ""): string => {
    const result = value(key, fallback);
    if (typeof result !== "string") throw new TypeError("native_job_attribute_type_invalid");
    return result;
  };
  const optional = (key: string): string | undefined => {
    const result = value(key);
    if (result === undefined || result === null || result === "") return undefined;
    if (typeof result !== "string") throw new TypeError("native_job_attribute_type_invalid");
    return result;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const result = value(key, fallback);
    if (typeof result !== "boolean") throw new TypeError("native_job_attribute_type_invalid");
    return result;
  };
  const number = (key: string): number => {
    const result = value(key, 0);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new TypeError("native_job_attribute_type_invalid");
    return result;
  };
  if (kind === "legacy") {
    return {
      action: "create",
      scope: { ...scope },
      definition: { kind, what: text("WHAT"), nextDate: text("NEXT_DATE"), interval: text("INTERVAL", "NULL"), enabled: flag("ENABLED", false), schema: owner, ...(engine === "oceanbase-oracle" ? { zone: optional("ZONE") } : { instance: number("INSTANCE") }) },
    };
  }
  const program = optional("PROGRAM_NAME");
  const mode = draft.scheduleMode;
  const schedule = mode && mode !== "named" ? undefined : optional("SCHEDULE_NAME");
  const event = mode === "queue" || mode === "file-watcher" ? eventTrigger(draft) : undefined;
  const base = new Set(["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS", "PROGRAM_OWNER", "PROGRAM_NAME", "SCHEDULE_OWNER", "SCHEDULE_NAME", "START_DATE", "END_DATE", "REPEAT_INTERVAL", "AUTO_DROP", "ENABLED", "COMMENTS", "JOB_CLASS", "CREDENTIAL_NAME", "DESTINATION_NAME", "JOB_STYLE"]);
  const attributes = Object.entries(draft.attributes ?? {})
    .filter(([key, change]) => !base.has(key) && change.kind !== "keep")
    .map(([name, change]) => ({ name, change: change.kind === "set" ? { kind: "set" as const, value: structuredCloneValue(change.value) } : { kind: "clear" as const } }));
  const context = argumentContext(program ? text("PROGRAM_OWNER", owner) : owner, program);
  const active = draft.argumentContext && draft.argumentContext !== context ? draft.argumentDrafts?.[context] : draft;
  const args = (active?.arguments ?? []).map((argument) => ({ position: argument.position, dataType: active?.argumentTypes?.[argument.position] ?? "VARCHAR2", value: structuredCloneValue(argument.value) }) as NativeJobCreateArgument);
  return {
    action: "create",
    scope: { ...scope },
    definition: {
      kind,
      owner,
      name,
      ...(program ? { program: { owner: text("PROGRAM_OWNER", owner), name: program }, numberOfArguments: 0, jobStyle: optional("JOB_STYLE") } : { jobType: text("JOB_TYPE", "PLSQL_BLOCK"), jobAction: text("JOB_ACTION"), numberOfArguments: number("NUMBER_OF_ARGUMENTS") }),
      ...(schedule
        ? { schedule: { owner: text("SCHEDULE_OWNER", owner), name: schedule } }
        : event
          ? { startDate: optional("START_DATE"), endDate: optional("END_DATE"), eventCondition: event.condition ?? undefined, eventSource: event.source }
          : { startDate: optional("START_DATE"), endDate: optional("END_DATE"), repeatInterval: optional("REPEAT_INTERVAL") }),
      enabled: flag("ENABLED", false),
      autoDrop: flag("AUTO_DROP", true),
      comments: optional("COMMENTS"),
      jobClass: optional("JOB_CLASS"),
      credentialName: optional("CREDENTIAL_NAME"),
      destinationName: optional("DESTINATION_NAME"),
      attributes,
      arguments: args,
    },
  };
}

/** A retained creation becomes an edit only after this operation acknowledged CREATE. */
export function rebaseNativeJobDefinitionCreation(details: NativeJobDetails, draft: NativeJobDefinitionDraft, status: NativeJobOperationStatus): NativeJobDefinitionDraft {
  if (!status.target || nativeJobRefKey(status.target) !== nativeJobRefKey(details.snapshot.ref)) throw new TypeError("native_job_identity_mismatch");
  if (status.target.kind !== "scheduler" || status.steps.find((step) => step.id === "create")?.state !== "applied") return {};
  // Activation is a separate native control; passing ENABLED to SET_ATTRIBUTE is invalid.
  const creationOnly = new Set(["ENABLED", "PROGRAM_OWNER", "PROGRAM_NAME", "SCHEDULE_OWNER", "SCHEDULE_NAME", "CREDENTIAL_NAME", "DESTINATION_NAME", "JOB_STYLE"]);
  const program = draft.attributes?.PROGRAM_NAME;
  const schedule = draft.attributes?.SCHEDULE_NAME;
  if (program?.kind === "set" && typeof program.value === "string" && program.value !== "") {
    for (const name of ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"]) creationOnly.add(name);
  }
  if (schedule?.kind === "set" && typeof schedule.value === "string" && schedule.value !== "") {
    for (const name of ["START_DATE", "END_DATE", "REPEAT_INTERVAL"]) creationOnly.add(name);
  }
  return {
    attributes: Object.fromEntries(
      Object.entries(draft.attributes ?? {})
        .filter(([name]) => !creationOnly.has(name))
        .map(([name, change]) => [name, structuredCloneValue(change)]),
    ),
    arguments: structuredCloneValue(draft.arguments ?? []),
    argumentTypes: { ...draft.argumentTypes },
  };
}

// Vue drafts are proxies, so native structuredClone is not a safe input boundary.
function structuredCloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(structuredCloneValue) as T;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, structuredCloneValue(entry)])) as T;
}
