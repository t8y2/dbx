<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { McpAccessLevelV2, McpAccessPolicy, McpAccessRule, McpSubScopeMode } from "@/types/mcpCatalog";

/**
 * Sub-scope rules for one plugin connection (e.g. Kubernetes namespaces),
 * declared by the plugin's `mcp.scope`. These rules live only in the v2
 * policy, so edits save immediately through `save` instead of the settings
 * dialog's staged v1 draft (same as plugin authorizations).
 */
const props = withDefaults(
  defineProps<{
    connectionId: string;
    pluginId?: string;
    kind: string;
    title: string;
    policy: McpAccessPolicy | null;
    disabled?: boolean;
    save: (connectionId: string, kind: string, value: string | null, rule: McpAccessRule | null, subScope: McpSubScopeMode | null) => Promise<McpAccessPolicy>;
    listValues?: (pluginId: string, connectionId: string) => Promise<{ values: string[] }>;
  }>(),
  { disabled: false, pluginId: "", listValues: undefined },
);

const emit = defineEmits<{ saved: [policy: McpAccessPolicy] }>();

const { t } = useI18n();
const newValue = ref("");
const saving = ref(false);
const error = ref("");
const listedValues = ref<string[]>([]);
const loadingValues = ref(false);
const mutationBlocked = computed(() => props.disabled || saving.value || !props.policy);

const mode = computed<McpSubScopeMode>(() => props.policy?.rules.find((rule) => rule.target.kind === "connection" && rule.target.id === props.connectionId)?.subScope ?? "all");

const values = computed(() =>
  (props.policy?.rules ?? [])
    .filter((rule) => rule.target.kind === "scope" && rule.target.connectionId === props.connectionId && rule.target.scope === props.kind)
    .map((rule) => ({ value: rule.target.kind === "scope" ? rule.target.value : "", visible: rule.visible === true, access: rule.access ?? "inherit" }))
    .sort((left, right) => left.value.localeCompare(right.value)),
);

async function run(value: string | null, rule: McpAccessRule | null, subScope: McpSubScopeMode | null): Promise<boolean> {
  if (mutationBlocked.value) return false;
  saving.value = true;
  error.value = "";
  try {
    emit("saved", await props.save(props.connectionId, props.kind, value, rule, subScope));
    return true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    return false;
  } finally {
    saving.value = false;
  }
}

function setMode(next: McpSubScopeMode) {
  if (next !== mode.value) void run(null, null, next);
}

function savedRule(value: string): McpAccessRule | undefined {
  const entry = props.policy?.rules.find((rule) => rule.target.kind === "scope" && rule.target.connectionId === props.connectionId && rule.target.scope === props.kind && rule.target.value === value);
  if (!entry) return undefined;
  const { target: _target, ...rule } = entry;
  return rule;
}

const canAdd = computed(() => !mutationBlocked.value && !!newValue.value.trim() && !savedRule(newValue.value.trim()));

async function addValue() {
  if (!canAdd.value) return;
  const value = newValue.value.trim();
  if (await run(value, { visible: true }, mode.value === "all" ? "selected" : null)) {
    if (newValue.value.trim() === value) newValue.value = "";
  }
}

function setAccess(value: string, access: string) {
  const rule: McpAccessRule = { ...savedRule(value) };
  if (access === "inherit") delete rule.access;
  else rule.access = access as McpAccessLevelV2;
  void run(value, rule, null);
}

function removeValue(value: string) {
  void run(value, null, null);
}

async function loadValues() {
  if (!props.listValues) return;
  loadingValues.value = true;
  error.value = "";
  try {
    listedValues.value = [...new Set((await props.listValues(props.pluginId, props.connectionId)).values)].sort();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loadingValues.value = false;
  }
}

function isSelected(value: string) {
  return values.value.some((entry) => entry.value === value && entry.visible);
}

function toggleListedValue(value: string) {
  if (isSelected(value)) removeValue(value);
  else void run(value, { ...savedRule(value), visible: true }, mode.value === "all" ? "selected" : null);
}

