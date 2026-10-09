<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import type { ConstraintChangePreview, ConstraintChangeResult, PrimaryKeyChange } from "@/types/constraintChange";

const props = defineProps<{
  connectionId: string;
  database: string;
  schema: string;
  tableName: string;
  columns: string[];
  disabled: boolean;
  oceanbase?: boolean;
  confirm: (sql: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ changed: [result: ConstraintChangeResult]; busy: [value: boolean] }>();
const { t } = useI18n();
const open = ref(false);
const busy = ref(false);
const selected = ref<string[]>([]);
const dropPreviousIndex = ref(false);
const hasExistingKey = ref(false);
const plan = ref<ConstraintChangePreview>();
const result = ref<ConstraintChangeResult>();
const error = ref("");
let requestId = 0;
const change = computed<PrimaryKeyChange>(() => ({ schema: props.schema, tableName: props.tableName, columns: [...selected.value], dropPreviousIndex: !props.oceanbase && dropPreviousIndex.value }));

watch(() => [props.connectionId, props.database, props.schema, props.tableName, props.oceanbase], () => {
  requestId++;
  open.value = false;
  busy.value = false;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
});
watch(selected, () => { plan.value = undefined; result.value = undefined; error.value = ""; }, { deep: true });
watch(dropPreviousIndex, () => { plan.value = undefined; result.value = undefined; error.value = ""; });

async function start() {
  if (props.disabled || busy.value) return;
  const id = ++requestId;
  busy.value = true;
  open.value = true;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
  try {
    const constraints = await api.listConstraints(props.connectionId, props.database, props.schema, props.tableName);
    if (id !== requestId) return;
    const current = constraints.find((item) => item.constraint_type.replaceAll("_", " ").toUpperCase() === "PRIMARY KEY");
    selected.value = [...(current?.columns ?? [])];
    hasExistingKey.value = !!current;
    dropPreviousIndex.value = false;
  } catch (cause) {
    if (id === requestId) error.value = String(cause);
  } finally {
    if (id === requestId) busy.value = false;
  }
}

function toggle(column: string) {
  selected.value = selected.value.includes(column) ? selected.value.filter((value) => value !== column) : [...selected.value, column];
}

function move(index: number, direction: number) {
  const next = [...selected.value];
  const destination = index + direction;
  if (destination < 0 || destination >= next.length) return;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  selected.value = next;
}

async function preview() {
  if (props.disabled || busy.value) return;
  const id = ++requestId;
  busy.value = true;
  error.value = "";
  result.value = undefined;
  plan.value = undefined;
  try {
    const preview = await api.previewPrimaryKeyChange(props.connectionId, props.database, change.value);
    if (id === requestId) plan.value = preview;
  } catch (cause) {
    if (id === requestId) error.value = String(cause);
  } finally {
    if (id === requestId) busy.value = false;
  }
}

async function apply() {
  if (props.disabled || busy.value || !plan.value?.statements.length) return;
  const reviewed = plan.value;
  const requested = change.value;
  const id = ++requestId;
  busy.value = true;
  try {
    if (!(await props.confirm(reviewed.statements.join(";\n"))) || id !== requestId) return;
    emit("busy", true);
    // Every execution, including a partial failure, requires a fresh preview.
    plan.value = undefined;
    error.value = "";
    const applied = await api.applyPrimaryKeyChange(props.connectionId, props.database, requested, reviewed.revision);
    if (id !== requestId) return;
    result.value = applied;
    emit("changed", result.value);
  } catch (cause) {
    if (id === requestId) {
      error.value = String(cause);
      plan.value = undefined;
    }
  } finally {
    busy.value = false;
    emit("busy", false);
  }
}

function cancel() {
  if (busy.value) return;
  requestId++;
  open.value = false;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
}
</script>

<template>
  <div class="mb-3 rounded-md border p-3 text-sm">
    <Button v-if="!open" variant="outline" size="sm" :disabled="disabled || busy" @click="start">{{ t("constraintEditor.editPrimaryKey") }}</Button>
    <section v-else :aria-label="t('constraintEditor.editPrimaryKey')" class="space-y-3">
      <p class="text-muted-foreground">{{ t(oceanbase ? "constraintEditor.oceanbasePrimaryKeyHint" : "constraintEditor.primaryKeyHint") }}</p>
      <label v-if="hasExistingKey && !oceanbase" class="flex items-start gap-2">
        <input v-model="dropPreviousIndex" type="checkbox" :disabled="disabled || busy" data-index-disposition />
        <span>{{ t("constraintEditor.dropPreviousIndex") }}</span>
      </label>
      <fieldset :disabled="disabled || busy" class="flex flex-wrap gap-3">
        <label v-for="column in columns" :key="column" class="flex items-center gap-1 font-mono">
          <input type="checkbox" :checked="selected.includes(column)" @change="toggle(column)" />{{ column }}
        </label>
      </fieldset>
      <ol class="space-y-1">
        <li v-for="(column, index) in selected" :key="column" class="flex items-center gap-2">
          <span class="min-w-0 flex-1 font-mono">{{ index + 1 }}. {{ column }}</span>
          <Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveUp', { column })" :disabled="disabled || busy || index === 0" @click="move(index, -1)">↑</Button>
          <Button variant="outline" size="sm" :aria-label="t('constraintEditor.moveDown', { column })" :disabled="disabled || busy || index === selected.length - 1" @click="move(index, 1)">↓</Button>
        </li>
      </ol>
      <p v-if="error" role="alert" class="whitespace-pre-wrap text-destructive">{{ error }}</p>
      <div v-if="plan" class="space-y-2">
        <p class="font-medium">{{ t("constraintEditor.affectedObjects") }}</p>
        <ul class="list-inside list-disc"><li v-for="item in plan.affectedObjects" :key="item">{{ item }}</li></ul>
        <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{{ plan.statements.join(";\n") || t("constraintEditor.noChanges") }}</pre>
        <p class="text-muted-foreground">{{ t("constraintEditor.nonAtomic") }}</p>
      </div>
      <div v-if="result" role="status" class="space-y-2">
        <p :class="result.success ? '' : 'text-destructive'">{{ t(result.success ? "constraintEditor.applied" : "constraintEditor.incomplete") }}</p>
        <div v-for="(step, index) in result.steps" :key="index" class="rounded border p-2">
          <p>{{ index + 1 }}. {{ t(step.success ? "constraintEditor.stepSucceeded" : "constraintEditor.stepFailed") }}</p>
          <pre class="whitespace-pre-wrap">{{ step.sql }}</pre><p v-if="step.error" class="text-destructive">{{ step.error }}</p>
        </div>
        <p v-if="result.refreshError" role="alert" class="text-destructive">{{ result.refreshError }}</p>
        <p v-else class="font-mono">{{ t("constraintEditor.currentPrimaryKey") }}: {{ result.currentConstraint ? `${result.currentConstraint.name} (${result.currentConstraint.columns.join(", ")})` : t("constraintEditor.none") }}</p>
        <template v-if="result.recoveryStatements.length">
          <p>{{ t("constraintEditor.recovery") }}</p>
          <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{{ result.recoveryStatements.join(";\n") }}</pre>
        </template>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="disabled || busy" @click="preview">{{ t("constraintEditor.preview") }}</Button>
        <Button size="sm" :disabled="disabled || busy || !plan?.statements.length" @click="apply">{{ t("constraintEditor.apply") }}</Button>
        <Button variant="ghost" size="sm" :disabled="busy" @click="cancel">{{ t("common.cancel") }}</Button>
      </div>
    </section>
  </div>
</template>
