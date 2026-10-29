<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, Database, Folder, History, Search, Server } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { McpConnectionPolicy, McpGlobalPolicy } from "@/lib/backend/tauri";
import { buildMcpAccessTreeRows, countMcpTreeExceptions, type McpTreeConnectionRow, type McpTreeLevel, type McpTreeRow, type McpTreeSetting } from "@/lib/mcp/mcpAccessTree";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";
import type { McpAccessPolicy, McpAccessRule, McpSubScopeMode } from "@/types/mcpCatalog";
import McpPluginScopeEditor from "@/components/settings/McpPluginScopeEditor.vue";
import McpDatabaseAccessDialog from "./McpDatabaseAccessDialog.vue";
import { databaseConnectionRow, editableDatabaseAccess, type McpDatabaseAccess, type McpDatabaseAccessPolicy } from "@/lib/mcp/mcpDatabaseAccess";
import { openMcpCallHistory } from "@/lib/mcp/mcpCallHistory";

/**
 * Access-control tree: one table over groups, connections and databases that
 * replaces the four-step wizard's scope / database / permission steps. Each row
 * edits its own setting; the effective level and its source are always shown.
 * All edits are emitted to the settings dialog, which stages them in the MCP
 * policy draft (the existing v1 policy fields).
 */
const props = withDefaults(
  defineProps<{
    policy: Pick<McpGlobalPolicy, "readOnly" | "allowDangerousSql" | "allowedConnectionIds" | "allowedGroupIds" | "connectionPolicies" | "groupPolicies">;
    layout: SidebarLayout;
    connections: readonly ConnectionConfig[];
    disabled?: boolean;
    /** Loads the databases of one connection (session cache lives here). */
    loadDatabases?: (connection: ConnectionConfig) => Promise<string[]>;
    /** Declared plugin sub-scope (`mcp.scope`) by plugin id. */
    pluginScopes?: Record<string, { kind: string; title: string }>;
    savedPolicy?: McpDatabaseAccessPolicy;
    saveDatabaseAccess?: (connectionId: string) => Promise<void>;
    accessPolicy?: McpAccessPolicy | null;
    savePluginScope?: (connectionId: string, kind: string, value: string | null, rule: McpAccessRule | null, subScope: McpSubScopeMode | null) => Promise<McpAccessPolicy>;
    listPluginScopes?: (pluginId: string, connectionId: string) => Promise<{ values: string[] }>;
  }>(),
  { disabled: false, loadDatabases: undefined, pluginScopes: () => ({}), accessPolicy: null, savePluginScope: undefined, listPluginScopes: undefined },
);

const emit = defineEmits<{
  "set:scope-mode": [mode: "all" | "custom"];
  "set:group-visible": [groupId: string, visible: boolean];
  "set:connection-visible": [connectionId: string, visible: boolean];
  "set:group-level": [groupId: string, setting: McpTreeSetting];
  "set:connection-level": [connectionId: string, setting: McpTreeSetting];
  "set:database-access": [connectionId: string, value: McpDatabaseAccess];
  "set:database-scope": [connectionId: string, scope: McpConnectionPolicy["databaseScope"]];
  "set:database-allowed": [connectionId: string, database: string, allowed: boolean];
  "set:database-level": [connectionId: string, database: string, setting: McpTreeSetting];
  "set:salesforce-dml": [connectionId: string, allowed: boolean];
  "plugin-scope-saved": [policy: McpAccessPolicy];
}>();

// Built-in product providers with a sub-scope the server enforces per call.
// Consul's datacenter is the connection's own setting, so it has none here.
const PRODUCT_SCOPES: Partial<Record<string, { kind: string; titleKey: string }>> = {
  nacos: { kind: "namespace", titleKey: "settings.mcpAccessTreeNacosNamespace" },
};

function pluginScopeFor(row: Pick<McpTreeConnectionRow, "connection">): { kind: string; title: string } | null {
  const product = PRODUCT_SCOPES[row.connection.db_type];
  if (product) return { kind: product.kind, title: t(product.titleKey) };
  const pluginId = row.connection.plugin_id;
  return pluginId ? (props.pluginScopes[pluginId] ?? null) : null;
}

/** Database scope only applies to connections whose MCP tools take a database. */
function showsDatabaseScope(row: McpTreeConnectionRow): boolean {
  return !PRODUCT_SCOPES[row.connection.db_type] && row.connection.db_type !== "consul" && !row.connection.plugin_id;
}

