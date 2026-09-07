<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FlaskConical, Plus, Save, ShieldCheck, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/backend/api";
import { createResultProtectionRule, prepareResultProtectionPolicy, resultProtectionTemplate, type McpResultProtectionPolicy, type ResultProtectionAction, type ResultProtectionHit } from "@/lib/mcp/mcpResultProtection";

const props = defineProps<{
  policy: McpResultProtectionPolicy;
  connections: readonly { id: string; name: string }[];
  disabled: boolean;
  savePolicy: (policy: McpResultProtectionPolicy) => Promise<void>;
}>();
const { t } = useI18n();
const clone = (policy: McpResultProtectionPolicy): McpResultProtectionPolicy => JSON.parse(JSON.stringify(policy));
const draft = ref(clone(props.policy));
const scopeIndex = ref(-1);
const saving = ref(false);
const testing = ref(false);
const error = ref("");
const newConnection = ref("");
const newDatabase = ref("");
const sample = ref({ column: "phone", dataType: "varchar", value: "13800001234", schema: "", table: "" });
const hits = ref<ResultProtectionHit[] | null>(null);
const settings = computed(() => draft.value.overrides[scopeIndex.value]?.settings ?? draft.value.default);
const busy = computed(() => props.disabled || saving.value || testing.value);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.policy));
const actions: ResultProtectionAction[] = ["remove", "mask", "partial", "hash", "deny"];
const ruleFields = [
  { key: "dataTypePattern", label: "mcpResultTypePattern" },
  { key: "valuePattern", label: "mcpResultValuePattern" },
  { key: "schema", label: "mcpResultSchema" },
  { key: "table", label: "mcpResultTable" },
] as const;
const sampleFields = [
  { key: "column", label: "mcpResultColumn" },
  { key: "dataType", label: "mcpResultType" },
  { key: "schema", label: "mcpResultSchema" },
  { key: "table", label: "mcpResultTable" },
  { key: "value", label: "mcpResultSample" },
] as const;

watch(
  () => props.policy,
  (policy) => {
    if (saving.value) return;
    draft.value = clone(policy);
    if (scopeIndex.value >= policy.overrides.length) scopeIndex.value = -1;
  },
  { deep: true },
);
watch(
  [draft, scopeIndex, sample],
  () => {
    hits.value = null;
  },
  { deep: true },
);

function addOverride() {
  if (busy.value || !newConnection.value) return;
  const database = newDatabase.value.trim() || null;
  const existing = draft.value.overrides.findIndex((scope) => scope.connectionId === newConnection.value && scope.database === database);
  if (existing >= 0) {
    scopeIndex.value = existing;
    return;
  }
  const inherited = draft.value.overrides.find((scope) => scope.connectionId === newConnection.value && scope.database === null)?.settings ?? draft.value.default;
  draft.value.overrides.push({ connectionId: newConnection.value, database, settings: JSON.parse(JSON.stringify(inherited)) });
  scopeIndex.value = draft.value.overrides.length - 1;
  newDatabase.value = "";
}

function removeOverride() {
  if (busy.value || scopeIndex.value < 0) return;
  draft.value.overrides.splice(scopeIndex.value, 1);
  scopeIndex.value = -1;
}

function addRule() {
  if (busy.value) return;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  settings.value.rules.push(createResultProtectionRule(`rule-${id}`));
}

function addTemplate() {
  if (busy.value) return;
  const ids = new Set(settings.value.rules.map((rule) => rule.id));
  settings.value.rules.push(...resultProtectionTemplate().filter((rule) => !ids.has(rule.id)));
}

