<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import type { CheckChange, CheckChangePreview, CheckChangeResult, CheckDefinition } from "@/types/constraintChange";
const props = defineProps<{ connectionId: string; database: string; schema: string; tableName: string; names: string[]; disabled: boolean; oceanbase: boolean; confirm: (sql: string) => Promise<boolean> }>();
const emit = defineEmits<{ changed: [result: CheckChangeResult]; busy: [value: boolean] }>();
const { t } = useI18n();
const selected = ref("");
const originalName = ref<string | null>(null);
const draft = ref<CheckDefinition>();
const remove = ref(false);
const busy = ref(false);
const error = ref("");
const plan = ref<CheckChangePreview>();
const result = ref<CheckChangeResult>();
let requestId = 0;
const request = computed<CheckChange>(() => ({ schema: props.schema, tableName: props.tableName, originalName: originalName.value, desired: remove.value ? null : draft.value ? { ...draft.value } : null }));
watch(
  [draft, remove],
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
  originalName.value = existing ? selected.value : null;
  try {
    if (existing) {
      const metadata = await api.previewCheckChange(props.connectionId, props.database, { schema: props.schema, tableName: props.tableName, originalName: selected.value, desired: null });
      if (id !== requestId) return;
      if (!metadata.currentConstraint) throw new Error(t("checkEditor.missing"));
      draft.value = { ...metadata.currentConstraint };
    } else draft.value = { name: "", expression: "", enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
  } catch (cause) {
    if (id === requestId) error.value = String(cause);
  } finally {
    if (id === requestId) busy.value = false;
  }
}
async function preview() {
  if (props.disabled || busy.value || !draft.value) return;
  const id = ++requestId;
  busy.value = true;
  plan.value = undefined;
  result.value = undefined;
  error.value = "";
  try {
    const value = await api.previewCheckChange(props.connectionId, props.database, request.value);
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
    const value = await api.applyCheckChange(props.connectionId, props.database, change, reviewed.revision);
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
  <section class="mb-3 space-y-3 rounded-md border p-3 text-sm" :aria-label="t('checkEditor.title')">
    <div v-if="!draft" class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="disabled || busy" @click="start(false)">{{ t("checkEditor.add") }}</Button>
      <select v-model="selected" :aria-label="t('checkEditor.existing')" :disabled="disabled || busy" class="rounded border bg-background px-2">
        <option value="">{{ t("checkEditor.existing") }}</option>
        <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
      </select>
      <Button variant="outline" size="sm" :disabled="disabled || busy || !selected" @click="start(true)">{{ t("checkEditor.edit") }}</Button>
    </div>
    <template v-else>
      <fieldset :disabled="disabled || busy" class="space-y-3">
        <label v-if="originalName" class="flex items-center gap-2"><input v-model="remove" type="checkbox" data-drop />{{ t("checkEditor.drop") }}</label>
        <template v-if="!remove">
          <label class="block">{{ t("foreignKeyEditor.name") }}<input v-model="draft.name" class="ml-2 rounded border bg-background p-1 font-mono" data-name /></label>
          <label class="block">{{ t("checkEditor.expression") }}<textarea v-model="draft.expression" rows="6" spellcheck="false" class="mt-1 block w-full rounded border bg-background p-2 font-mono" data-expression /></label>
          <p class="text-muted-foreground">{{ t("checkEditor.hint") }}</p>
          <div class="flex flex-wrap gap-3">
            <label><input v-model="draft.enabled" type="checkbox" data-enabled /> {{ t("foreignKeyEditor.enabled") }}</label>
            <label><input v-model="draft.validated" type="checkbox" data-validated /> {{ t("foreignKeyEditor.validated") }}</label>
            <template v-if="!oceanbase"
              ><label><input v-model="draft.deferrable" type="checkbox" @change="!draft.deferrable && (draft.initiallyDeferred = false)" /> {{ t("foreignKeyEditor.deferrable") }}</label
              ><label><input v-model="draft.initiallyDeferred" type="checkbox" :disabled="!draft.deferrable" /> {{ t("foreignKeyEditor.deferred") }}</label></template
            >
          </div>
        </template>
      </fieldset>
      <div v-if="plan" class="space-y-2">
        <ul class="list-inside list-disc">
          <li v-for="item in plan.affectedObjects" :key="item">{{ item }}</li>
        </ul>
        <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{{ plan.statements.join(";\n") || t("constraintEditor.noChanges") }}</pre>
        <p>{{ t("constraintEditor.nonAtomic") }}</p>
        <template v-if="plan.recoveryStatements.length">
          <p>{{ t("constraintEditor.recovery") }}</p>
          <pre class="overflow-auto whitespace-pre-wrap" data-preview-recovery>{{ plan.recoveryStatements.join(";\n") }}</pre>
        </template>
      </div>
      <div v-if="result" role="status" class="space-y-2">
        <p :class="result.success ? '' : 'text-destructive'">{{ t(result.success ? "constraintEditor.applied" : "constraintEditor.incomplete") }}</p>
        <div v-for="(step, index) in result.steps" :key="index">
          <p>{{ t(step.success ? "constraintEditor.stepSucceeded" : "constraintEditor.stepFailed") }}</p>
          <pre class="whitespace-pre-wrap">{{ step.sql }}</pre>
          <p v-if="step.error" class="text-destructive">{{ step.error }}</p>
        </div>
        <p v-if="result.refreshError" role="alert" class="text-destructive">{{ result.refreshError }}</p>
        <template v-if="result.currentConstraint"
          ><p>{{ result.currentConstraint.name }} · {{ result.currentConstraint.enabled ? "ENABLE" : "DISABLE" }} {{ result.currentConstraint.validated ? "VALIDATE" : "NOVALIDATE" }}</p>
          <pre class="whitespace-pre-wrap">{{ result.currentConstraint.expression }}</pre>
        </template>
        <p v-else-if="!result.refreshError">{{ t("checkEditor.current") }}: {{ t("constraintEditor.none") }}</p>
        <template v-if="result.originalConstraint && result.originalConstraint.name !== result.currentConstraint?.name"
          ><p>{{ t("checkEditor.existing") }}: {{ result.originalConstraint.name }}</p>
          <pre class="whitespace-pre-wrap">{{ result.originalConstraint.expression }}</pre>
        </template>
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
