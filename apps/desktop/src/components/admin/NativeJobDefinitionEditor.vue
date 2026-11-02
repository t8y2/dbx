<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { NativeJobArgument, NativeJobArgumentValue, NativeJobDetails, NativeJobEngine, NativeJobFieldChange, NativeJobMetadata, NativeJobReferenceKind, NativeJobRow, NativeJobScope, NativeJobValue } from "@/lib/database/nativeJobs";
import { nativeJobReferences } from "@/lib/backend/api";
import {
  nativeJobArgumentBaseline,
  nativeJobDefinitionForEdit,
  nativeJobDestinationMode,
  nativeJobEventDraft,
  nativeJobProgramArgumentLayout,
  nativeJobScheduleMode,
  restoreNativeJobDefinitionDraft,
  selectNativeJobArgumentContext,
  type NativeJobDefinitionDraft,
  type NativeJobDestinationMode,
  type NativeJobEventDraft,
  type NativeJobScheduleMode,
} from "@/lib/database/nativeJobAdmin";
import NativeJobReferencePicker from "./NativeJobReferencePicker.vue";
import NativeJobArgumentValueEditor from "./NativeJobArgumentValueEditor.vue";

const props = defineProps<{ engine: NativeJobEngine; kind: "scheduler" | "legacy"; details?: NativeJobDetails; scope?: NativeJobScope; owner?: string; disabled?: boolean }>();
const draft = defineModel<NativeJobDefinitionDraft>({ required: true });
const { t } = useI18n();
const translatedFields = new Set([
  "ENABLED",
  "WHAT",
  "NEXT_DATE",
  "INTERVAL",
  "INSTANCE",
  "ZONE",
  "JOB_TYPE",
  "JOB_ACTION",
  "NUMBER_OF_ARGUMENTS",
  "PROGRAM_OWNER",
  "PROGRAM_NAME",
  "SCHEDULE_OWNER",
  "SCHEDULE_NAME",
  "START_DATE",
  "END_DATE",
  "REPEAT_INTERVAL",
  "AUTO_DROP",
  "COMMENTS",
  "LOG_USER",
  "PRIV_USER",
  "SCHEMA_USER",
  "JOB_CLASS",
  "JOB_PRIORITY",
  "MAX_RUNS",
  "MAX_FAILURES",
  "MAX_RUN_DURATION",
  "SCHEDULE_LIMIT",
  "RESTARTABLE",
  "STOP_ON_WINDOW_CLOSE",
  "STORE_OUTPUT",
  "ALLOW_RUNS_IN_RESTRICTED_MODE",
  "INSTANCE_STICKINESS",
  "FOLLOW_DEFAULT_TIMEZONE",
  "INSTANCE_ID",
  "JOB_WEIGHT",
  "RAISE_EVENTS",
  "CONNECT_CREDENTIAL_NAME",
  "CREDENTIAL_NAME",
  "DESTINATION_NAME",
  "DESTINATION",
  "JOB_STYLE",
  "LOGGING_LEVEL",
]);
function fieldLabel(name: string) {
  if (props.engine === "dameng" && name === "NAME") return t("nativeJobs.fields.NAME");
  if (props.engine === "dameng" && props.kind === "legacy" && name === "INTERVAL") return t("nativeJobs.damengInterval");
  if (props.engine === "oceanbase-oracle" && name === "INSTANCE_ID") return t("nativeJobs.definitionFields.ZONE");
  return translatedFields.has(name) ? t(`nativeJobs.definitionFields.${name}`) : name;
}
type EditorSection = "definition" | "arguments" | "advanced";
const section = ref<EditorSection>("definition");
const sections = computed<EditorSection[]>(() => (props.kind === "scheduler" ? ["definition", "arguments", "advanced"] : ["definition", "advanced"]));
type Field = { name: string; type: "text" | "body" | "number" | "boolean"; nullable?: boolean; readonly?: boolean };
const text = (name: string, nullable = false): Field => ({ name, type: "text", nullable });
const number = (name: string): Field => ({ name, type: "number" });
const flag = (name: string): Field => ({ name, type: "boolean" });
const original = computed<NativeJobRow>(() => {
  const definition = props.details && nativeJobDefinitionForEdit(props.engine, props.kind, props.details.snapshot.definition, props.details.legacyDefinition);
  return definition?.status === "available" ? definition.value : {};
});
const readable = computed(() => !props.details || props.details.snapshot.definition.status === "available");
const damengLegacyBodyReadable = computed(() => props.details?.legacyDefinition?.status === "available" && typeof props.details.legacyDefinition.value.WHAT === "string");
const damengLegacyDateReadable = computed(() => props.details?.legacyDefinition?.status === "available" && typeof props.details.legacyDefinition.value.NEXT_DATE === "string" && Object.prototype.hasOwnProperty.call(props.details.legacyDefinition.value, "NEXT_SEC"));
const canSwitchReferences = computed(() => props.engine === "oracle" && props.kind === "scheduler");
function canReplaceNamedReference(name: string): boolean {
  if (canSwitchReferences.value) return true;
  if (props.engine !== "dameng" || props.kind !== "scheduler" || !props.details) return false;
  const prefix = name.startsWith("PROGRAM_") ? "PROGRAM" : name.startsWith("SCHEDULE_") ? "SCHEDULE" : undefined;
  return !!prefix && ["OWNER", "NAME"].every((part) => typeof original.value[`${prefix}_${part}`] === "string" && !!original.value[`${prefix}_${part}`]);
}
const destinationMode = computed(() => nativeJobDestinationMode(draft.value, original.value));
function changeDestinationMode(event: Event) {
  draft.value.destinationMode = (event.target as HTMLSelectElement).value as NativeJobDestinationMode;
  draft.value.transitionRetained = true;
}
const triggerMode = computed(() => nativeJobScheduleMode(draft.value, original.value));
const eventInputs = computed(() => draft.value.eventDraft ?? nativeJobEventDraft(original.value));
const eventFields = computed<Array<{ name: keyof NativeJobEventDraft; label: string }>>(() => [
  { name: "condition", label: "eventCondition" },
  ...(triggerMode.value === "file-watcher"
    ? [
        { name: "watcherOwner" as const, label: "fileWatcherOwner" },
        { name: "watcherName" as const, label: "fileWatcherName" },
      ]
    : [
        { name: "queueOwner" as const, label: "eventQueueOwner" },
        { name: "queueName" as const, label: "eventQueueName" },
        { name: "agent" as const, label: "eventQueueAgent" },
      ]),
]);
function changeTriggerMode(event: Event) {
  draft.value.eventDraft ??= { ...eventInputs.value };
  draft.value.scheduleMode = (event.target as HTMLSelectElement).value as NativeJobScheduleMode;
  if (props.details) draft.value.transitionRetained = true;
}
function updateEvent(name: keyof NativeJobEventDraft, event: Event) {
  draft.value.eventDraft = { ...eventInputs.value, [name]: (event.target as HTMLInputElement).value };
  draft.value.scheduleMode = triggerMode.value;
  if (props.details) draft.value.transitionRetained = true;
}
function selectFileWatcher(reference: { owner: string; name: string }) {
  draft.value.eventDraft = { ...eventInputs.value, watcherOwner: reference.owner, watcherName: reference.name };
  draft.value.scheduleMode = "file-watcher";
  if (props.details) draft.value.transitionRetained = true;
}
const fields = computed<Field[]>(() => {
  if (props.kind === "legacy")
    return section.value === "definition"
      ? [
          ...(props.details && props.engine === "dameng" ? [text("NAME")] : []),
          ...(!props.details ? [flag("ENABLED")] : []),
          { name: "WHAT", type: "body", readonly: props.engine === "dameng" && !damengLegacyBodyReadable.value },
          { ...text("NEXT_DATE"), readonly: props.engine === "dameng" && !damengLegacyDateReadable.value },
          text("INTERVAL"),
          ...(props.engine === "oceanbase-oracle" ? [text("ZONE", true)] : [{ ...number("INSTANCE"), readonly: props.engine === "dameng" }]),
        ]
      : ["LOG_USER", "PRIV_USER", "SCHEMA_USER"].map((name) => ({ ...text(name), readonly: true }));
  if (section.value === "definition") {
    const definition: Field[] = [
      ...(!props.details || canSwitchReferences.value ? [flag("ENABLED")] : []),
      text("JOB_TYPE"),
      number("NUMBER_OF_ARGUMENTS"),
      { name: "JOB_ACTION", type: "body" },
      ...["PROGRAM_OWNER", "PROGRAM_NAME", "SCHEDULE_OWNER", "SCHEDULE_NAME"].map((name) => ({ ...text(name, props.engine !== "dameng" || !props.details), readonly: !!props.details && !canReplaceNamedReference(name) })),
      text("START_DATE", true),
      text("END_DATE", true),
      text("REPEAT_INTERVAL", true),
      flag("AUTO_DROP"),
      text("COMMENTS", true),
    ];
    return definition
      .filter((field) => !(props.engine === "oceanbase-oracle" && !props.details && ["SCHEDULE_OWNER", "SCHEDULE_NAME"].includes(field.name)) && !(canSwitchReferences.value && ["queue", "file-watcher"].includes(triggerMode.value) && ["SCHEDULE_OWNER", "SCHEDULE_NAME"].includes(field.name)))
      .map((field) => ({ ...field, readonly: field.readonly || (props.engine === "oceanbase-oracle" && !!props.details), nullable: field.nullable && !(props.engine === "oceanbase-oracle" && !!props.details) }));
  }
  const advanced = [
    text("JOB_CLASS"),
    number("JOB_PRIORITY"),
    number("MAX_RUNS"),
    number("MAX_FAILURES"),
    text("MAX_RUN_DURATION", props.engine !== "oceanbase-oracle"),
    text("SCHEDULE_LIMIT", true),
    flag("RESTARTABLE"),
    flag("STOP_ON_WINDOW_CLOSE"),
    flag("STORE_OUTPUT"),
    flag("ALLOW_RUNS_IN_RESTRICTED_MODE"),
    flag("INSTANCE_STICKINESS"),
    flag("FOLLOW_DEFAULT_TIMEZONE"),
    props.engine === "oceanbase-oracle" ? text("INSTANCE_ID") : number("INSTANCE_ID"),
    number("JOB_WEIGHT"),
    number("RAISE_EVENTS"),
    text("CONNECT_CREDENTIAL_NAME", true),
    ...(!props.details || canSwitchReferences.value ? [text("CREDENTIAL_NAME", true), text("DESTINATION_NAME", true)] : []),
    ...(props.details && canSwitchReferences.value && destinationMode.value === "legacy" ? [text("DESTINATION", true)] : []),
    ...(!props.details ? [text("JOB_STYLE")] : []),
  ];
  if (props.engine === "oracle") advanced.push(text("LOGGING_LEVEL"));
  return advanced
    .filter((field) => !(props.details && canSwitchReferences.value && destinationMode.value !== "named" && field.name === "DESTINATION_NAME") && (props.engine !== "oceanbase-oracle" || ["JOB_CLASS", "MAX_FAILURES", "MAX_RUN_DURATION", "INSTANCE_ID", "JOB_STYLE"].includes(field.name)))
    .map((field) => ({ ...field, readonly: props.engine === "dameng" && !!props.details && field.name !== "MAX_RUN_DURATION" }));
});
function value(name: string): NativeJobValue | undefined {
  if (name === "ENABLED" && props.details && props.kind === "scheduler" && draft.value.finalEnabled !== undefined) return draft.value.finalEnabled;
  const change = draft.value.attributes?.[name];
  if (change?.kind === "set") return change.value;
  if (change?.kind === "clear") return null;
  if (name === "DESTINATION" && props.details && original.value.DESTINATION_OWNER !== null) return null;
  if ((name === "PROGRAM_OWNER" || name === "SCHEDULE_OWNER") && !props.details) return props.owner;
  return original.value[name];
}
function editable(field: Field): boolean {
  if (props.kind === "scheduler") {
    if (value("PROGRAM_NAME") && ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"].includes(field.name)) return false;
    if ((canSwitchReferences.value ? triggerMode.value === "named" : value("SCHEDULE_NAME")) && ["START_DATE", "END_DATE", "REPEAT_INTERVAL"].includes(field.name)) return false;
    if (canSwitchReferences.value && ["queue", "file-watcher"].includes(triggerMode.value) && field.name === "REPEAT_INTERVAL") return false;
  }
  return !props.disabled && readable.value && !field.readonly && (!props.details || Object.prototype.hasOwnProperty.call(original.value, field.name) || (canSwitchReferences.value && field.name === "DESTINATION_NAME" && Object.prototype.hasOwnProperty.call(original.value, "DESTINATION")));
}
function update(name: string, change: NativeJobFieldChange) {
  if (props.details && canSwitchReferences.value && ["DESTINATION", "DESTINATION_NAME"].includes(name)) {
    draft.value.destinationMode = change.kind === "clear" ? "local" : change.kind === "keep" ? nativeJobDestinationMode({}, original.value) : name === "DESTINATION" ? "legacy" : "named";
    draft.value.transitionRetained = true;
    if (change.kind === "clear") return;
  }
  if (props.details && props.kind === "scheduler" && name === "ENABLED" && change.kind === "set" && typeof change.value === "boolean") {
    draft.value.finalEnabled = change.value;
    return;
  }
  if (!draft.value.attributes) draft.value.attributes = {};
  draft.value.attributes[name] = change;
  if (canSwitchReferences.value && name === "SCHEDULE_NAME" && change.kind !== "keep") draft.value.scheduleMode = change.kind === "set" && change.value ? "named" : "inline";
  if (props.details && props.kind === "scheduler" && ["JOB_TYPE", "NUMBER_OF_ARGUMENTS"].includes(name) && change.kind !== "keep") {
    const changed = name === "NUMBER_OF_ARGUMENTS" && change.kind === "set" ? Number(change.value) !== Number(original.value[name]) : change.kind === "clear" ? original.value[name] !== null : change.value !== original.value[name];
    if (changed) draft.value.reconcileArguments = true;
  }
  if (
    props.details &&
    props.kind === "scheduler" &&
    (["PROGRAM_OWNER", "PROGRAM_NAME", "SCHEDULE_OWNER", "SCHEDULE_NAME", "CREDENTIAL_NAME", "CONNECT_CREDENTIAL_NAME", "DESTINATION", "DESTINATION_NAME"].includes(name) || (name === "JOB_ACTION" && value("JOB_TYPE") === "CHAIN")) &&
    change.kind !== "keep"
  )
    draft.value.transitionRetained = true;
}
function selectReference(prefix: "PROGRAM" | "SCHEDULE", reference: { owner: string; name: string }) {
  update(`${prefix}_OWNER`, { kind: "set", value: reference.owner });
  update(`${prefix}_NAME`, { kind: "set", value: reference.name });
}
const scheduleKind = computed<"schedule" | "window" | "window-group">(() => {
  const kind = draft.value.referenceKinds?.SCHEDULE_NAME ?? (original.value.SCHEDULE_TYPE === "WINDOW" ? "window" : original.value.SCHEDULE_TYPE === "WINDOW_GROUP" ? "window-group" : "schedule");
  return kind === "window" || kind === "window-group" ? kind : "schedule";
});
function changeScheduleKind(event: Event) {
  draft.value.referenceKinds ??= {};
  draft.value.referenceKinds.SCHEDULE_NAME = (event.target as HTMLSelectElement).value as NativeJobReferenceKind;
  const name = value("SCHEDULE_NAME");
  if (typeof name === "string" && name) update("SCHEDULE_NAME", { kind: "set", value: name });
}
function qualifiedReference(reference: { owner: string; name: string }) {
  const quoted = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return `${quoted(reference.owner)}.${quoted(reference.name)}`;
}
function selectChain(reference: { owner: string; name: string }) {
  update("JOB_TYPE", { kind: "set", value: "CHAIN" });
  update("NUMBER_OF_ARGUMENTS", { kind: "set", value: 0 });
  update("JOB_ACTION", { kind: "set", value: qualifiedReference(reference) });
}
function referenceDisplay(value: NativeJobValue | undefined): string {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.owner === "string" && typeof value.name === "string") return qualifiedReference({ owner: value.owner, name: value.name });
  return value === undefined || value === null ? "" : String(value);
}
function selectAdvancedReference(name: string, reference: { owner: string; name: string }, kind?: "destination-group") {
  update(name, { kind: "set", value: props.details ? { ...reference, ...(kind ? { kind } : {}) } : qualifiedReference(reference) });
}
function input(field: Field, event: Event) {
  const element = event.target as HTMLInputElement;
  const next = field.type === "boolean" ? element.checked : field.type === "number" && element.value !== "" ? Number(element.value) : element.value;
  update(field.name, { kind: "set", value: next });
}
const argumentMetadata = computed(() => props.details?.snapshot.arguments);
const creationProgram = shallowRef<NativeJobMetadata<NativeJobRow>>();
const creationProgramArguments = shallowRef<NativeJobMetadata<NativeJobRow[]>>();
const currentProgram = computed(() => !!props.details && value("PROGRAM_OWNER") === original.value.PROGRAM_OWNER && value("PROGRAM_NAME") === original.value.PROGRAM_NAME);
const program = computed(() => (currentProgram.value ? props.details?.program : creationProgram.value));
const programArguments = computed(() => (currentProgram.value ? props.details?.programArguments : creationProgramArguments.value));
function rememberProgramLayout() {
  if (!draft.value.argumentContext) return;
  const layout = nativeJobProgramArgumentLayout(program.value, programArguments.value);
  draft.value.argumentLayouts ??= {};
  if (layout.status === "available" || !draft.value.argumentLayouts[draft.value.argumentContext]) draft.value.argumentLayouts[draft.value.argumentContext] = layout;
}
watch(
  () => JSON.stringify([props.scope, props.details?.snapshot.revision, props.kind, value("PROGRAM_OWNER"), value("PROGRAM_NAME")]),
  async (_, __, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    creationProgram.value = undefined;
    creationProgramArguments.value = undefined;
    const owner = value("PROGRAM_OWNER"),
      name = value("PROGRAM_NAME");
    if (props.kind === "scheduler") selectNativeJobArgumentContext(draft.value, typeof owner === "string" ? owner : "", typeof name === "string" ? name : undefined);
    if (props.kind !== "scheduler" || !props.scope || typeof owner !== "string" || !owner || typeof name !== "string" || !name) return;
    if (currentProgram.value) {
      rememberProgramLayout();
      return;
    }
    creationProgram.value = { status: "unknown", reason: "loading" };
    creationProgramArguments.value = { status: "unknown", reason: "loading" };
    const request = { scope: { ...props.scope }, schema: owner, name };
    await Promise.all([
      nativeJobReferences({ ...request, kind: "program", limit: 1 })
        .then((catalog) => {
          if (!current) return;
          creationProgram.value =
            catalog.objects.status === "available" && catalog.objects.value.length === 1
              ? { status: "available", value: catalog.objects.value[0]! }
              : catalog.objects.status === "available" || catalog.objects.status === "truncated"
                ? { status: "unknown", reason: "native_job_program_identity_unavailable" }
                : catalog.objects;
        })
        .catch(() => {
          if (current) creationProgram.value = { status: "error", reason: "native_job_reference_read_failed" };
        }),
      nativeJobReferences({ ...request, kind: "program-arguments", limit: 10_000 })
        .then((catalog) => {
          if (current) creationProgramArguments.value = catalog.objects;
        })
        .catch(() => {
          if (current) creationProgramArguments.value = { status: "error", reason: "native_job_reference_read_failed" };
        }),
    ]);
    if (current) rememberProgramLayout();
  },
  { immediate: true },
);
const programDefinition = computed(() => (program.value?.status === "available" ? program.value.value : undefined));
const creationProgramRows = computed<NativeJobArgument[]>(() => {
  if (!value("PROGRAM_NAME")) return [];
  const layout = draft.value.argumentLayouts?.[draft.value.argumentContext ?? ""] ?? nativeJobProgramArgumentLayout(program.value, programArguments.value);
  return layout.status === "available" ? layout.value : [];
});
const controlledArguments = computed(() => !!props.details && !!draft.value.reconcileArguments);
const argumentRows = computed<NativeJobArgument[]>(() => {
  if (props.details && !controlledArguments.value) return argumentMetadata.value?.status === "available" ? argumentMetadata.value.value : [];
  if (controlledArguments.value) {
    const count = Number(value("NUMBER_OF_ARGUMENTS"));
    const saved = draft.value.argumentLayouts?.inline;
    const inline =
      Number.isSafeInteger(count) && count >= 0 && count <= 255
        ? Array.from(
            { length: count },
            (_, index) => (saved?.status === "available" && saved.value.find((argument) => argument.position === index + 1)) || { position: index + 1, dataType: draft.value.argumentTypes?.[index + 1] ?? "VARCHAR2", value: { kind: "unset" } as NativeJobArgumentValue, editable: true },
          )
        : [];
    return nativeJobArgumentBaseline(draft.value, draft.value.argumentContext ?? "inline", value("PROGRAM_NAME") ? creationProgramRows.value : inline);
  }
  return [
    ...creationProgramRows.value,
    ...(draft.value.arguments ?? []).filter((argument) => !creationProgramRows.value.some((row) => row.position === argument.position)).map((argument) => ({ position: argument.position, dataType: draft.value.argumentTypes?.[argument.position] ?? "VARCHAR2", value: argument.value, editable: true })),
  ].sort((a, b) => a.position - b.position);
});
function argumentChange(argument: NativeJobArgument) {
  return draft.value.arguments?.find((change) => change.position === argument.position);
}
function argumentState(argument: NativeJobArgument) {
  return argumentChange(argument)?.value.kind ?? (props.details && !controlledArguments.value ? "keep" : argument.value.kind);
}
function argumentValue(argument: NativeJobArgument) {
  const changed = argumentChange(argument)?.value ?? argument.value;
  if (changed.kind !== "value") return "";
  const value = changed.value;
  if (value && typeof value === "object" && !Array.isArray(value) && value.$dbx === "oracle-anydata-v1") return value;
  return typeof value === "string" ? value : JSON.stringify(value);
}
function changeArgument(argument: NativeJobArgument, value: NativeJobArgumentValue | undefined) {
  if ((!props.details || controlledArguments.value) && value !== undefined && !draft.value.argumentTypes?.[argument.position]) {
    if (!draft.value.argumentTypes) draft.value.argumentTypes = {};
    draft.value.argumentTypes[argument.position] = argument.dataType;
  }
  if (!draft.value.arguments) draft.value.arguments = [];
  const index = draft.value.arguments.findIndex((change) => change.position === argument.position);
  if (value === undefined) {
    if (index >= 0) draft.value.arguments.splice(index, 1);
  } else if (index >= 0) draft.value.arguments[index] = { position: argument.position, value };
  else draft.value.arguments.push({ position: argument.position, value });
}
function changeArgumentState(argument: NativeJobArgument, event: Event) {
  const state = (event.target as HTMLSelectElement).value;
  if (state === "keep") changeArgument(argument, undefined);
  else if (state === "value") changeArgument(argument, { kind: "value", value: argumentValue(argument) });
  else if (state === "unset" || state === "inherit" || state === "null") changeArgument(argument, { kind: state });
}
function addArgument() {
  const positions = new Set(argumentRows.value.map((argument) => argument.position));
  let position = 1;
  while (positions.has(position)) position++;
  changeArgument({ position, dataType: "VARCHAR2", value: { kind: "unset" }, editable: true }, { kind: "unset" });
  if (!value("PROGRAM_NAME") && Number(value("NUMBER_OF_ARGUMENTS") ?? 0) < position) update("NUMBER_OF_ARGUMENTS", { kind: "set", value: position });
}
function displayArgument(value: NativeJobArgumentValue) {
  return value.kind === "value" || value.kind === "opaque" ? (typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2)) : value.kind === "null" ? "NULL" : t(`nativeJobs.argumentStates.${value.kind}`);
}
function argumentType(argument: NativeJobArgument, event: Event) {
  if (!draft.value.argumentTypes) draft.value.argumentTypes = {};
  draft.value.argumentTypes[argument.position] = (event.target as HTMLInputElement).value;
}
function choices(name: string) {
  return name === "JOB_TYPE" ? (props.engine !== "oracle" ? ["PLSQL_BLOCK", "STORED_PROCEDURE"] : ["PLSQL_BLOCK", "STORED_PROCEDURE", "CHAIN", "EXECUTABLE", "EXTERNAL_SCRIPT", "SQL_SCRIPT", "BACKUP_SCRIPT"]) : name === "LOGGING_LEVEL" ? ["OFF", "RUNS", "FAILED RUNS", "FULL"] : [];
}
function choiceLabel(name: string, choice: string) {
  if (name === "JOB_TYPE" && choices(name).includes(choice)) return t(`nativeJobs.jobTypes.${choice}`);
  if (name === "LOGGING_LEVEL" && choices(name).includes(choice)) return t(`nativeJobs.loggingLevels.${choice.replace(/ /g, "_")}`);
  return choice;
}
</script>