const LEVELS: Array<{ value: McpAccessLevelV2 | "inherit"; key: string }> = [
  { value: "inherit", key: "settings.mcpAccessTreeInherit" },
  { value: "read", key: "settings.mcpExecutionModeReadOnly" },
  { value: "write", key: "settings.mcpExecutionModeSafeWrite" },
  { value: "full", key: "settings.mcpExecutionModeHighRiskWrite" },
];

function accessLabel(access: string): string {
  const level = LEVELS.find((entry) => entry.value === access);
  return level ? t(level.key) : access;
}
</script>

<template>
  <div class="space-y-1.5" :data-mcp-plugin-scope="connectionId">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <span>{{ title }}</span>
      <Select :model-value="mode" :disabled="mutationBlocked" @update:model-value="(value) => setMode(value as McpSubScopeMode)">
        <SelectTrigger size="sm" class="h-6 text-[11px]" :data-mcp-plugin-scope-mode="connectionId">
          <SelectValue>{{ t(mode === "all" ? "settings.mcpPluginScopeAll" : mode === "none" ? "settings.mcpPluginScopeNone" : "settings.mcpPluginScopeSelected", { title, count: values.length }) }}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{{ t("settings.mcpPluginScopeAll", { title }) }}</SelectItem>
          <SelectItem value="selected">{{ t("settings.mcpPluginScopeSelected", { count: values.length }) }}</SelectItem>
          <SelectItem value="none">{{ t("settings.mcpPluginScopeNone", { title }) }}</SelectItem>
        </SelectContent>
      </Select>
      <Loader2 v-if="saving" class="size-3 animate-spin" />
    </div>
    <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t("settings.mcpBrowser.pluginImmediate") }}</p>
    <div v-if="mode !== 'none'" class="flex flex-wrap items-center gap-1.5">
      <span v-for="entry in values" :key="entry.value" class="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px]" :data-mcp-plugin-scope-value="entry.value">
        <span class="font-mono">{{ entry.value }}</span>
        <Select :model-value="entry.access" :disabled="mutationBlocked" @update:model-value="(value) => setAccess(entry.value, String(value))">
          <SelectTrigger size="sm" class="h-5 border-0 px-1 text-[10px]">
            <SelectValue>{{ accessLabel(entry.access) }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="level in LEVELS" :key="level.value" :value="level.value">{{ t(level.key) }}</SelectItem>
          </SelectContent>
        </Select>
        <button type="button" class="text-muted-foreground hover:text-destructive" :disabled="mutationBlocked" :aria-label="t('settings.mcpToolCustomRemove')" @click="removeValue(entry.value)"><X class="size-3" /></button>
      </span>
      <span class="inline-flex items-center gap-1">
        <Input v-model="newValue" class="h-6 w-36 font-mono text-[11px]" :placeholder="t('settings.mcpPluginScopeAdd', { title })" :disabled="mutationBlocked" @keydown.enter.prevent="addValue" />
        <Button variant="ghost" size="sm" class="h-6 px-1.5" :disabled="!canAdd" :data-mcp-plugin-scope-add="connectionId" @click="addValue"><Plus class="size-3" /></Button>
      </span>
    </div>
    <div v-if="listValues && pluginId" class="space-y-1.5">
      <Button variant="outline" size="sm" class="h-6 text-[11px]" :disabled="disabled || saving || loadingValues" data-mcp-plugin-scope-list @click="loadValues"> <Loader2 v-if="loadingValues" class="mr-1 size-3 animate-spin" />{{ t("settings.mcpPluginScopeLoad") }} </Button>
      <div v-if="listedValues.length" class="grid max-h-36 gap-1 overflow-y-auto rounded border p-1.5 sm:grid-cols-2">
        <label v-for="value in listedValues" :key="value" class="flex items-center gap-1.5 text-[11px]"><input type="checkbox" :checked="isSelected(value)" :disabled="mutationBlocked" @change="toggleListedValue(value)" />{{ value }}</label>
      </div>
    </div>
    <p v-if="error" class="text-[11px] text-red-600 dark:text-red-400">{{ error }}</p>
  </div>
</template>