async function save() {
  if (busy.value || !dirty.value) return;
  saving.value = true;
  error.value = "";
  try {
    draft.value = prepareResultProtectionPolicy(draft.value);
    await props.savePolicy(clone(draft.value));
  } catch (cause) {
    error.value = t("settings.mcpPolicySaveFailed", { error: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    saving.value = false;
  }
}

async function preview() {
  if (busy.value) return;
  testing.value = true;
  error.value = "";
  hits.value = null;
  try {
    draft.value = prepareResultProtectionPolicy(draft.value);
    const policy = clone(draft.value);
    const scope = policy.overrides[scopeIndex.value];
    (scope?.settings ?? policy.default).enabled = true;
    let value: unknown = sample.value.value;
    try {
      value = JSON.parse(sample.value.value);
    } catch {
      /* Samples may be plain text. */
    }
    hits.value = await api.previewMcpResultProtection({
      policy,
      connectionId: scope?.connectionId ?? "",
      database: scope?.database ?? "",
      ...sample.value,
      value,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    testing.value = false;
  }
}

function scopeLabel(connectionId: string, database: string | null): string {
  const name = props.connections.find((connection) => connection.id === connectionId)?.name ?? connectionId;
  return database ? `${name} / ${database}` : name;
}
</script>

<template>
  <section class="min-w-0 space-y-5" data-mcp-result-protection>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">{{ t("settings.mcpResultProtectionTitle") }}</h3>
      <Button type="button" size="sm" :disabled="busy || !dirty" data-protection-save @click="save"><Save class="mr-2 size-4" />{{ t("common.save") }}</Button>
    </div>
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpResultProtectionBoundary") }}</p>
    <p v-if="error" role="alert" class="break-words text-xs text-destructive">{{ error }}</p>
    <fieldset :disabled="busy" class="min-w-0 space-y-4 disabled:opacity-60">
      <div class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div class="min-w-0 space-y-1.5">
          <Label for="mcp-result-scope">{{ t("settings.mcpResultScope") }}</Label>
          <select id="mcp-result-scope" v-model.number="scopeIndex" class="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm">
            <option :value="-1">{{ t("settings.mcpResultGlobal") }}</option>
            <option v-for="(scope, index) in draft.overrides" :key="`${scope.connectionId}:${scope.database}`" :value="index">{{ scopeLabel(scope.connectionId, scope.database) }}</option>
          </select>
        </div>
        <Button v-if="scopeIndex >= 0" type="button" variant="outline" size="icon" class="self-end" :title="t('settings.mcpResultInherit')" :aria-label="t('settings.mcpResultInherit')" @click="removeOverride"><Trash2 class="size-4" /></Button>
      </div>
      <details class="text-xs">
        <summary class="cursor-pointer text-muted-foreground">{{ t("settings.mcpResultOverride") }}</summary>
        <p class="mt-2 leading-relaxed text-muted-foreground">{{ t("settings.mcpResultDatabaseBoundary") }}</p>
        <div class="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div class="min-w-0 space-y-1.5">
            <Label for="mcp-result-connection">{{ t("settings.mcpResultConnection") }}</Label
            ><select id="mcp-result-connection" v-model="newConnection" class="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-xs">
              <option value="" disabled>{{ t("settings.mcpResultConnection") }}</option>
              <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.name }}</option>
            </select>
          </div>
          <div class="min-w-0 space-y-1.5">
            <Label for="mcp-result-database">{{ t("settings.mcpResultDatabase") }}</Label
            ><Input id="mcp-result-database" v-model="newDatabase" :placeholder="t('settings.mcpResultAllDatabases')" class="h-9 text-xs" />
          </div>
          <Button type="button" variant="outline" size="icon" class="self-end" :disabled="busy || !newConnection" :title="t('settings.mcpResultOverride')" :aria-label="t('settings.mcpResultOverride')" @click="addOverride"><Plus class="size-4" /></Button>
        </div>
      </details>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <label class="flex items-center gap-2 text-sm"><input v-model="settings.enabled" type="checkbox" data-protection-enabled />{{ t("settings.mcpResultEnabled") }}</label>
        <select v-model="settings.mode" class="h-9 max-w-full rounded-md border bg-background px-2 text-xs" :aria-label="t('settings.mcpResultMode')">
          <option value="strict">{{ t("settings.mcpResultStrict") }}</option>
          <option value="nameOnly">{{ t("settings.mcpResultNameOnly") }}</option>
        </select>
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">{{ t(settings.mode === "strict" ? "settings.mcpResultStrictBoundary" : "settings.mcpResultNameOnlyBoundary") }}</p>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Label>{{ t("settings.mcpResultRules") }}</Label>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" data-protection-template @click="addTemplate"><ShieldCheck class="mr-2 size-4" />{{ t("settings.mcpResultTemplate") }}</Button
          ><Button type="button" variant="outline" size="icon" :title="t('settings.mcpResultAddRule')" :aria-label="t('settings.mcpResultAddRule')" @click="addRule"><Plus class="size-4" /></Button>
        </div>
      </div>
      <p v-if="!settings.rules.length" class="py-3 text-xs text-muted-foreground">{{ t("settings.mcpResultNoRules") }}</p>
      <div v-for="(rule, index) in settings.rules" :key="index" class="min-w-0 space-y-3 border-t py-3" data-protection-rule>
        <div class="grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div class="min-w-0 space-y-1.5">
            <Label :for="`mcp-rule-${index}-column`">{{ t("settings.mcpResultColumnPattern") }}</Label
            ><Input :id="`mcp-rule-${index}-column`" :model-value="rule.columnPattern ?? ''" class="h-9 font-mono text-xs" @update:model-value="rule.columnPattern = String($event) || null" />
          </div>
          <div class="min-w-0 space-y-1.5">
            <Label :for="`mcp-rule-${index}-action`">{{ t("settings.mcpResultAction") }}</Label
            ><select :id="`mcp-rule-${index}-action`" v-model="rule.action" class="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-xs">
              <option v-for="action in actions" :key="action" :value="action">{{ t(`settings.mcpResultAction_${action}`) }}</option>
            </select>
          </div>
          <Button type="button" variant="ghost" size="icon" :title="t('settings.mcpResultRemoveRule')" :aria-label="t('settings.mcpResultRemoveRule')" @click="settings.rules.splice(index, 1)"><Trash2 class="size-4" /></Button>
        </div>
        <div v-if="rule.action === 'partial'" class="grid grid-cols-2 gap-2">
          <div class="space-y-1.5">
            <Label :for="`mcp-rule-${index}-prefix`">{{ t("settings.mcpResultKeepPrefix") }}</Label
            ><input :id="`mcp-rule-${index}-prefix`" v-model.number="rule.keepPrefix" type="number" min="0" max="32" step="1" class="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" />
          </div>
          <div class="space-y-1.5">
            <Label :for="`mcp-rule-${index}-suffix`">{{ t("settings.mcpResultKeepSuffix") }}</Label
            ><input :id="`mcp-rule-${index}-suffix`" v-model.number="rule.keepSuffix" type="number" min="0" max="32" step="1" class="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" />
          </div>
        </div>
        <details class="text-xs">
          <summary class="cursor-pointer text-muted-foreground">{{ t("settings.mcpResultMatchers") }}</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div v-for="field in ruleFields" :key="field.key" class="min-w-0 space-y-1.5">
              <Label :for="`mcp-rule-${index}-${field.key}`">{{ t(`settings.${field.label}`) }}</Label
              ><Input :id="`mcp-rule-${index}-${field.key}`" :model-value="rule[field.key] ?? ''" class="h-8 font-mono text-xs" @update:model-value="rule[field.key] = String($event) || null" />
            </div>
            <div class="space-y-1.5 sm:col-span-2">
              <Label :for="`mcp-rule-${index}-id`">{{ t("settings.mcpResultRuleId") }}</Label
              ><Input :id="`mcp-rule-${index}-id`" v-model="rule.id" class="h-8 font-mono text-xs" />
            </div>
          </div>
        </details>
      </div>
      <details class="border-t pt-4 text-xs">
        <summary class="cursor-pointer font-medium">{{ t("settings.mcpResultTest") }}</summary>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div v-for="field in sampleFields" :key="field.key" class="min-w-0 space-y-1.5" :class="field.key === 'value' ? 'sm:col-span-2' : ''">
            <Label :for="`mcp-sample-${field.key}`">{{ t(`settings.${field.label}`) }}</Label
            ><Input :id="`mcp-sample-${field.key}`" v-model="sample[field.key]" class="h-8 text-xs" />
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" class="mt-3" :disabled="busy || !sample.column" data-protection-test @click="preview"><FlaskConical class="mr-2 size-4" />{{ t("settings.mcpResultTest") }}</Button>
        <div v-if="hits" class="mt-3 overflow-x-auto" aria-live="polite">
          <p v-if="!hits.length" class="text-muted-foreground">{{ t("settings.mcpResultNoMatches") }}</p>
          <table v-else class="w-full text-left text-xs">
            <thead>
              <tr class="border-b">
                <th class="py-2 font-medium">{{ t("settings.mcpResultColumn") }}</th>
                <th class="py-2 font-medium">{{ t("settings.mcpResultRuleId") }}</th>
                <th class="py-2 font-medium">{{ t("settings.mcpResultAction") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="hit in hits" :key="`${hit.ruleId}:${hit.column}`" class="border-b">
                <td class="break-all py-2 pr-2">{{ hit.column }}</td>
                <td class="break-all py-2 pr-2">{{ hit.ruleId }}</td>
                <td class="py-2">{{ t(`settings.mcpResultAction_${hit.action}`) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </fieldset>
  </section>
</template>
