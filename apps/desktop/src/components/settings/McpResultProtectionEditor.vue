<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Database, FlaskConical, Folder, Globe, Loader2, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/backend/api";
import {
  cloneResultProtectionScope,
  createResultProtectionRule,
  effectiveResultProtection,
  localResultProtectionSettings,
  prepareResultProtectionPolicy,
  removeResultProtectionScope,
  resultProtectionScopeKey,
  resultProtectionTemplate,
  type McpResultProtectionPolicy,
  type ResultProtectionAction,
  type ResultProtectionPreviewResult,
  type ResultProtectionScope,
} from "@/lib/mcp/mcpResultProtection";
import { buildResultProtectionResources, supportsResultProtectionDatabaseScope, type ResultProtectionConnection, type ResultProtectionResource, type ResultProtectionResourceInput } from "@/lib/mcp/mcpResultProtectionResources";
import type { SidebarLayout } from "@/types/database";

const props = defineProps<{
  policy: McpResultProtectionPolicy;
  connections: readonly ResultProtectionConnection[];
  layout: SidebarLayout;
  allowedConnectionIds: readonly string[] | null;
  allowedGroupIds: readonly string[];
  connectionPolicies: ResultProtectionResourceInput["connectionPolicies"];
  disabled: boolean;
  savePolicy: (policy: McpResultProtectionPolicy) => Promise<void>;
}>();
const { t } = useI18n();
const clone = (policy: McpResultProtectionPolicy): McpResultProtectionPolicy => ({ ...JSON.parse(JSON.stringify(policy)), groupOverrides: JSON.parse(JSON.stringify(policy.groupOverrides ?? [])) });
const draft = ref(clone(props.policy));
const selectedKey = ref(resultProtectionScopeKey({ kind: "global" }));
const search = ref("");
const saving = ref(false);
const testing = ref(false);
const error = ref("");
const databases = ref<Record<string, string[]>>({});
const loadingDatabases = ref(new Set<string>());
const databaseErrors = ref(new Set<string>());
const sample = ref({ column: "phone", dataType: "varchar", value: "13800001234", schema: "", table: "" });
const sampleFormat = ref<"text" | "json">("text");
const previewResult = ref<{ result: ResultProtectionPreviewResult; before: unknown } | null>(null);
let previewRevision = 0;
let previewHashKey: string | null = null;
let disposed = false;
const busy = computed(() => props.disabled || saving.value);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(clone(props.policy)));
const resources = computed(() => buildResultProtectionResources({ ...props, policy: draft.value, databases: databases.value }));
const selected = computed(() => resources.value.find((resource) => resource.key === selectedKey.value) ?? resources.value[0]);
const visibleResources = computed(() => resources.value.filter((resource) => resource.scope.kind === "global" || resource.pathNames.join(" / ").toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())));
const localSettings = computed(() => localResultProtectionSettings(draft.value, selected.value.scope));
const effective = computed(() => effectiveFor(selected.value));
const settings = computed(() => localSettings.value ?? effective.value.settings);
const state = computed(() => (!localSettings.value ? "inherit" : localSettings.value.enabled ? "enabled" : "disabled"));
const canCustomize = computed(() => selected.value.active || Boolean(localSettings.value));
const selectedConnection = computed(() => {
  const scope = selected.value.scope;
  return "connectionId" in scope ? props.connections.find((connection) => connection.id === scope.connectionId) : undefined;
});
const databasePermission = computed(() => props.connectionPolicies.find((permission) => permission.connectionId === selectedConnection.value?.id));
const canLoadDatabases = computed(() => selectedConnection.value && selected.value.active && supportsResultProtectionDatabaseScope(selectedConnection.value) && databasePermission.value?.databaseScope !== "none");
const enabledExceptions = computed(
  () =>
    resources.value.filter((resource) => {
      if (!resource.active || resource.key === selected.value.key || !localResultProtectionSettings(draft.value, resource.scope)?.enabled) return false;
      const scope = selected.value.scope;
      if (scope.kind === "global") return true;
      if (scope.kind === "group") return resource.groupIds.includes(scope.groupId);
      return scope.kind === "connection" && resource.scope.kind === "database" && resource.scope.connectionId === scope.connectionId;
    }).length,
);
const invalidEnabledScope = computed(() => [draft.value.default, ...(draft.value.groupOverrides ?? []).map((override) => override.settings), ...draft.value.overrides.map((override) => override.settings)].some((scope) => scope.enabled && !scope.rules.length));
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
] as const;
const previewStatusKeys = { disabled: "mcpResultPreviewStatusDisabled", unchanged: "mcpResultPreviewStatusUnchanged", protected: "mcpResultPreviewStatusProtected", removed: "mcpResultPreviewStatusRemoved", denied: "mcpResultPreviewStatusDenied" } as const;