const { t } = useI18n();
const query = ref("");
const exceptionsOnly = ref(false);
const expandedGroupIds = ref(new Set<string>());
const expandedConnectionIds = ref(new Set<string>());
const pickerConnectionId = ref<string | null>(null);
let pickerTrigger: HTMLElement | null = null;
const pickerRow = computed(() => (pickerConnectionId.value ? databaseConnectionRow(props.policy, pickerConnectionId.value, props.layout, props.connections) : undefined));
const pickerSavedRow = computed(() => (pickerConnectionId.value ? databaseConnectionRow(props.savedPolicy ?? props.policy, pickerConnectionId.value, props.layout, props.connections) : undefined));
const pickerValue = computed(() => editableDatabaseAccess(props.policy, pickerConnectionId.value ?? "", props.layout, props.connections));
const pickerSavedValue = computed(() => editableDatabaseAccess(props.savedPolicy ?? props.policy, pickerConnectionId.value ?? "", props.layout, props.connections));

// v2-only scopes are persisted separately from the staged SQL policy. Keep
// them visible in the exceptions filter even under collapsed ancestors.
const scopeExceptionIds = computed(
  () =>
    new Set(
      props.connections
        .filter((connection) => {
          const scope = pluginScopeFor({ connection });
          return (
            scope &&
            props.accessPolicy?.rules.some((rule) => (rule.target.kind === "connection" && rule.target.id === connection.id && rule.subScope !== undefined && rule.subScope !== "all") || (rule.target.kind === "scope" && rule.target.connectionId === connection.id && rule.target.scope === scope.kind))
          );
        })
        .map((connection) => connection.id),
    ),
);

const customScope = computed(() => props.policy.allowedConnectionIds !== null);
const rows = computed(() =>
  buildMcpAccessTreeRows(props.policy, props.layout, props.connections, {
    expandedGroupIds: expandedGroupIds.value,
    expandedConnectionIds: expandedConnectionIds.value,
    query: query.value,
    exceptionsOnly: exceptionsOnly.value,
    scopeExceptionIds: scopeExceptionIds.value,
  }),
);
const exceptionCounts = computed(() => countMcpTreeExceptions(props.policy, scopeExceptionIds.value));
const visibleConnectionCount = computed(() => {
  const all = buildMcpAccessTreeRows(props.policy, props.layout, props.connections, { expandedGroupIds: new Set(props.layout.groups.map((group) => group.id)), expandedConnectionIds: new Set() });
  return all.filter((row) => row.type === "connection" && row.visible).length;
});

const LEVELS: McpTreeLevel[] = ["read_only", "safe_write", "high_risk_write"];

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function levelLabel(level: McpTreeLevel): string {
  return t(level === "read_only" ? "settings.mcpExecutionModeReadOnly" : level === "safe_write" ? "settings.mcpExecutionModeSafeWrite" : "settings.mcpExecutionModeHighRiskWrite");
}

function sourceLabel(row: McpTreeRow): string {
  switch (row.source.kind) {
    case "global":
      return t("settings.mcpAccessTreeSourceGlobal");
    case "group":
      return t("settings.mcpAccessTreeSourceGroup", { group: row.source.groupName });
    case "connection":
      return t("settings.mcpAccessTreeSourceConnection");
    case "database":
      return t("settings.mcpAccessTreeSourceDatabase");
  }
}

const levelClass: Record<McpTreeLevel, string> = {
  read_only: "text-foreground",
  safe_write: "text-amber-700 dark:text-amber-300",
  high_risk_write: "text-red-600 dark:text-red-400",
};

function onSettingChange(row: McpTreeRow, value: string) {
  const setting = value as McpTreeSetting;
  // The settings owner confirms once before changing its draft.
  if (row.type === "group") emit("set:group-level", row.id, setting);
  else if (row.type === "connection") emit("set:connection-level", row.id, setting);
  else emit("set:database-level", row.connectionId, row.database, setting);
}

function onVisibleChange(row: McpTreeRow, visible: boolean) {
  if (row.type === "group") emit("set:group-visible", row.id, visible);
  else if (row.type === "connection") emit("set:connection-visible", row.id, visible);
}

function visibilityLocked(row: McpTreeRow): boolean {
  return !customScope.value || row.type === "database" || row.coveredBy !== null;
}

