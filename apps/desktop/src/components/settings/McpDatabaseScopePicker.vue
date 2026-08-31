<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { listDatabases, mongoListDatabases, redisListDatabases } from "@/lib/backend/api";
import type { McpConnectionPolicy } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

type DatabaseScope = McpConnectionPolicy["databaseScope"];

const { t } = useI18n();

const PAGE_SIZE_OPTIONS = [6, 10, 20] as const;

const props = withDefaults(
  defineProps<{
    connections: readonly ConnectionConfig[];
    allowedConnectionIds: readonly string[] | null;
    connectionPolicies: readonly McpConnectionPolicy[];
    disabled?: boolean;
    busy?: boolean;
  }>(),
  { disabled: false, busy: false },
);

const emit = defineEmits<{
  "update:connectionPolicies": [value: McpConnectionPolicy[]];
}>();

const selectedConnectionId = ref("");
const databasesByConnection = ref<Record<string, string[]>>({});
const loadingConnectionId = ref("");
const loadError = ref("");
const search = ref("");
const manualDatabase = ref("");
const pageSize = ref<number>(PAGE_SIZE_OPTIONS[0]);
const connectionPage = ref(1);
const databasePage = ref(1);

const scopedConnections = computed(() => (props.allowedConnectionIds === null ? [...props.connections] : props.connections.filter((connection) => props.allowedConnectionIds?.includes(connection.id))));
const selectedConnection = computed(() => scopedConnections.value.find((connection) => connection.id === selectedConnectionId.value));
const selectedPolicy = computed(() => props.connectionPolicies.find((policy) => policy.connectionId === selectedConnectionId.value));
const selectedScope = computed<DatabaseScope>(() => selectedPolicy.value?.databaseScope ?? "all");
const selectedDatabases = computed(() => selectedPolicy.value?.allowedDatabases ?? []);
const displayedDatabases = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return (databasesByConnection.value[selectedConnectionId.value] ?? []).filter((database) => !query || database.toLocaleLowerCase().includes(query));
});
const connectionPageCount = computed(() => Math.max(1, Math.ceil(scopedConnections.value.length / pageSize.value)));
const databasePageCount = computed(() => Math.max(1, Math.ceil(displayedDatabases.value.length / pageSize.value)));
const pagedScopedConnections = computed(() => {
  const start = (connectionPage.value - 1) * pageSize.value;
  return scopedConnections.value.slice(start, start + pageSize.value);
});
const pagedDatabases = computed(() => {
  const start = (databasePage.value - 1) * pageSize.value;
  return displayedDatabases.value.slice(start, start + pageSize.value);
});

watch(
  scopedConnections,
  (connections) => {
    if (!connections.some((connection) => connection.id === selectedConnectionId.value)) {
      selectedConnectionId.value = connections[0]?.id ?? "";
    }
  },
  { immediate: true },
);

function policyFor(connectionId: string): McpConnectionPolicy {
  return (
    props.connectionPolicies.find((policy) => policy.connectionId === connectionId) ?? {
      connectionId,
      readOnly: false,
      allowDangerousSql: false,
      executionModeConfigured: false,
      databaseScope: "all",
      allowedDatabases: [],
    }
  );
}

function updateSelectedPolicy(patch: Partial<McpConnectionPolicy>) {
  if (props.disabled || !selectedConnectionId.value) return;
  const next = { ...policyFor(selectedConnectionId.value), ...patch };
  const policies = props.connectionPolicies.filter((policy) => policy.connectionId !== selectedConnectionId.value);
  emit("update:connectionPolicies", [...policies, next]);
}

function setScope(scope: DatabaseScope) {
  updateSelectedPolicy({ databaseScope: scope, allowedDatabases: scope === "selected" ? selectedDatabases.value : [] });
}

function setConnectionPage(page: number) {
  connectionPage.value = Math.min(Math.max(1, page), connectionPageCount.value);
}

function setDatabasePage(page: number) {
  databasePage.value = Math.min(Math.max(1, page), databasePageCount.value);
}

function selectConnection(connectionId: string) {
  selectedConnectionId.value = connectionId;
  loadError.value = "";
  search.value = "";
  databasePage.value = 1;
}

function toggleDatabase(database: string, checked: boolean) {
  const databases = checked ? [...new Set([...selectedDatabases.value, database])] : selectedDatabases.value.filter((item) => item !== database);
  updateSelectedPolicy({ databaseScope: "selected", allowedDatabases: databases });
}

