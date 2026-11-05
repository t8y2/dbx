<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { NativeJobDamengChildDraft, NativeJobDamengEditDraft, NativeJobDetails, NativeJobFieldChange, NativeJobRow, NativeJobValue } from "@/lib/database/nativeJobs";

const props = defineProps<{ details?: NativeJobDetails; disabled?: boolean }>();
const draft = defineModel<NativeJobDamengEditDraft>({ required: true });
const { t } = useI18n();
const section = ref<"attributes" | "steps" | "schedules">("attributes");
const selectedIndex = ref(0);
type Field = { name: string; type: "text" | "number" | "boolean" | "body"; nullable?: boolean };
const text = (name: string, nullable = false): Field => ({ name, type: "text", nullable });
const number = (name: string): Field => ({ name, type: "number" });
const flag = (name: string): Field => ({ name, type: "boolean" });
const fields = computed<Field[]>(() =>
  section.value === "attributes"
    ? [...(props.details ? [text("NAME")] : []), flag("ENABLE"), text("DESCRIBE", true), flag("ENABLE_EMAIL"), text("EMAIL_OPERATOR_NAME", true), number("EMAIL_TYPE"), flag("ENABLE_NETSEND"), text("NETSEND_OPERATOR_NAME", true), number("NETSEND_TYPE"), number("EP_SEQNO"), text("RAFT_NAME", true)]
    : section.value === "steps"
      ? [text("NAME"), number("TYPE"), { name: "COMMAND_INPUT", type: "body" }, number("SUCC_ACTION"), text("SUCC_NEXT_STEP", true), number("FAIL_ACTION"), text("FAIL_NEXT_STEP", true), number("RETRY_ATTEMPTS"), number("RETRY_INTERVAL"), flag("APPEND_FLAG"), text("DESCRIBE", true)]
      : [text("NAME"), flag("ENABLE"), number("TYPE"), number("FREQ_INTERVAL"), number("FREQ_SUB_INTERVAL"), number("FREQ_MINUTE_INTERVAL"), text("STARTTIME"), text("ENDTIME", true), text("DURING_START_DATE"), text("DURING_END_DATE", true), text("DESCRIBE", true)],
);

const metadata = computed(() => (section.value === "attributes" ? undefined : (props.details?.[section.value] ?? { status: "empty" as const })));
const readable = computed(() => (section.value === "attributes" ? !props.details || props.details.snapshot.definition.status === "available" : metadata.value?.status === "available" || metadata.value?.status === "empty"));
const entries = computed(() => {
  if (section.value === "attributes") return [];
  const changes = draft.value[section.value] ?? [];
  const existing = metadata.value?.status === "available" ? metadata.value.value : [];
  return [...existing.map((row) => ({ name: String(row.NAME), row, change: changes.find((change) => change.name === row.NAME && change.kind !== "add") })), ...changes.filter((change) => change.kind === "add").map((change) => ({ name: change.name, row: {} as NativeJobRow, change }))];
});
const selected = computed(() => entries.value[selectedIndex.value]);
const original = computed<NativeJobRow>(() => {
  if (section.value === "attributes") return !props.details ? { ENABLE: true, DESCRIBE: "", ENABLE_EMAIL: false, EMAIL_TYPE: 0, ENABLE_NETSEND: false, NETSEND_TYPE: 0, RAFT_NAME: null } : props.details.snapshot.definition.status === "available" ? props.details.snapshot.definition.value : {};
  if (selected.value?.change?.kind !== "add") return selected.value?.row ?? {};
  return section.value === "steps"
    ? { TYPE: 0, SUCC_ACTION: 1, FAIL_ACTION: 1, RETRY_ATTEMPTS: 0, RETRY_INTERVAL: 0, APPEND_FLAG: 0, DESCRIBE: null, SUCC_NEXT_STEP: null, FAIL_NEXT_STEP: null }
    : { ENABLE: 1, TYPE: 1, FREQ_INTERVAL: 1, FREQ_SUB_INTERVAL: 0, FREQ_MINUTE_INTERVAL: 0, STARTTIME: "00:00:00", ENDTIME: null, DURING_START_DATE: "CURDATE", DURING_END_DATE: null, DESCRIBE: null };
});
const changes = computed(() => (section.value === "attributes" ? (draft.value.attributes ?? {}) : (selected.value?.change?.attributes ?? {})));
const removed = computed(() => selected.value?.change?.kind === "drop");