<template>
  <div class="grid gap-4">
    <nav class="flex gap-1 border-b pb-2" :aria-label="t('nativeJobs.editSections')">
      <Button v-for="item in sections" :key="item" size="sm" :variant="section === item ? 'secondary' : 'ghost'" @click="section = item">{{ t(`nativeJobs.${item}`) }}</Button>
    </nav>
    <p v-if="!readable" role="status" class="rounded border border-amber-500/40 p-3 text-sm">{{ t("nativeJobs.partitionUnavailable", { status: details?.snapshot.definition.status }) }}</p>
    <p v-if="engine === 'oceanbase-oracle' && kind === 'scheduler' && details && section === 'definition'" role="status" class="text-sm text-muted-foreground">{{ t("nativeJobs.obSchedulerDefinitionReadOnly") }}</p>
    <div v-if="canSwitchReferences && section === 'definition'" class="flex flex-wrap items-end justify-between gap-3">
      <label class="grid gap-1.5 text-sm">
        <span>{{ t("nativeJobs.scheduleMode") }}</span>
        <select :value="triggerMode" :aria-label="t('nativeJobs.scheduleMode')" class="h-9 rounded border bg-background px-2" :disabled="disabled || !readable" @change="changeTriggerMode">
          <option value="inline">{{ t("nativeJobs.scheduleModes.inline") }}</option>
          <option value="named">{{ t("nativeJobs.scheduleModes.named") }}</option>
          <option value="queue">{{ t("nativeJobs.scheduleModes.queue") }}</option>
          <option value="file-watcher">{{ t("nativeJobs.scheduleModes.fileWatcher") }}</option>
        </select>
      </label>
      <Button v-if="details && draft.originalSnapshot" variant="outline" size="sm" :disabled="disabled || !readable" @click="restoreNativeJobDefinitionDraft(draft, details)">{{ t("nativeJobs.restoreDefinitionDraft") }}</Button>
    </div>
    <div v-if="value('PROGRAM_NAME') && section !== 'advanced'" class="grid gap-2 rounded border bg-muted/20 p-3 text-sm">
      <strong>{{ t("nativeJobs.referenceKinds.program") }} · {{ value("PROGRAM_OWNER") }} / {{ value("PROGRAM_NAME") }}</strong>
      <template v-if="programDefinition">
        <span>{{ choiceLabel("JOB_TYPE", String(programDefinition.PROGRAM_TYPE ?? "")) }} · {{ fieldLabel("NUMBER_OF_ARGUMENTS") }}: {{ programDefinition.NUMBER_OF_ARGUMENTS }}</span>
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">{{ programDefinition.PROGRAM_ACTION }}</pre>
      </template>
      <p v-else-if="program" role="status" class="text-muted-foreground">{{ t("nativeJobs.partitionUnavailable", { status: program.status }) }}</p>
    </div>
    <template v-if="section === 'arguments'">
      <p v-if="argumentMetadata && argumentMetadata.status !== 'available' && argumentMetadata.status !== 'empty'" role="status" class="rounded border border-amber-500/40 p-3 text-sm">
        {{ engine === "oceanbase-oracle" && argumentMetadata.status === "unsupported" ? t("nativeJobs.argumentCatalogUnavailable") : t("nativeJobs.partitionUnavailable", { status: argumentMetadata.status }) }}
      </p>
      <p v-if="programArguments && programArguments.status !== 'available' && programArguments.status !== 'empty'" role="status" class="text-sm text-muted-foreground">{{ t("nativeJobs.programDefaultUnknown") }}</p>
      <Button v-if="(!details || controlledArguments) && !value('PROGRAM_NAME')" variant="outline" class="justify-self-start" :disabled="disabled" @click="addArgument">{{ t("nativeJobs.addArgument") }}</Button>
      <div v-for="argument in argumentRows" :key="argument.position" class="grid gap-3 rounded border p-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <strong>{{ t("nativeJobs.argumentPosition", { position: argument.position }) }}{{ argument.name ? ` · ${argument.name}` : "" }}</strong>
          <span v-if="!argument.metadataAttribute" class="text-muted-foreground">{{ t(`nativeJobs.argumentStates.${argumentChange(argument)?.value.kind ?? argument.value.kind}`) }}</span>
          <input
            v-if="(!details || controlledArguments) && !value('PROGRAM_NAME')"
            :value="draft.argumentTypes?.[argument.position] ?? argument.dataType"
            :aria-label="t('nativeJobs.argumentType', { position: argument.position })"
            class="ml-auto h-9 rounded border bg-background px-2"
            :disabled="disabled"
            @input="argumentType(argument, $event)"
          />
          <span v-else class="ml-auto text-muted-foreground">{{ argument.dataType }}</span>
          <Button v-if="!details && !value('PROGRAM_NAME')" variant="ghost" size="sm" :disabled="disabled" @click="changeArgument(argument, undefined)">{{ t("common.delete") }}</Button>
        </div>
        <select
          :value="argumentState(argument)"
          :aria-label="t('nativeJobs.argumentState', { position: argument.position })"
          class="h-9 rounded border bg-background px-2"
          :disabled="disabled || (!argument.editable && !(controlledArguments && argument.value.kind === 'opaque' && !argument.metadataAttribute))"
          @change="changeArgumentState(argument, $event)"
        >
          <option v-if="details && !controlledArguments" value="keep">{{ t("nativeJobs.keepOriginal") }}</option>
          <option v-if="argumentState(argument) === 'opaque'" value="opaque" disabled>{{ t("nativeJobs.argumentStates.opaque") }}</option>
          <option v-for="state in argument.editable ? ['unset', 'inherit', 'null', 'value'] : ['unset', 'inherit']" :key="state" :value="state">{{ t(`nativeJobs.argumentStates.${state}`) }}</option>
        </select>
        <NativeJobArgumentValueEditor
          v-if="argumentState(argument) === 'value' || (argumentState(argument) === 'keep' && argument.value.kind === 'value')"
          :model-value="argumentValue(argument)"
          :label="t('nativeJobs.argumentValue', { position: argument.position })"
          :anydata="engine === 'oracle' && String(value('JOB_STYLE') ?? '').toUpperCase() !== 'LIGHTWEIGHT'"
          :disabled="disabled"
          :readonly="!argument.editable || argumentState(argument) !== 'value'"
          @update:model-value="changeArgument(argument, { kind: 'value', value: $event })"
        />
        <pre v-if="argument.value.kind === 'opaque'" class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">{{ JSON.stringify(argument.value.value, null, 2) }}</pre>
        <div v-if="argument.defaultValue" class="grid gap-1 border-t pt-2">
          <span v-if="argument.defaultValue.status !== 'available' || argument.defaultValue.value.kind !== 'value'" class="text-muted-foreground">{{ t("nativeJobs.programDefault") }}</span>
          <NativeJobArgumentValueEditor v-if="argument.defaultValue.status === 'available' && argument.defaultValue.value.kind === 'value'" :model-value="argument.defaultValue.value.value" :label="t('nativeJobs.programDefault')" readonly />
          <pre v-else-if="argument.defaultValue.status === 'available'" class="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">{{ displayArgument(argument.defaultValue.value) }}</pre>
          <span v-else class="text-muted-foreground">{{ t("nativeJobs.programDefaultUnknown") }}</span>
        </div>
        <p v-if="argument.metadataAttribute" class="text-muted-foreground">{{ t("nativeJobs.metadataArgument", { attribute: argument.metadataAttribute }) }}</p>
        <p v-else-if="!argument.editable" class="text-muted-foreground">{{ t("nativeJobs.opaqueArgument") }}</p>
      </div>
    </template>
    <div v-else-if="readable" class="grid gap-4 sm:grid-cols-2">
      <template v-for="field in fields" :key="field.name">
        <label v-if="details && canSwitchReferences && section === 'advanced' && field.name === 'CREDENTIAL_NAME'" class="grid justify-self-start gap-1.5 text-sm sm:col-span-2">
          <span>{{ t("nativeJobs.destinationMode") }}</span>
          <select :value="destinationMode" :aria-label="t('nativeJobs.destinationMode')" class="h-9 rounded border bg-background px-2" :disabled="disabled || !readable" @change="changeDestinationMode">
            <option v-for="mode in ['local', 'legacy', 'named']" :key="mode" :value="mode">{{ t(`nativeJobs.destinationModes.${mode}`) }}</option>
          </select>
        </label>
        <div class="grid content-start gap-1.5 text-sm" :class="field.type === 'body' ? 'sm:col-span-2' : ''">
          <span class="flex items-center gap-2">
            <span>{{ fieldLabel(field.name) }}</span>
            <button v-if="details && draft.attributes?.[field.name] && draft.attributes[field.name]?.kind !== 'keep'" type="button" class="ml-auto text-xs text-primary hover:underline" :disabled="!editable(field)" @click.prevent="update(field.name, { kind: 'keep' })">
              {{ t("nativeJobs.keepOriginal") }}
            </button>
            <button v-if="field.nullable" type="button" class="text-xs text-muted-foreground hover:text-foreground" :disabled="!editable(field)" @click.prevent="update(field.name, { kind: 'clear' })">NULL</button>
          </span>
          <textarea
            v-if="field.type === 'body'"
            :value="referenceDisplay(value(field.name))"
            :aria-label="fieldLabel(field.name)"
            class="min-h-36 rounded border bg-background p-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :disabled="!editable(field)"
            @input="input(field, $event)"
          />
          <select v-else-if="choices(field.name).length" :value="value(field.name)" :aria-label="fieldLabel(field.name)" class="h-9 rounded border bg-background px-2" :disabled="!editable(field)" @change="input(field, $event)">
            <option v-if="value(field.name) && !choices(field.name).includes(String(value(field.name)))" :value="value(field.name)">{{ value(field.name) }}</option>
            <option v-for="choice in choices(field.name)" :key="choice" :value="choice">{{ choiceLabel(field.name, choice) }}</option>
          </select>
          <input
            v-else-if="field.type === 'boolean'"
            type="checkbox"
            class="h-4 w-4"
            :checked="value(field.name) === true || value(field.name) === 1 || value(field.name) === '1' || value(field.name) === 'TRUE'"
            :aria-label="fieldLabel(field.name)"
            :disabled="!editable(field)"
            @change="input(field, $event)"
          />
          <input
            v-else
            :type="field.type"
            :value="referenceDisplay(value(field.name))"
            :placeholder="value(field.name) === null ? 'NULL' : ''"
            :aria-label="fieldLabel(field.name)"
            class="h-9 rounded border bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :disabled="!editable(field)"
            @input="input(field, $event)"
          />
          <span v-if="draft.attributes?.[field.name]?.kind === 'clear'" class="text-xs text-muted-foreground">{{ t("nativeJobs.explicitNull") }}</span>
          <span v-if="engine === 'dameng' && kind === 'legacy' && field.name === 'INTERVAL'" class="text-sm text-muted-foreground">{{ t("nativeJobs.damengIntervalHint") }}</span>
          <span v-if="details && field.name === 'ENABLED'" class="text-sm text-muted-foreground">{{ t("nativeJobs.finalEnabledHint") }}</span>
          <span v-if="(!details || canSwitchReferences) && ((field.name === 'PROGRAM_NAME' && value('PROGRAM_NAME')) || (field.name === 'SCHEDULE_NAME' && value('SCHEDULE_NAME') && triggerMode === 'named'))" class="text-xs text-muted-foreground">{{ t("nativeJobs.inactiveInlineDraft") }}</span>
          <NativeJobReferencePicker v-if="(!details || canReplaceNamedReference(field.name)) && field.name === 'PROGRAM_NAME'" :scope="scope" kind="program" :disabled="disabled" @select="selectReference('PROGRAM', $event)" />
          <select
            v-if="details && canSwitchReferences && field.name === 'SCHEDULE_NAME'"
            :value="scheduleKind"
            :aria-label="t('nativeJobs.chooseReference', { kind: t('nativeJobs.referenceKinds.schedule') })"
            class="h-9 rounded border bg-background px-2"
            :disabled="disabled"
            @change="changeScheduleKind"
          >
            <option value="schedule">{{ t("nativeJobs.referenceKinds.schedule") }}</option>
            <option value="window">{{ t("nativeJobs.referenceKinds.window") }}</option>
            <option value="window-group">{{ t("nativeJobs.referenceKinds.window-group") }}</option>
          </select>
          <NativeJobReferencePicker v-if="(!details || canReplaceNamedReference(field.name)) && field.name === 'SCHEDULE_NAME'" :scope="scope" :kind="engine === 'dameng' ? 'schedule' : scheduleKind" :disabled="disabled" @select="selectReference('SCHEDULE', $event)" />
          <NativeJobReferencePicker v-if="(!details || canSwitchReferences) && field.name === 'JOB_ACTION' && value('JOB_TYPE') === 'CHAIN' && engine !== 'dameng'" :scope="scope" kind="chain" :disabled="disabled" @select="selectChain" />
          <NativeJobReferencePicker
            v-if="(!details || canSwitchReferences) && ['CREDENTIAL_NAME', 'CONNECT_CREDENTIAL_NAME', 'DESTINATION_NAME'].includes(field.name) && engine !== 'dameng'"
            :scope="scope"
            :kind="field.name === 'DESTINATION_NAME' ? 'destination' : 'credential'"
            :disabled="disabled"
            @select="selectAdvancedReference(field.name, $event)"
          />
          <NativeJobReferencePicker v-if="details && canSwitchReferences && field.name === 'DESTINATION_NAME'" :scope="scope" kind="destination-group" :disabled="disabled" @select="selectAdvancedReference(field.name, $event, 'destination-group')" />
        </div>
      </template>
      <template v-if="canSwitchReferences && section === 'definition' && (triggerMode === 'queue' || triggerMode === 'file-watcher')">
        <label v-for="field in eventFields" :key="field.name" class="grid content-start gap-1.5 text-sm" :class="field.name === 'condition' ? 'sm:col-span-2' : ''">
          <span>{{ t(`nativeJobs.${field.label}`) }}</span>
          <textarea v-if="field.name === 'condition'" :value="eventInputs[field.name]" :aria-label="t(`nativeJobs.${field.label}`)" class="min-h-24 rounded border bg-background p-2 font-mono text-sm" :disabled="disabled" @input="updateEvent(field.name, $event)" />
          <input v-else :value="eventInputs[field.name]" :aria-label="t(`nativeJobs.${field.label}`)" class="h-9 rounded border bg-background px-2" :disabled="disabled" @input="updateEvent(field.name, $event)" />
          <NativeJobReferencePicker v-if="field.name === 'watcherName'" :scope="scope" kind="file-watcher" :disabled="disabled" @select="selectFileWatcher" />
        </label>
      </template>
    </div>
  </div>
</template>
