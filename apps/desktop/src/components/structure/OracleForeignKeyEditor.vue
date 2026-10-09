<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import type { ForeignKeyChange, ForeignKeyChangePreview, ForeignKeyChangeResult, ForeignKeyDefinition } from "@/types/constraintChange";

const props = defineProps<{
  connectionId: string; database: string; schema: string; tableName: string;
  columns: string[]; names: string[]; disabled: boolean; oceanbase: boolean;
  confirm: (sql: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ changed: [result: ForeignKeyChangeResult]; busy: [value: boolean] }>();
const { t } = useI18n();
const selected = ref("");
const originalName = ref<string | null>(null);
const draft = ref<ForeignKeyDefinition>();
const remove = ref(false);
const busy = ref(false);
const error = ref("");
const plan = ref<ForeignKeyChangePreview>();
const result = ref<ForeignKeyChangeResult>();
let requestId = 0;
const request = computed<ForeignKeyChange>(() => ({ schema: props.schema, tableName: props.tableName, originalName: originalName.value, desired: remove.value ? null : draft.value ? { ...draft.value, columns: [...draft.value.columns], referencedColumns: [...draft.value.referencedColumns] } : null }));
watch([draft, remove], () => { plan.value = undefined; result.value = undefined; error.value = ""; }, { deep: true });
watch(() => [props.connectionId, props.database, props.schema, props.tableName], () => { requestId++; draft.value = undefined; selected.value = ""; originalName.value = null; busy.value = false; plan.value = undefined; result.value = undefined; error.value = ""; });

async function start(existing: boolean) {
  if (props.disabled || busy.value || (existing && !selected.value)) return;
  const id = ++requestId;
  busy.value = true;
  error.value = "";
  plan.value = undefined;
  result.value = undefined;
  remove.value = false;
  originalName.value = existing ? selected.value : null;
  try {
    if (existing) {
      // Preview is read-only. Load the full definition without accepting its drop plan.
      const metadata = await api.previewForeignKeyChange(props.connectionId, props.database, { schema: props.schema, tableName: props.tableName, originalName: selected.value, desired: null });
      if (id !== requestId) return;
      if (!metadata.currentConstraint) throw new Error(t("foreignKeyEditor.missing"));
      draft.value = { ...metadata.currentConstraint, columns: [...metadata.currentConstraint.columns], referencedColumns: [...metadata.currentConstraint.referencedColumns] };
    } else {
      draft.value = { name: "", columns: [props.columns[0] ?? ""], referencedSchema: props.schema, referencedTable: "", referencedColumns: [""], deleteRule: "NO ACTION", enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
    }
  } catch (cause) { if (id === requestId) error.value = String(cause); }
  finally { if (id === requestId) busy.value = false; }
}

function move(index: number, direction: number) {
  if (!draft.value) return;
  const destination = index + direction;
  if (destination < 0 || destination >= draft.value.columns.length) return;
  for (const columns of [draft.value.columns, draft.value.referencedColumns]) [columns[index], columns[destination]] = [columns[destination]!, columns[index]!];
}
function addPair() { draft.value?.columns.push(props.columns[0] ?? ""); draft.value?.referencedColumns.push(""); }
function removePair(index: number) { draft.value?.columns.splice(index, 1); draft.value?.referencedColumns.splice(index, 1); }
async function preview() {
  if (props.disabled || busy.value || !draft.value) return;
  const id = ++requestId;
  busy.value = true; plan.value = undefined; result.value = undefined; error.value = "";
  try { const value = await api.previewForeignKeyChange(props.connectionId, props.database, request.value); if (id === requestId) plan.value = value; }
  catch (cause) { if (id === requestId) error.value = String(cause); }
  finally { if (id === requestId) busy.value = false; }
}
async function apply() {
  if (props.disabled || busy.value || !plan.value?.statements.length) return;
  const id = ++requestId;
  const reviewed = plan.value;
  const change = request.value;
  busy.value = true;
  try {
    if (!(await props.confirm(reviewed.statements.join(";\n"))) || id !== requestId) return;
    emit("busy", true); plan.value = undefined; error.value = "";
    const value = await api.applyForeignKeyChange(props.connectionId, props.database, change, reviewed.revision);
    if (id !== requestId) return;
    result.value = value;
    emit("changed", value);
  } catch (cause) { if (id === requestId) { error.value = String(cause); plan.value = undefined; } }
  finally { if (id === requestId) busy.value = false; emit("busy", false); }
}
function cancel() { if (busy.value) return; requestId++; draft.value = undefined; plan.value = undefined; result.value = undefined; error.value = ""; }
</script>

<template>
  <section class="mb-3 space-y-3 rounded-md border p-3 text-sm" :aria-label="t('foreignKeyEditor.title')">
    <div v-if="!draft" class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="disabled || busy" @click="start(false)">{{ t('foreignKeyEditor.add') }}</Button>
      <select v-model="selected" :aria-label="t('foreignKeyEditor.existing')" :disabled="disabled || busy" class="rounded border bg-background px-2"><option value="">{{ t('foreignKeyEditor.existing') }}</option><option v-for="name in names" :key="name" :value="name">{{ name }}</option></select>
      <Button variant="outline" size="sm" :disabled="disabled || busy || !selected" @click="start(true)">{{ t('foreignKeyEditor.edit') }}</Button>
    </div>
    <template v-else>
      <fieldset :disabled="disabled || busy" class="space-y-3">
        <label v-if="originalName" class="flex items-center gap-2"><input v-model="remove" type="checkbox" data-drop />{{ t('foreignKeyEditor.drop') }}</label>
        <div v-if="!remove" class="space-y-3">
          <label class="block">{{ t('foreignKeyEditor.name') }}<input v-model="draft.name" class="ml-2 rounded border bg-background p-1 font-mono" data-name /></label>
          <div class="flex flex-wrap gap-3">
            <label>{{ t('foreignKeyEditor.schema') }}<input v-model="draft.referencedSchema" class="ml-2 rounded border bg-background p-1 font-mono" data-ref-schema /></label>
            <label>{{ t('foreignKeyEditor.table') }}<input v-model="draft.referencedTable" class="ml-2 rounded border bg-background p-1 font-mono" data-ref-table /></label>
          </div>
          <p>{{ t('foreignKeyEditor.pairs') }}</p>
          <ol class="space-y-2"><li v-for="(_, index) in draft.columns" :key="index" class="flex flex-wrap items-center gap-2">
            <span>{{ index + 1 }}.</span>
            <select v-model="draft.columns[index]" :aria-label="t('foreignKeyEditor.sourceColumn')" class="rounded border bg-background p-1" data-source-column><option v-for="column in columns" :key="column" :value="column">{{ column }}</option></select>
            <span>→</span><input v-model="draft.referencedColumns[index]" :aria-label="t('foreignKeyEditor.targetColumn')" class="rounded border bg-background p-1 font-mono" data-target-column />
            <Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveUp', { column: draft.columns[index] })" :disabled="index === 0" @click="move(index, -1)">↑</Button>
            <Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveDown', { column: draft.columns[index] })" :disabled="index === draft.columns.length - 1" @click="move(index, 1)">↓</Button>
            <Button variant="ghost" size="sm" @click="removePair(index)">{{ t('foreignKeyEditor.removePair') }}</Button>
          </li></ol>
          <Button variant="outline" size="sm" @click="addPair">{{ t('foreignKeyEditor.addPair') }}</Button>
          <label class="block">{{ t('foreignKeyEditor.deleteRule') }}<select v-model="draft.deleteRule" class="ml-2 rounded border bg-background p-1"><option>NO ACTION</option><option>CASCADE</option><option>SET NULL</option></select></label>
          <div class="flex flex-wrap gap-3">
            <label><input v-model="draft.enabled" type="checkbox" /> {{ t('foreignKeyEditor.enabled') }}</label>
            <label><input v-model="draft.validated" type="checkbox" /> {{ t('foreignKeyEditor.validated') }}</label>
            <template v-if="!oceanbase"><label><input v-model="draft.deferrable" type="checkbox" @change="!draft.deferrable && (draft.initiallyDeferred = false)" /> {{ t('foreignKeyEditor.deferrable') }}</label><label><input v-model="draft.initiallyDeferred" type="checkbox" :disabled="!draft.deferrable" /> {{ t('foreignKeyEditor.deferred') }}</label></template>
          </div>
        </div>
      </fieldset>
      <div v-if="plan" class="space-y-2"><ul class="list-inside list-disc"><li v-for="item in plan.affectedObjects" :key="item">{{ item }}</li></ul><pre class="overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{{ plan.statements.join(';\n') || t('constraintEditor.noChanges') }}</pre><p>{{ t('constraintEditor.nonAtomic') }}</p></div>
      <div v-if="result" role="status" class="space-y-2">
        <p :class="result.success ? '' : 'text-destructive'">{{ t(result.success ? 'constraintEditor.applied' : 'constraintEditor.incomplete') }}</p>
        <div v-for="(step, index) in result.steps" :key="index"><p>{{ t(step.success ? 'constraintEditor.stepSucceeded' : 'constraintEditor.stepFailed') }}</p><pre class="whitespace-pre-wrap">{{ step.sql }}</pre><p v-if="step.error" class="text-destructive">{{ step.error }}</p></div>
        <p v-if="result.refreshError" role="alert" class="text-destructive">{{ result.refreshError }}</p>
        <p v-else>{{ t('foreignKeyEditor.current') }}: {{ result.currentConstraint?.name ?? t('constraintEditor.none') }}</p>
        <p v-if="!result.refreshError && result.originalConstraint && result.originalConstraint.name !== result.currentConstraint?.name">{{ t('foreignKeyEditor.existing') }}: {{ result.originalConstraint.name }} ({{ result.originalConstraint.columns.join(', ') }})</p>
        <template v-if="result.recoveryStatements.length"><p>{{ t('constraintEditor.recovery') }}</p><pre class="overflow-auto whitespace-pre-wrap">{{ result.recoveryStatements.join(';\n') }}</pre></template>
      </div>
      <div class="flex gap-2"><Button variant="outline" size="sm" :disabled="disabled || busy" @click="preview">{{ t('constraintEditor.preview') }}</Button><Button size="sm" :disabled="disabled || busy || !plan?.statements.length" @click="apply">{{ t('constraintEditor.apply') }}</Button><Button variant="ghost" size="sm" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</Button></div>
    </template>
    <p v-if="error" role="alert" class="whitespace-pre-wrap text-destructive">{{ error }}</p>
  </section>
</template>