function choose(value: typeof section.value) {
  section.value = value;
  selectedIndex.value = 0;
}
function childList(): NativeJobDamengChildDraft[] {
  if (section.value === "attributes") throw new Error("native_job_child_missing");
  if (!draft.value[section.value]) draft.value[section.value] = [];
  // Read through the model again so subsequent inserts and edits use Vue's reactive proxy.
  return draft.value[section.value]!;
}
function childDraft(): NativeJobDamengChildDraft {
  if (section.value === "attributes" || !selected.value) throw new Error("native_job_child_missing");
  const selectedEntry = selected.value;
  if (selectedEntry.change) return selectedEntry.change;
  const list = childList();
  list.push({ kind: "update", name: selectedEntry.name, attributes: {} });
  return list[list.length - 1]!;
}
function update(name: string, change: NativeJobFieldChange) {
  if (section.value === "attributes") {
    if (!draft.value.attributes) draft.value.attributes = {};
    draft.value.attributes[name] = change;
  } else {
    const child = childDraft();
    if (name === "NAME" && child.kind === "add" && change.kind === "set") child.name = String(change.value);
    else {
      if (!child.attributes) child.attributes = {};
      child.attributes[name] = change;
    }
  }
}
function value(name: string): NativeJobValue | undefined {
  if (name === "NAME" && selected.value?.change?.kind === "add") return selected.value.change.name;
  const change = changes.value[name];
  if (change?.kind === "clear") return null;
  if (change?.kind === "set") return change.value;
  if (name === "COMMAND_INPUT") return Number(original.value.TYPE) === 0 ? original.value.COMMAND : undefined;
  return original.value[name];
}
function input(field: Field, event: Event) {
  const target = event.target as HTMLInputElement;
  const next = field.type === "boolean" ? target.checked : field.type === "number" && target.value !== "" ? Number(target.value) : target.value;
  update(field.name, { kind: "set", value: typeof next === "number" && !Number.isFinite(next) ? "" : next });
}
function add() {
  if (section.value === "attributes") return;
  const list = childList();
  const stem = section.value === "steps" ? "STEP" : "SCHEDULE";
  let index = entries.value.length + 1;
  while (entries.value.some((entry) => entry.name.toUpperCase() === `${stem}_${index}`)) index++;
  list.push({ kind: "add", name: `${stem}_${index}`, attributes: section.value === "steps" ? { TYPE: { kind: "set", value: 0 } } : {} });
  selectedIndex.value = entries.value.length - 1;
}
function toggleDrop() {
  const child = childDraft();
  if (child.kind === "add" && section.value !== "attributes") {
    const list = draft.value[section.value]!;
    list.splice(list.indexOf(child), 1);
    selectedIndex.value = Math.max(0, selectedIndex.value - 1);
  } else child.kind = child.kind === "drop" ? "update" : "drop";
}
const backupInput = computed(() => section.value === "steps" && selected.value?.change?.kind !== "add" && Number(original.value.TYPE) !== 0);
function label(name: string) {
  return t(`nativeJobs.fields.${name}`);
}
function choices(name: string) {
  const group = name === "TYPE" ? (section.value === "steps" ? "stepTypes" : "scheduleTypes") : name === "SUCC_ACTION" || name === "FAIL_ACTION" ? "actions" : name === "EMAIL_TYPE" || name === "NETSEND_TYPE" ? "notificationTypes" : undefined;
  const count = group === "stepTypes" ? 7 : group === "scheduleTypes" ? 9 : group === "actions" ? 4 : 3;
  return group ? Array.from({ length: count }, (_, value) => ({ value, label: t(`nativeJobs.${group}.${value}`) })) : [];
}
</script>

