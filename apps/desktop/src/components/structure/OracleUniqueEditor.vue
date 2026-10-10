<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import type { UniqueChange, UniqueChangePreview, UniqueChangeResult, UniqueDefinition } from "@/types/constraintChange";
const props = defineProps<{ connectionId: string; database: string; schema: string; tableName: string; columns: string[]; names: string[]; disabled: boolean; oceanbase: boolean; confirm: (sql: string) => Promise<boolean> }>();
const emit = defineEmits<{ changed: [result: UniqueChangeResult]; busy: [value: boolean] }>();
const { t } = useI18n();
const selected = ref("");
const originalName = ref<string | null>(null);
const originalIndex = ref("");
const draft = ref<UniqueDefinition>();
const remove = ref(false);
const dropPreviousIndex = ref(false);
const busy = ref(false);
const error = ref("");
const plan = ref<UniqueChangePreview>();
const result = ref<UniqueChangeResult>();
let requestId = 0;
const request = computed<UniqueChange>(() => ({
  schema: props.schema,
  tableName: props.tableName,
  originalName: originalName.value,
  desired: remove.value ? null : draft.value ? { ...draft.value, columns: [...draft.value.columns] } : null,
  dropPreviousIndex: !props.oceanbase && dropPreviousIndex.value,
}));
watch(
  [draft, remove, dropPreviousIndex],
  () => {
    plan.value = undefined;
    result.value = undefined;
    error.value = "";
  },
  { deep: true },
);
watch(
  () => [props.connectionId, props.database, props.schema, props.tableName],
  () => {
    requestId++;
    draft.value = undefined;
    selected.value = "";
    originalName.value = null;
    originalIndex.value = "";
    busy.value = false;
    plan.value = undefined;
    result.value = undefined;
    error.value = "";
  },
);
async function start(existing: boolean) {
  if (props.disabled || busy.value || (existing && !selected.value)) return;
  const id = ++requestId;
  busy.value = true;
  error.value = "";
  plan.value = undefined;
  result.value = undefined;
  remove.value = false;
  dropPreviousIndex.value = false;
  originalName.value = existing ? selected.value : null;
  originalIndex.value = "";
  try {
    if (existing) {
      const metadata = await api.previewUniqueChange(props.connectionId, props.database, { schema: props.schema, tableName: props.tableName, originalName: selected.value, desired: null, dropPreviousIndex: false });
      if (id !== requestId) return;
      if (!metadata.currentConstraint) throw new Error(t("uniqueEditor.missing"));
      const { indexOwner, indexName, ...definition } = metadata.currentConstraint;
      originalIndex.value = [indexOwner, indexName].filter(Boolean).join(".");
      draft.value = { ...definition, columns: [...definition.columns] };
    } else draft.value = { name: "", columns: [], enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
  } catch (cause) {
    if (id === requestId) error.value = String(cause);
  } finally {
    if (id === requestId) busy.value = false;
  }
}
function toggle(column: string) {
  if (draft.value) draft.value.columns = draft.value.columns.includes(column) ? draft.value.columns.filter((value) => value !== column) : [...draft.value.columns, column];
}
function move(index: number, direction: number) {
  if (!draft.value) return;
  const destination = index + direction;
  const columns = [...draft.value.columns];
  if (destination < 0 || destination >= columns.length) return;
  [columns[index], columns[destination]] = [columns[destination]!, columns[index]!];
  draft.value.columns = columns;
}
async function preview() {
  if (props.disabled || busy.value || !draft.value) return;
  const id = ++requestId;
  busy.value = true;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
  try {
    const value = await api.previewUniqueChange(props.connectionId, props.database, request.value);
    if (id === requestId) plan.value = value;
  } catch (cause) {
    if (id === requestId) error.value = String(cause);
  } finally {
    if (id === requestId) busy.value = false;
  }
}
async function apply() {
  if (props.disabled || busy.value || !plan.value?.statements.length) return;
  const id = ++requestId;
  const reviewed = plan.value;
  const change = request.value;
  busy.value = true;
  try {
    if (!(await props.confirm(reviewed.statements.join(";\n"))) || id !== requestId) return;
    emit("busy", true);
    plan.value = undefined;
    error.value = "";
    const value = await api.applyUniqueChange(props.connectionId, props.database, change, reviewed.revision);
    if (id !== requestId) return;
    result.value = value;
    emit("changed", value);
  } catch (cause) {
    if (id === requestId) {
      error.value = String(cause);
      plan.value = undefined;
    }
  } finally {
    if (id === requestId) busy.value = false;
    emit("busy", false);
  }
}
function cancel() {
  if (busy.value) return;
  requestId++;
  draft.value = undefined;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
}
</script>
<template>
  <section class="mb-3 space-y-3 rounded-md border p-3 text-sm" :aria-label="t('uniqueEditor.title')">
    <div v-if="!draft" class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="disabled || busy" @click="start(false)">{{ t("uniqueEditor.add") }}</Button>
      <select v-model="selected" :aria-label="t('uniqueEditor.existing')" :disabled="disabled || busy" class="rounded border bg-background px-2">
        <option value="">{{ t("uniqueEditor.existing") }}</option>
        <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
      </select>
      <Button variant="outline" size="sm" :disabled="disabled || busy || !selected" @click="start(true)">{{ t("uniqueEditor.edit") }}</Button>
    </div>
    <template v-else>
      <p v-if="originalName" class="font-mono">{{ originalName }} · {{ t("uniqueEditor.index") }}: {{ originalIndex || t("constraintEditor.none") }}</p>
      <p class="text-muted-foreground">{{ t(oceanbase ? "uniqueEditor.oceanbaseHint" : "uniqueEditor.oracleHint") }}</p>
      <fieldset :disabled="disabled || busy" class="space-y-3">
        <label v-if="originalName" class="flex items-center gap-2"><input v-model="remove" type="checkbox" data-drop />{{ t("uniqueEditor.drop") }}</label>
        <template v-if="!remove">
          <label class="block">{{ t("foreignKeyEditor.name") }}<input v-model="draft.name" class="ml-2 rounded border bg-background p-1 font-mono" data-name /></label>
          <div class="flex flex-wrap gap-3">
            <label v-for="column in columns" :key="column" class="flex items-center gap-1 font-mono"><input type="checkbox" :checked="draft.columns.includes(column)" data-column @change="toggle(column)" />{{ column }}</label>
          </div>
          <ol class="space-y-1">
            <li v-for="(column, index) in draft.columns" :key="column" class="flex items-center gap-2">
              <span class="flex-1 font-mono">{{ index + 1 }}. {{ column }}</span
              ><Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveUp', { column })" :disabled="index === 0" @click="move(index, -1)">↑</Button
              ><Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveDown', { column })" :disabled="index === draft.columns.length - 1" @click="move(index, 1)">↓</Button>
            </li>
          </ol>
          <div v-if="!oceanbase" class="flex flex-wrap gap-3">
            <label><input v-model="draft.enabled" type="checkbox" /> {{ t("foreignKeyEditor.enabled") }}</label
            ><label><input v-model="draft.validated" type="checkbox" /> {{ t("foreignKeyEditor.validated") }}</label
            ><label><input v-model="draft.deferrable" type="checkbox" @change="!draft.deferrable && (draft.initiallyDeferred = false)" /> {{ t("foreignKeyEditor.deferrable") }}</label
            ><label><input v-model="draft.initiallyDeferred" type="checkbox" :disabled="!draft.deferrable" /> {{ t("foreignKeyEditor.deferred") }}</label>
          </div>
        </template>
        <label v-if="originalName && !oceanbase" class="flex items-start gap-2"
          ><input v-model="dropPreviousIndex" type="checkbox" data-index-disposition /><span>{{ t("constraintEditor.dropPreviousIndex") }}</span></label
        >
      </fieldset>
      <div v-if="plan" class="space-y-2">
        <ul class="list-inside list-disc">
          <li v-for="item in plan.affectedObjects" :key="item">{{ item }}</li>
        </ul>
        <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{{ plan.statements.join(";\n") || t("constraintEditor.noChanges") }}</pre>
        <p>{{ t("constraintEditor.nonAtomic") }}</p>
      </div>
      <div v-if="result" role="status" class="space-y-2">
        <p :class="result.success ? '' : 'text-destructive'">{{ t(result.success ? "constraintEditor.applied" : "constraintEditor.incomplete") }}</p>
        <div v-for="(step, index) in result.steps" :key="index">
          <p>{{ t(step.success ? "constraintEditor.stepSucceeded" : "constraintEditor.stepFailed") }}</p>
          <pre class="whitespace-pre-wrap">{{ step.sql }}</pre>
          <p v-if="step.error" class="text-destructive">{{ step.error }}</p>
        </div>
        <p v-if="result.refreshError" role="alert" class="text-destructive">{{ result.refreshError }}</p>
        <p v-if="result.currentConstraint" class="font-mono">
          {{ result.currentConstraint.name }} ({{ result.currentConstraint.columns.join(", ") }}) · {{ result.currentConstraint.enabled ? "ENABLE" : "DISABLE" }} {{ result.currentConstraint.validated ? "VALIDATE" : "NOVALIDATE" }} · {{ result.currentConstraint.indexOwner }}.{{
            result.currentConstraint.indexName
          }}
        </p>
        <p v-else-if="!result.refreshError">{{ t("uniqueEditor.current") }}: {{ t("constraintEditor.none") }}</p>
        <p v-if="result.originalConstraint && result.originalConstraint.name !== result.currentConstraint?.name">{{ t("uniqueEditor.existing") }}: {{ result.originalConstraint.name }}</p>
        <template v-if="result.recoveryStatements.length"
          ><p>{{ t("constraintEditor.recovery") }}</p>
          <pre class="overflow-auto whitespace-pre-wrap">{{ result.recoveryStatements.join(";\n") }}</pre>
        </template>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="disabled || busy" @click="preview">{{ t("constraintEditor.preview") }}</Button
        ><Button size="sm" :disabled="disabled || busy || !plan?.statements.length" @click="apply">{{ t("constraintEditor.apply") }}</Button
        ><Button variant="ghost" size="sm" :disabled="busy" @click="cancel">{{ t("common.cancel") }}</Button>
      </div>
    </template>
    <p v-if="error" role="alert" class="whitespace-pre-wrap text-destructive">{{ error }}</p>
  </section>
</template>