function contextFor(resource: ResultProtectionResource) {
  return { connectionId: "connectionId" in resource.scope ? resource.scope.connectionId : "", database: resource.scope.kind === "database" ? resource.scope.database : "", groupIds: resource.groupIds };
}
function effectiveFor(resource: ResultProtectionResource) {
  return effectiveResultProtection(draft.value, contextFor(resource));
}
function resourceLabel(resource: ResultProtectionResource): string {
  return resource.scope.kind === "global" ? t("settings.mcpResultGlobal") : resource.pathNames.join(" / ");
}
function sourceLabel(scope: ResultProtectionScope): string {
  const resource = resources.value.find((item) => item.key === resultProtectionScopeKey(scope));
  return resource ? resourceLabel(resource) : scope.kind === "global" ? t("settings.mcpResultGlobal") : scope.kind === "group" ? scope.groupId : scope.kind === "connection" ? scope.connectionId : `${scope.connectionId} / ${scope.database}`;
}
function invalidatePreview() {
  previewRevision += 1;
  previewResult.value = null;
  testing.value = false;
  error.value = "";
}
watch(
  () => props.policy,
  (policy) => {
    if (saving.value) return;
    draft.value = clone(policy);
    previewHashKey = null;
  },
  { deep: true },
);
watch([draft, selectedKey, sample, sampleFormat, () => props.layout, () => props.allowedConnectionIds, () => props.allowedGroupIds, () => props.connectionPolicies], invalidatePreview, { deep: true, flush: "sync" });
watch(resources, (rows) => {
  if (!rows.some((resource) => resource.key === selectedKey.value)) selectedKey.value = rows[0].key;
});
watch(
  () => selectedConnection.value?.id,
  () => {
    const connection = selectedConnection.value;
    if (connection && !databases.value[connection.id]) void loadDatabases();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  invalidatePreview();
});