function visibilityChecked(row: McpTreeRow): boolean {
  if (!customScope.value) return true;
  return row.type === "database" ? row.visible : row.selected || row.coveredBy !== null;
}

function visibilityIndeterminate(row: McpTreeRow): boolean {
  return row.type === "group" && !row.visible && row.visibleConnectionCount > 0;
}

function hasVisibleResources(row: McpTreeRow): boolean {
  return row.visible || visibilityIndeterminate(row);
}

function groupVisibilityLabel(row: McpTreeRow): string {
  if (row.type !== "group") return "";
  return t(row.visibleConnectionCount === row.connectionCount ? "settings.mcpAccessTreeGroupCurrentVisible" : "settings.mcpAccessTreeGroupPartiallyVisible", { visible: row.visibleConnectionCount, total: row.connectionCount });
}

function openDatabasePicker(row: McpTreeConnectionRow, event: MouseEvent) {
  pickerTrigger = event.currentTarget as HTMLElement;
  pickerConnectionId.value = row.id;
}
function restorePickerFocus() {
  if (pickerTrigger?.isConnected) pickerTrigger.focus();
}

function openResourceHistory(row: McpTreeRow) {
  if (row.type === "group") return;
  openMcpCallHistory({ connectionId: row.type === "connection" ? row.id : row.connectionId, database: row.type === "database" ? row.database : undefined });
}
</script>