function addManualDatabase() {
  const database = manualDatabase.value.trim();
  if (!database) return;
  const loaded = databasesByConnection.value[selectedConnectionId.value] ?? [];
  databasesByConnection.value = {
    ...databasesByConnection.value,
    [selectedConnectionId.value]: [...new Set([...loaded, database])].sort((left, right) => left.localeCompare(right)),
  };
  toggleDatabase(database, true);
  manualDatabase.value = "";
  databasePage.value = 1;
}

async function loadConnectionDatabases() {
  const connection = selectedConnection.value;
  if (!connection || loadingConnectionId.value) return;
  loadingConnectionId.value = connection.id;
  loadError.value = "";
  try {
    const databases = connection.db_type === "mongodb" ? await mongoListDatabases(connection.id) : connection.db_type === "redis" ? (await redisListDatabases(connection.id)).map((database) => String(database.db)) : (await listDatabases(connection.id)).map((database) => database.name);
    databasesByConnection.value = {
      ...databasesByConnection.value,
      [connection.id]: [...new Set(databases.map((database) => database.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    };
  } catch (error: unknown) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingConnectionId.value = "";
  }
}

function scopeSummary(connection: ConnectionConfig): string {
  const policy = props.connectionPolicies.find((item) => item.connectionId === connection.id);
  if (!policy || policy.databaseScope === "all") return t("settings.mcpDatabaseScopeSummaryAll");
  if (policy.databaseScope === "none") return t("settings.mcpDatabaseScopeSummaryNone");
  return t("settings.mcpDatabaseScopeSummarySelected", { count: policy.allowedDatabases.length });
}

watch(search, () => {
  databasePage.value = 1;
});

watch(pageSize, () => {
  connectionPage.value = 1;
  databasePage.value = 1;
});

watch(connectionPageCount, () => setConnectionPage(connectionPage.value));
watch(databasePageCount, () => setDatabasePage(databasePage.value));
</script>

<template>
  <section class="space-y-3">
    <div>
      <p class="text-sm font-medium">{{ t("settings.mcpDatabaseScopeTitle") }}</p>
      <p class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseScopeDescription") }}</p>
    </div>

    <div v-if="!scopedConnections.length" class="rounded border border-dashed bg-background px-3 py-4 text-center text-xs text-muted-foreground">{{ t("settings.mcpDatabaseScopeEmptyHint") }}</div>
    <div v-else class="grid min-h-72 overflow-hidden rounded-md border bg-background md:grid-cols-[minmax(14rem,0.42fr)_minmax(0,1fr)]">
      <div class="border-b p-2 md:border-b-0 md:border-r">
        <div class="flex items-center justify-between gap-2 px-2 pb-2">
          <p class="text-xs font-medium text-muted-foreground">{{ t("settings.mcpDatabaseScopeAllowedConnections") }}</p>
          <label class="flex h-7 items-center gap-1 rounded border bg-background px-1.5 text-[11px] text-muted-foreground">
            {{ t("settings.mcpPerPage") }}
            <select v-model.number="pageSize" class="bg-transparent text-[11px] text-foreground outline-none" :disabled="disabled">
              <option v-for="size in PAGE_SIZE_OPTIONS" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>
        </div>
        <div class="space-y-1">
          <button v-for="connection in pagedScopedConnections" :key="connection.id" type="button" class="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted" :class="selectedConnectionId === connection.id ? 'bg-muted' : ''" @click="selectConnection(connection.id)">
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate text-sm font-medium">{{ connection.name }}</span>
              <Badge variant="outline" class="shrink-0 text-[10px] font-normal">{{ scopeSummary(connection) }}</Badge>
            </div>
            <p class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{{ connection.db_type }} · {{ connection.host || connection.database || connection.id }}</p>
          </button>
        </div>
        <div v-if="connectionPageCount > 1" class="mt-2 flex items-center justify-center gap-2 border-t pt-2 text-xs text-muted-foreground">
          <Button type="button" size="icon-sm" variant="ghost" :disabled="connectionPage === 1" :title="t('settings.mcpPreviousPage')" :aria-label="t('settings.mcpPreviousPage')" @click="setConnectionPage(connectionPage - 1)"><ChevronLeft /></Button>
          <span class="min-w-12 text-center tabular-nums">{{ connectionPage }} / {{ connectionPageCount }}</span>
          <Button type="button" size="icon-sm" variant="ghost" :disabled="connectionPage === connectionPageCount" :title="t('settings.mcpNextPage')" :aria-label="t('settings.mcpNextPage')" @click="setConnectionPage(connectionPage + 1)"><ChevronRight /></Button>
        </div>
      </div>

      <div v-if="selectedConnection" class="space-y-3 p-3">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p class="text-sm font-medium">{{ selectedConnection.name }}</p>
            <p class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseScopePermissionNote") }}</p>
          </div>
          <Button type="button" variant="outline" size="sm" :disabled="disabled || Boolean(loadingConnectionId)" @click="loadConnectionDatabases">
            <Loader2 v-if="loadingConnectionId === selectedConnection.id" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="mr-1.5 h-3.5 w-3.5" />
            {{ t("settings.mcpDatabaseLoadButton") }}
          </Button>
        </div>

        <div class="grid gap-2 sm:grid-cols-3" role="radiogroup" :aria-label="t('settings.mcpDatabaseScopeAriaLabel')">
          <Button type="button" variant="outline" class="h-auto justify-start px-3 py-2 text-left" :class="selectedScope === 'all' ? 'dbx-choice-selected' : ''" :disabled="disabled || busy" @click="setScope('all')">
            <span
              ><span class="block text-sm">{{ t("settings.mcpDatabaseScopeAllTitle") }}</span
              ><span class="block text-[11px] font-normal text-muted-foreground">{{ t("settings.mcpDatabaseScopeAllDescription") }}</span></span
            >
          </Button>
          <Button type="button" variant="outline" class="h-auto justify-start px-3 py-2 text-left" :class="selectedScope === 'selected' ? 'dbx-choice-selected' : ''" :disabled="disabled || busy" @click="setScope('selected')">
            <span
              ><span class="block text-sm">{{ t("settings.mcpDatabaseScopeSelectedTitle") }}</span
              ><span class="block text-[11px] font-normal text-muted-foreground">{{ t("settings.mcpDatabaseScopeSelectedDescription") }}</span></span
            >
          </Button>
          <Button type="button" variant="outline" class="h-auto justify-start px-3 py-2 text-left" :class="selectedScope === 'none' ? 'dbx-choice-selected' : ''" :disabled="disabled || busy" @click="setScope('none')">
            <span
              ><span class="block text-sm">{{ t("settings.mcpDatabaseScopeNoneTitle") }}</span
              ><span class="block text-[11px] font-normal text-muted-foreground">{{ t("settings.mcpDatabaseScopeNoneDescription") }}</span></span
            >
          </Button>
        </div>

        <template v-if="selectedScope === 'selected'">
          <p class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseScopeSelectedSummary", { count: selectedDatabases.length }) }}</p>
          <div class="flex gap-2">
            <div class="relative min-w-0 flex-1"><Search class="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input v-model="search" class="h-8 pl-8 text-xs" :placeholder="t('settings.mcpDatabaseSearchPlaceholder')" /></div>
            <Input v-model="manualDatabase" class="h-8 w-40 text-xs" :placeholder="t('settings.mcpDatabaseManualPlaceholder')" @keydown.enter.prevent="addManualDatabase" />
            <Button type="button" variant="outline" size="sm" :disabled="disabled || !manualDatabase.trim()" @click="addManualDatabase"><Plus class="h-3.5 w-3.5" /></Button>
          </div>
          <p v-if="loadError" class="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{{ t("settings.mcpDatabaseLoadFailed", { error: loadError }) }}</p>
          <div v-if="displayedDatabases.length" class="rounded border">
            <label v-for="database in pagedDatabases" :key="database" class="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0 hover:bg-muted/50">
              <input type="checkbox" :checked="selectedDatabases.includes(database)" :disabled="disabled || busy" @change="toggleDatabase(database, ($event.target as HTMLInputElement).checked)" />
              <span class="min-w-0 flex-1 truncate font-mono">{{ database }}</span>
              <Check v-if="selectedDatabases.includes(database)" class="h-3.5 w-3.5 text-green-600" />
            </label>
            <div v-if="databasePageCount > 1" class="flex items-center justify-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <Button type="button" size="icon-sm" variant="ghost" :disabled="databasePage === 1" :title="t('settings.mcpPreviousPage')" :aria-label="t('settings.mcpPreviousPage')" @click="setDatabasePage(databasePage - 1)"><ChevronLeft /></Button>
              <span class="min-w-12 text-center tabular-nums">{{ databasePage }} / {{ databasePageCount }}</span>
              <Button type="button" size="icon-sm" variant="ghost" :disabled="databasePage === databasePageCount" :title="t('settings.mcpNextPage')" :aria-label="t('settings.mcpNextPage')" @click="setDatabasePage(databasePage + 1)"><ChevronRight /></Button>
            </div>
          </div>
          <p v-else class="rounded border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{{ t("settings.mcpDatabaseEmptyHint") }}</p>
        </template>
      </div>
    </div>
  </section>
</template>