async function loadDatabases() {
  const connection = selectedConnection.value;
  if (busy.value || !connection || !canLoadDatabases.value || loadingDatabases.value.has(connection.id)) return;
  loadingDatabases.value = new Set([...loadingDatabases.value, connection.id]);
  databaseErrors.value.delete(connection.id);
  try {
    const names = connection.db_type === "sqlite" ? ["main"] : (await api.listDatabases(connection.id)).map((database) => database.name);
    if (!disposed) databases.value = { ...databases.value, [connection.id]: [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
  } catch {
    if (!disposed) databaseErrors.value = new Set([...databaseErrors.value, connection.id]);
  } finally {
    loadingDatabases.value = new Set([...loadingDatabases.value].filter((id) => id !== connection.id));
  }
}
function customize() {
  if (busy.value || !canCustomize.value) return;
  cloneResultProtectionScope(draft.value, selected.value.scope, selected.value.groupIds);
  error.value = "";
}
function setState(next: string) {
  if (busy.value || (!canCustomize.value && next !== "inherit")) return;
  if (next === "inherit") {
    if (localSettings.value && !window.confirm(t("settings.mcpResultInheritConfirm"))) return;
    removeResultProtectionScope(draft.value, selected.value.scope);
  } else {
    if (next === "enabled" && !settings.value.rules.length) {
      error.value = t("settings.mcpResultEmptyEnabled");
      return;
    }
    cloneResultProtectionScope(draft.value, selected.value.scope, selected.value.groupIds).enabled = next === "enabled";
  }
  error.value = "";
}
function onStateChange(event: Event) {
  const element = event.target as HTMLSelectElement;
  setState(element.value);
  element.value = state.value;
}
function onGlobalEnabled(event: Event) {
  const element = event.target as HTMLInputElement;
  setState(element.checked ? "enabled" : "disabled");
  element.checked = settings.value.enabled;
}
function addRule() {
  if (busy.value || !localSettings.value) return;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  settings.value.rules.push(createResultProtectionRule(`rule-${id}`));
}
function addTemplate() {
  if (busy.value || !localSettings.value) return;
  const ids = new Set(settings.value.rules.map((rule) => rule.id));
  settings.value.rules.push(...resultProtectionTemplate().filter((rule) => !ids.has(rule.id)));
  error.value = "";
}
function clearRules() {
  if (busy.value || !localSettings.value || !settings.value.rules.length || !window.confirm(t("settings.mcpResultClearConfirm"))) return;
  settings.value.rules = [];
}
function preparedPolicy() {
  const policy = prepareResultProtectionPolicy({ ...draft.value, hashKey: draft.value.hashKey ?? previewHashKey });
  previewHashKey = policy.hashKey;
  return policy;
}
async function save() {
  if (busy.value || !dirty.value) return;
  if (invalidEnabledScope.value) {
    error.value = t("settings.mcpResultEmptyEnabled");
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const policy = preparedPolicy();
    await props.savePolicy(clone(policy));
    draft.value = policy;
  } catch (cause) {
    error.value = t("settings.mcpPolicySaveFailed", { error: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    saving.value = false;
  }
}
async function preview() {
  if (busy.value || testing.value) return;
  error.value = "";
  previewResult.value = null;
  let value: unknown = sample.value.value;
  if (sampleFormat.value === "json") {
    try {
      value = JSON.parse(sample.value.value);
    } catch {
      error.value = t("settings.mcpResultPreviewInvalidJson");
      return;
    }
  }
  const revision = ++previewRevision;
  testing.value = true;
  try {
    const result = await api.previewMcpResultProtection({ ...sample.value, ...contextFor(selected.value), policy: preparedPolicy(), value });
    if (revision === previewRevision && !disposed) previewResult.value = { result, before: value };
  } catch {
    if (revision === previewRevision && !disposed) error.value = t("settings.mcpResultPreviewFailed");
  } finally {
    if (revision === previewRevision) testing.value = false;
  }
}
function formatValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}
</script>

<template>
  <section class="@container min-w-0 space-y-4" data-mcp-result-protection>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">{{ t("settings.mcpResultProtectionTitle") }}</h3>
      <Button type="button" size="sm" :disabled="busy || !dirty" data-protection-save @click="save"><Save class="mr-2 size-4" />{{ t("common.save") }}</Button>
    </div>
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpResultProtectionBoundary") }}</p>
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpResultPrecedence") }}</p>
    <p v-if="error || invalidEnabledScope" role="alert" class="break-words text-xs text-destructive">{{ error || t("settings.mcpResultEmptyEnabled") }}</p>
    <div class="grid min-w-0 gap-5 @[760px]:grid-cols-[15rem_minmax(0,1fr)]">
      <aside class="min-w-0 space-y-2 @[760px]:border-r @[760px]:pr-3">
        <Label for="mcp-result-search">{{ t("settings.mcpResultResources") }}</Label>
        <div class="relative">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input id="mcp-result-search" v-model="search" class="h-8 pl-8 text-xs" :placeholder="t('settings.mcpResultSearch')" :disabled="busy" />
        </div>
        <select id="mcp-result-scope" v-model="selectedKey" class="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-xs @[760px]:hidden" :disabled="busy" :aria-label="t('settings.mcpResultScope')">
          <option v-for="resource in resources.filter((row) => visibleResources.includes(row) || row.key === selectedKey)" :key="resource.key" :value="resource.key">{{ resourceLabel(resource) }}{{ resource.active ? "" : ` (${t("settings.mcpResultInactive")})` }}</option>
        </select>
        <div class="hidden max-h-[34rem] overflow-auto @[760px]:block" role="listbox" :aria-label="t('settings.mcpResultScope')">
          <button
            v-for="resource in visibleResources"
            :key="resource.key"
            type="button"
            role="option"
            :aria-selected="resource.key === selectedKey"
            :disabled="busy"
            class="flex min-h-10 w-full min-w-0 items-start gap-2 rounded px-2 py-2 text-left text-xs hover:bg-muted/60 disabled:opacity-60"
            :class="resource.key === selectedKey ? 'bg-muted' : ''"
            :style="{ paddingLeft: `${8 + Math.min(resource.depth, 4) * 12}px` }"
            :title="resourceLabel(resource)"
            @click="selectedKey = resource.key"
          >
            <Globe v-if="resource.scope.kind === 'global'" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <Folder v-else-if="resource.scope.kind === 'group'" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <Database v-else class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 break-words"
              ><span class="block">{{ resource.scope.kind === "global" ? t("settings.mcpResultGlobal") : resource.name }}</span
              ><span class="block text-[11px] text-muted-foreground">{{
                !resource.active ? t("settings.mcpResultInactive") : !localResultProtectionSettings(draft, resource.scope) ? t("settings.mcpResultStateInherit") : effectiveFor(resource).settings.enabled ? t("settings.mcpResultStateEnabled") : t("settings.mcpResultStateDisabled")
              }}</span></span
            >
          </button>
        </div>
      </aside>
      <div class="min-w-0 space-y-4">
        <div class="min-w-0 space-y-2 border-b pb-4">
          <h4 class="break-words text-sm font-semibold">{{ resourceLabel(selected) }}</h4>
          <p v-if="!selected.active" class="text-xs text-muted-foreground">{{ t("settings.mcpResultInactive") }}</p>
          <p class="break-words text-xs text-muted-foreground" data-protection-source>{{ t("settings.mcpResultSource", { source: sourceLabel(effective.source) }) }} / {{ t(effective.settings.enabled ? "settings.mcpResultStateEnabled" : "settings.mcpResultPreviewStatusDisabled") }}</p>
          <p v-if="!effective.settings.enabled && enabledExceptions" class="text-xs text-muted-foreground" data-protection-exceptions>{{ t("settings.mcpResultEnabledExceptions", { count: enabledExceptions }) }}</p>
          <template v-if="selectedConnection">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted-foreground">
                {{
                  t(databasePermission?.databaseScope === "none" ? "settings.mcpDatabaseScopeSummaryNone" : databasePermission?.databaseScope === "selected" ? "settings.mcpDatabaseScopeSummarySelected" : "settings.mcpDatabaseScopeSummaryAll", {
                    count: databasePermission?.allowedDatabases.length ?? 0,
                  })
                }}
              </p>
              <Button
                v-if="canLoadDatabases"
                type="button"
                variant="outline"
                size="icon"
                class="size-8"
                :disabled="busy || loadingDatabases.has(selectedConnection.id)"
                :title="t('settings.mcpResultRefreshDatabases')"
                :aria-label="t('settings.mcpResultRefreshDatabases')"
                data-protection-database-refresh
                @click="loadDatabases"
                ><Loader2 v-if="loadingDatabases.has(selectedConnection.id)" class="size-3.5 animate-spin" /><RefreshCw v-else class="size-3.5"
              /></Button>
            </div>
            <p v-if="!supportsResultProtectionDatabaseScope(selectedConnection)" class="text-xs text-muted-foreground">{{ t("settings.mcpResultDatabaseUnsupported") }}</p>
            <p v-if="databaseErrors.has(selectedConnection.id)" role="alert" class="text-xs text-destructive">{{ t("settings.mcpResultDatabaseLoadFailed") }}</p>
          </template>
          <p v-if="selected.scope.kind === 'database'" class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpResultDatabaseBoundary") }}</p>
        </div>
        <fieldset :disabled="busy" class="min-w-0 space-y-4 disabled:opacity-60">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <label v-if="selected.scope.kind === 'global'" class="flex items-center gap-2 text-sm"><input :checked="settings.enabled" type="checkbox" data-protection-enabled @change="onGlobalEnabled" />{{ t("settings.mcpResultEnabled") }}</label>
            <div v-else class="min-w-0 space-y-1.5">
              <Label for="mcp-result-state">{{ t("settings.mcpResultState") }}</Label
              ><select id="mcp-result-state" :value="state" class="h-9 w-full rounded-md border bg-background px-2 text-xs" data-protection-state @change="onStateChange">
                <option value="inherit">{{ t("settings.mcpResultStateInherit") }}</option>
                <option value="enabled" :disabled="!canCustomize">{{ t("settings.mcpResultStateEnabled") }}</option>
                <option value="disabled" :disabled="!canCustomize">{{ t("settings.mcpResultStateDisabled") }}</option>
              </select>
            </div>
            <Button v-if="!localSettings && canCustomize" type="button" variant="outline" size="sm" class="h-auto min-h-9 whitespace-normal" data-protection-customize @click="customize"><Copy class="mr-2 size-4 shrink-0" />{{ t("settings.mcpResultCustomize") }}</Button>
          </div>
          <fieldset :disabled="!localSettings" class="min-w-0 space-y-4 disabled:opacity-60">
            <div class="space-y-1.5">
              <Label for="mcp-result-mode">{{ t("settings.mcpResultMode") }}</Label
              ><select id="mcp-result-mode" v-model="settings.mode" class="h-9 max-w-full rounded-md border bg-background px-2 text-xs">
                <option value="strict">{{ t("settings.mcpResultStrict") }}</option>
                <option value="nameOnly">{{ t("settings.mcpResultNameOnly") }}</option>
              </select>
            </div>
            <p class="text-xs leading-relaxed text-muted-foreground">{{ t(settings.mode === "strict" ? "settings.mcpResultStrictBoundary" : "settings.mcpResultNameOnlyBoundary") }}</p>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <Label>{{ t("settings.mcpResultRules") }}</Label>
              <div class="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" data-protection-template @click="addTemplate"><ShieldCheck class="mr-2 size-4" />{{ t("settings.mcpResultTemplate") }}</Button
                ><Button type="button" variant="outline" size="icon" :title="t('settings.mcpResultAddRule')" :aria-label="t('settings.mcpResultAddRule')" @click="addRule"><Plus class="size-4" /></Button
                ><Button type="button" variant="outline" size="icon" :disabled="!settings.rules.length" :title="t('settings.mcpResultClearRules')" :aria-label="t('settings.mcpResultClearRules')" data-protection-clear @click="clearRules"><Trash2 class="size-4" /></Button>
              </div>
            </div>
            <p v-if="!settings.rules.length" class="py-3 text-xs text-muted-foreground">{{ t("settings.mcpResultNoRules") }}</p>
            <div v-for="(rule, index) in settings.rules" :key="index" class="min-w-0 space-y-3 border-t py-3" data-protection-rule>
              <div class="grid min-w-0 items-end gap-2 @[560px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
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
                <div class="min-w-0 space-y-1.5">
                  <Label :for="`mcp-rule-${index}-prefix`">{{ t("settings.mcpResultKeepPrefix") }}</Label
                  ><input :id="`mcp-rule-${index}-prefix`" v-model.number="rule.keepPrefix" type="number" min="0" max="32" step="1" class="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" />
                </div>
                <div class="min-w-0 space-y-1.5">
                  <Label :for="`mcp-rule-${index}-suffix`">{{ t("settings.mcpResultKeepSuffix") }}</Label
                  ><input :id="`mcp-rule-${index}-suffix`" v-model.number="rule.keepSuffix" type="number" min="0" max="32" step="1" class="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" />
                </div>
              </div>
              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">{{ t("settings.mcpResultMatchers") }}</summary>
                <div class="mt-3 grid gap-3 @[560px]:grid-cols-2">
                  <div v-for="field in ruleFields" :key="field.key" class="min-w-0 space-y-1.5">
                    <Label :for="`mcp-rule-${index}-${field.key}`">{{ t(`settings.${field.label}`) }}</Label
                    ><Input :id="`mcp-rule-${index}-${field.key}`" :model-value="rule[field.key] ?? ''" class="h-8 font-mono text-xs" @update:model-value="rule[field.key] = String($event) || null" />
                  </div>
                  <div class="min-w-0 space-y-1.5 @[560px]:col-span-2">
                    <Label :for="`mcp-rule-${index}-id`">{{ t("settings.mcpResultRuleId") }}</Label
                    ><Input :id="`mcp-rule-${index}-id`" v-model="rule.id" class="h-8 font-mono text-xs" />
                  </div>
                </div>
              </details>
            </div>
          </fieldset>
          <details class="border-t pt-4 text-xs" open>
            <summary class="cursor-pointer font-medium">{{ t("settings.mcpResultTest") }}</summary>
            <div class="mt-3 grid gap-3 @[560px]:grid-cols-2">
              <div v-for="field in sampleFields" :key="field.key" class="min-w-0 space-y-1.5">
                <Label :for="`mcp-sample-${field.key}`">{{ t(`settings.${field.label}`) }}</Label
                ><Input :id="`mcp-sample-${field.key}`" v-model="sample[field.key]" class="h-8 text-xs" />
              </div>
              <div class="space-y-1.5">
                <Label for="mcp-sample-format">{{ t("settings.mcpResultPreviewFormat") }}</Label
                ><select id="mcp-sample-format" v-model="sampleFormat" class="h-8 w-full rounded-md border bg-background px-2 text-xs" data-protection-sample-format>
                  <option value="text">{{ t("settings.mcpResultPreviewText") }}</option>
                  <option value="json">{{ t("settings.mcpResultPreviewJson") }}</option>
                </select>
              </div>
              <div class="min-w-0 space-y-1.5 @[560px]:col-span-2">
                <Label for="mcp-sample-value">{{ t("settings.mcpResultSample") }}</Label
                ><textarea id="mcp-sample-value" v-model="sample.value" rows="3" class="min-h-20 w-full resize-y rounded-md border bg-background px-2 py-2 font-mono text-xs" />
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" class="mt-3" :disabled="busy || testing || !sample.column" data-protection-test @click="preview"
              ><Loader2 v-if="testing" class="mr-2 size-4 animate-spin" /><FlaskConical v-else class="mr-2 size-4" />{{ t("settings.mcpResultTest") }}</Button
            >
            <div v-if="previewResult" class="mt-4 space-y-3" aria-live="polite" data-protection-preview>
              <p class="font-medium">{{ t(`settings.${previewStatusKeys[previewResult.result.status]}`) }}</p>
              <p class="break-words text-muted-foreground">{{ t("settings.mcpResultSource", { source: sourceLabel(previewResult.result.source) }) }}</p>
              <div class="grid min-w-0 gap-3 @[560px]:grid-cols-2">
                <div class="min-w-0 space-y-1.5">
                  <Label>{{ t("settings.mcpResultPreviewBefore") }}</Label>
                  <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 font-mono text-xs" data-protection-before>{{ formatValue(previewResult.before) }}</pre>
                </div>
                <div class="min-w-0 space-y-1.5">
                  <Label>{{ t("settings.mcpResultPreviewAfter") }}</Label>
                  <p v-if="previewResult.result.status === 'removed' || previewResult.result.status === 'denied'" class="rounded border bg-muted/30 p-2 text-muted-foreground">{{ t(`settings.${previewStatusKeys[previewResult.result.status]}`) }}</p>
                  <pre v-else class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 font-mono text-xs" data-protection-after>{{ formatValue(previewResult.result.status === "protected" ? previewResult.result.value : previewResult.before) }}</pre>
                </div>
              </div>
              <p v-if="!previewResult.result.hits.length" class="text-muted-foreground">{{ t("settings.mcpResultNoMatches") }}</p>
              <div v-else class="overflow-x-auto">
                <table class="w-full text-left text-xs">
                  <thead>
                    <tr class="border-b">
                      <th class="py-2 font-medium">{{ t("settings.mcpResultColumn") }}</th>
                      <th class="py-2 font-medium">{{ t("settings.mcpResultRuleId") }}</th>
                      <th class="py-2 font-medium">{{ t("settings.mcpResultAction") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="hit in previewResult.result.hits" :key="`${hit.ruleId}:${hit.column}`" class="border-b">
                      <td class="break-all py-2 pr-2">{{ hit.column }}</td>
                      <td class="break-all py-2 pr-2">{{ hit.ruleId }}</td>
                      <td class="py-2">{{ t(`settings.mcpResultAction_${hit.action}`) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </fieldset>
      </div>
    </div>
  </section>
</template>