<template>
  <section class="space-y-3" data-mcp-access-tree>
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold">{{ t("settings.mcpAccessTreeTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("settings.mcpAccessTreeDescription") }}</p>
        <p class="mt-1 text-[11px] text-muted-foreground" data-mcp-access-tree-summary>
          {{ t("settings.mcpAccessTreeSummary", { visible: visibleConnectionCount, total: connections.length, groups: exceptionCounts.groups, connections: exceptionCounts.connections, databases: exceptionCounts.databases }) }}
        </p>
      </div>
      <div class="flex rounded-md border p-0.5 text-xs" role="radiogroup" :aria-label="t('settings.mcpAccessTreeScopeLabel')">
        <button
          v-for="mode in ['all', 'custom'] as const"
          :key="mode"
          type="button"
          role="radio"
          class="rounded px-2.5 py-1"
          :class="(mode === 'custom') === customScope ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'"
          :aria-checked="(mode === 'custom') === customScope"
          :disabled="disabled"
          :data-mcp-access-scope-mode="mode"
          @click="emit('set:scope-mode', mode)"
        >
          {{ t(mode === "all" ? "settings.mcpAccessTreeScopeAll" : "settings.mcpAccessTreeScopeCustom") }}
        </button>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-48 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" class="h-8 pl-8 text-xs" :placeholder="t('settings.mcpAccessTreeSearchPlaceholder')" />
      </div>
      <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input v-model="exceptionsOnly" type="checkbox" data-mcp-access-exceptions-only />
        {{ t("settings.mcpAccessTreeExceptionsOnly") }}
      </label>
    </div>

    <div class="overflow-x-auto rounded-md border">
      <table class="w-full min-w-[46rem] table-fixed text-xs">
        <thead class="bg-muted/50 text-muted-foreground">
          <tr>
            <th class="w-[42%] px-3 py-2 text-left font-medium">{{ t("settings.mcpAccessTreeColumnResource") }}</th>
            <th class="w-[10%] px-2 py-2 text-center font-medium">{{ t("settings.mcpAccessTreeColumnVisible") }}</th>
            <th class="w-[20%] px-2 py-2 text-left font-medium">{{ t("settings.mcpAccessTreeColumnSetting") }}</th>
            <th class="w-[28%] px-2 py-2 text-left font-medium">{{ t("settings.mcpAccessTreeColumnEffective") }}</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="row in rows" :key="row.key">
            <tr :class="hasVisibleResources(row) ? '' : 'text-muted-foreground'" :data-mcp-access-row="row.key">
              <td class="px-3 py-1.5">
                <div class="flex min-w-0 items-center gap-1.5" :style="{ paddingLeft: `${row.depth * 16}px` }">
                  <button
                    v-if="row.type === 'group' || (row.type === 'connection' && row.databaseCount > 0)"
                    type="button"
                    class="shrink-0 text-muted-foreground hover:text-foreground"
                    :aria-expanded="row.type === 'group' ? expandedGroupIds.has(row.id) : expandedConnectionIds.has(row.id)"
                    :data-mcp-access-toggle="row.key"
                    @click="row.type === 'group' ? (expandedGroupIds = toggle(expandedGroupIds, row.id)) : (expandedConnectionIds = toggle(expandedConnectionIds, row.id))"
                  >
                    <ChevronDown v-if="row.type === 'group' ? expandedGroupIds.has(row.id) : expandedConnectionIds.has(row.id)" class="size-3.5" />
                    <ChevronRight v-else class="size-3.5" />
                  </button>
                  <span v-else class="w-3.5 shrink-0" />
                  <Folder v-if="row.type === 'group'" class="size-3.5 shrink-0 text-muted-foreground" />
                  <Server v-else-if="row.type === 'connection'" class="size-3.5 shrink-0 text-muted-foreground" />
                  <Database v-else class="size-3.5 shrink-0 text-muted-foreground" />
                  <button
                    v-if="row.type === 'group' && row.childCount > 0"
                    type="button"
                    class="min-w-0 truncate rounded text-left font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :aria-expanded="expandedGroupIds.has(row.id)"
                    :data-mcp-access-group-name="row.id"
                    @click="expandedGroupIds = toggle(expandedGroupIds, row.id)"
                  >
                    {{ row.name }}
                  </button>
                  <span v-else class="min-w-0 truncate" :class="row.type === 'database' ? 'font-mono' : 'font-medium'">
                    {{ row.type === "group" ? row.name : row.type === "connection" ? row.connection.name : row.database }}
                  </span>
                  <span v-if="row.type === 'group'" class="shrink-0 text-[11px] text-muted-foreground">{{ t("settings.mcpAccessTreeGroupCount", { count: row.connectionCount }) }}</span>
                  <span v-if="row.type === 'connection'" class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ row.connection.db_type }}</span>
                  <span v-if="row.type === 'connection' && row.legacy" class="shrink-0 rounded border px-1 text-[10px] text-muted-foreground" :title="t('settings.mcpAccessTreeLegacyHint')">{{ t("settings.mcpAccessTreeLegacy") }}</span>
                  <Button v-if="row.type === 'connection' || row.type === 'database'" variant="ghost" size="icon" class="ml-auto size-6 shrink-0" :title="t('history.title')" :aria-label="t('history.title')" :data-mcp-access-history="row.key" @click.stop="openResourceHistory(row)">
                    <History class="size-3.5" />
                  </Button>
                </div>
              </td>
              <td class="px-2 py-1.5 text-center">
                <input
                  v-if="row.type !== 'database'"
                  type="checkbox"
                  :checked="visibilityChecked(row)"
                  :indeterminate="visibilityIndeterminate(row)"
                  :aria-checked="visibilityIndeterminate(row) ? 'mixed' : visibilityChecked(row)"
                  :disabled="disabled || visibilityLocked(row)"
                  :title="visibilityIndeterminate(row) ? t('settings.mcpAccessTreeGroupChildrenOnlyHint') : row.coveredBy ? t('settings.mcpAccessTreeCoveredByGroup') : undefined"
                  :aria-description="visibilityIndeterminate(row) ? `${groupVisibilityLabel(row)}. ${t('settings.mcpAccessTreeGroupChildrenOnlyHint')}` : undefined"
                  :aria-label="t('settings.mcpAccessTreeColumnVisible')"
                  :data-mcp-access-visible="row.key"
                  @change="onVisibleChange(row, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="px-2 py-1.5">
                <span v-if="row.type === 'database'">{{ row.setting === "inherit" ? t("settings.mcpAccessTreeInherit") : levelLabel(row.setting) }}</span>
                <Select v-else :model-value="row.setting" :disabled="disabled || !hasVisibleResources(row)" @update:model-value="(value) => onSettingChange(row, String(value))">
                  <SelectTrigger size="sm" class="h-7 w-full text-xs" :aria-label="t('settings.mcpAccessTreeColumnSetting')" :title="row.type === 'group' ? t('settings.mcpAccessTreeGroupDefaultHint') : undefined" :data-mcp-access-setting="row.key">
                    <SelectValue>{{ row.setting === "inherit" ? t("settings.mcpAccessTreeInherit") : levelLabel(row.setting) }}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ t("settings.mcpAccessTreeInherit") }}</SelectItem>
                    <SelectItem v-for="level in LEVELS" :key="level" :value="level">{{ levelLabel(level) }}</SelectItem>
                  </SelectContent>
                </Select>
              </td>
              <td class="px-2 py-1.5" :data-mcp-access-effective="row.key">
                <span v-if="visibilityIndeterminate(row)" class="font-medium">{{ groupVisibilityLabel(row) }}</span>
                <span v-else-if="!row.visible" class="text-muted-foreground">{{ t("settings.mcpAccessTreeHidden") }}</span>
                <span v-else class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span class="font-medium" :class="levelClass[row.effective]">{{ levelLabel(row.effective) }}</span>
                  <span class="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{{ sourceLabel(row) }}</span>
                </span>
              </td>
            </tr>
            <!-- Connection extras: database scope and Salesforce writes. -->
            <tr v-if="row.type === 'connection' && row.visible" class="bg-muted/20" :data-mcp-access-connection-extras="row.id">
              <td colspan="4" class="px-3 py-1">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" :style="{ paddingLeft: `${row.depth * 16 + 22}px` }">
                  <template v-if="showsDatabaseScope(row)">
                    <span>{{ t("settings.mcpAccessTreeDatabases") }}</span>
                    <span :data-mcp-access-database-scope="row.id">{{
                      t(row.databaseScope === "all" ? "settings.mcpAccessTreeDatabaseScopeAll" : row.databaseScope === "none" ? "settings.mcpAccessTreeDatabaseScopeNone" : "settings.mcpAccessTreeDatabaseScopeSelected", { count: row.databaseCount })
                    }}</span>
                    <span v-if="policy.connectionPolicies.find((entry) => entry.connectionId === row.id)?.databasePolicies.length">{{ t("settings.mcpDatabaseOverrideCount", { count: policy.connectionPolicies.find((entry) => entry.connectionId === row.id)?.databasePolicies.length }) }}</span>
                    <Button variant="outline" size="sm" class="h-7 text-xs" :disabled="disabled" :data-mcp-access-pick-databases="row.id" @click="openDatabasePicker(row, $event)">{{ t("settings.mcpDatabaseConfigure") }}</Button>
                  </template>
                  <label v-if="row.connection.db_type === 'salesforce'" class="flex items-center gap-1">
                    <input type="checkbox" :checked="row.salesforceDml" :disabled="disabled || row.effective === 'read_only'" :data-mcp-access-salesforce="row.id" @change="emit('set:salesforce-dml', row.id, ($event.target as HTMLInputElement).checked)" />
                    {{ t("settings.mcpConnectionPolicyAllowSalesforceDml") }}
                  </label>
                </div>
                <div v-if="pluginScopeFor(row) && savePluginScope" class="mt-1" :style="{ paddingLeft: `${row.depth * 16 + 22}px` }">
                  <McpPluginScopeEditor
                    :connection-id="row.id"
                    :plugin-id="row.connection.plugin_id ?? ''"
                    :kind="pluginScopeFor(row)!.kind"
                    :title="pluginScopeFor(row)!.title"
                    :policy="accessPolicy"
                    :disabled="disabled"
                    :save="savePluginScope"
                    :list-values="row.connection.plugin_id ? listPluginScopes : undefined"
                    @saved="emit('plugin-scope-saved', $event)"
                  />
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="px-3 py-6 text-center text-muted-foreground">{{ t(query || exceptionsOnly ? "settings.mcpAccessTreeNoMatch" : "settings.mcpAccessTreeEmpty") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t("settings.mcpAccessTreeFootnote") }}</p>
    <McpDatabaseAccessDialog
      v-if="pickerRow"
      :open="pickerConnectionId !== null"
      :connection="pickerRow.connection"
      :value="pickerValue"
      :saved-value="pickerSavedValue"
      :inherited-label="`${levelLabel(pickerRow.effective)} · ${sourceLabel(pickerRow)}`"
      :saved-inherited-label="pickerSavedRow ? `${levelLabel(pickerSavedRow.effective)} · ${sourceLabel(pickerSavedRow)}` : ''"
      :saved-visible="pickerSavedRow?.visible ?? false"
      :disabled="disabled"
      :load-databases="loadDatabases"
      :save="saveDatabaseAccess"
      @change="emit('set:database-access', pickerRow.id, $event)"
      @update:open="!$event && (pickerConnectionId = null)"
      @return-focus="restorePickerFocus"
    />
  </section>
</template>