<template>
  <div class="grid min-h-0 gap-4">
    <nav class="flex gap-1 border-b pb-2" :aria-label="t('nativeJobs.editSections')">
      <Button v-for="item in ['attributes', 'steps', 'schedules'] as const" :key="item" size="sm" :variant="section === item ? 'secondary' : 'ghost'" @click="choose(item)">{{ t(`nativeJobs.${item}`) }}</Button>
    </nav>
    <p v-if="!readable" role="status" class="rounded border border-amber-500/40 p-3 text-sm">{{ t("nativeJobs.partitionUnavailable", { status: metadata?.status ?? details?.snapshot.definition.status }) }}</p>
    <div v-if="section !== 'attributes'" class="flex flex-wrap items-center gap-2">
      <label class="grid min-w-48 flex-1 gap-1 text-sm">
        <span>{{ t(`nativeJobs.${section}`) }}</span>
        <select v-model.number="selectedIndex" :aria-label="t(`nativeJobs.${section}`)" class="h-9 rounded-md border bg-background px-2" :disabled="disabled || !readable">
          <option v-for="(entry, index) in entries" :key="index" :value="index">{{ entry.name }}{{ entry.change?.kind === "drop" ? ` · ${t("nativeJobs.pendingDrop")}` : "" }}{{ entry.change?.kind === "add" ? ` · ${t("nativeJobs.pendingAdd")}` : "" }}</option>
        </select>
      </label>
      <Button size="sm" variant="outline" :disabled="disabled || !readable" @click="add">{{ t("nativeJobs.add") }}</Button>
      <Button v-if="selected" size="sm" variant="outline" :disabled="disabled" @click="toggleDrop">{{ removed ? t("nativeJobs.undoDrop") : t("common.delete") }}</Button>
    </div>
    <div v-if="readable && (section === 'attributes' || selected)" class="grid gap-4 sm:grid-cols-2">
      <label v-for="field in fields" :key="field.name" class="grid content-start gap-1.5 text-sm" :class="field.type === 'body' ? 'sm:col-span-2' : ''">
        <span class="flex items-center gap-2">
          <span>{{ label(field.name) }}</span>
          <button v-if="changes[field.name] && changes[field.name]?.kind !== 'keep'" type="button" class="ml-auto text-xs text-primary hover:underline" :disabled="disabled || removed" @click.prevent="update(field.name, { kind: 'keep' })">{{ t("nativeJobs.keepOriginal") }}</button>
          <button v-if="field.nullable" type="button" class="text-xs text-muted-foreground hover:text-foreground" :disabled="disabled || removed" @click.prevent="update(field.name, { kind: 'clear' })">NULL</button>
        </span>
        <textarea
          v-if="field.type === 'body'"
          :value="String(value(field.name) ?? '')"
          :aria-label="label(field.name)"
          class="min-h-36 rounded-md border bg-background p-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :disabled="disabled || removed"
          @input="input(field, $event)"
        />
        <select v-else-if="choices(field.name).length" :value="value(field.name)" :aria-label="label(field.name)" class="h-9 rounded-md border bg-background px-2" :disabled="disabled || removed" @change="input(field, $event)">
          <option v-for="option in choices(field.name)" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <input v-else-if="field.type === 'boolean'" type="checkbox" class="h-4 w-4" :aria-label="label(field.name)" :checked="value(field.name) === true || value(field.name) === 1 || value(field.name) === '1'" :disabled="disabled || removed" @change="input(field, $event)" />
        <input
          v-else
          :type="field.type"
          :value="value(field.name) ?? ''"
          :aria-label="label(field.name)"
          :placeholder="value(field.name) === null ? 'NULL' : ''"
          class="h-9 rounded-md border bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :disabled="disabled || removed"
          @input="input(field, $event)"
        />
        <span v-if="changes[field.name]?.kind === 'clear'" class="text-xs text-muted-foreground">{{ t("nativeJobs.explicitNull") }}</span>
        <span v-if="(field.name === 'EMAIL_OPERATOR_NAME' || field.name === 'NETSEND_OPERATOR_NAME') && !changes[field.name] && Number(original[field.name === 'EMAIL_OPERATOR_NAME' ? 'EMAIL_OPERID' : 'NETSEND_OPERID']) > 0" class="text-xs text-muted-foreground">{{
          t("nativeJobs.keepOperator", { id: original[field.name === "EMAIL_OPERATOR_NAME" ? "EMAIL_OPERID" : "NETSEND_OPERID"] })
        }}</span>
        <span v-if="field.name === 'SUCC_NEXT_STEP' || field.name === 'FAIL_NEXT_STEP'" class="text-xs text-muted-foreground">{{ t("nativeJobs.nextStepHint") }}</span>
      </label>
      <div v-if="backupInput" class="grid gap-2 sm:col-span-2">
        <p class="text-sm text-muted-foreground">{{ t("nativeJobs.generatedCommandHint") }}</p>
        <pre class="max-h-32 overflow-auto rounded border bg-muted/30 p-2 text-xs"><code>{{ original.COMMAND }}</code></pre>
      </div>
    </div>
  </div>
</template>
