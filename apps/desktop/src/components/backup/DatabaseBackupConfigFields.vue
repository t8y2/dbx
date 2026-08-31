<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, ChevronDown, FolderOpen, Loader2, Search } from "@lucide/vue";
import type { DatabaseBackupExecutionConfig } from "@/lib/backup/scheduledDatabaseBackup";
import type { ConnectionConfig } from "@/types/database";

const props = withDefaults(
  defineProps<{
    draft: DatabaseBackupExecutionConfig;
    connections: Array<Pick<ConnectionConfig, "id" | "name">>;
    allDatabases: boolean;
    selectedDatabases: string[];
    databaseOptions: string[];
    tablePatternsInput: string;
    loadingDatabases: boolean;
  }>(),
  { connections: () => [], selectedDatabases: () => [], databaseOptions: () => [] },
);

const emit = defineEmits<{
  changeConnection: [connectionId: string];
  chooseDestination: [];
  toggleDatabase: [database: string];
  "update:allDatabases": [value: boolean];
  "update:tablePatternsInput": [value: string];
}>();

const { t } = useI18n();
const connectionPickerOpen = ref(false);
const connectionSearch = ref("");
const databaseSearch = ref("");

const selectedConnectionName = computed(() => props.connections.find((connection) => connection.id === props.draft.connectionId)?.name || props.draft.connectionId);
const filteredConnections = computed(() => {
  const query = connectionSearch.value.trim().toLocaleLowerCase();
  if (!query) return props.connections;
  return props.connections.filter((connection) => connection.name.toLocaleLowerCase().includes(query));
});
const filteredDatabaseOptions = computed(() => {
  const query = databaseSearch.value.trim().toLocaleLowerCase();
  if (!query) return props.databaseOptions;
  return props.databaseOptions.filter((database) => database.toLocaleLowerCase().includes(query));
});

function selectConnection(connectionId: string) {
  emit("changeConnection", connectionId);
  connectionPickerOpen.value = false;
}

watch(connectionPickerOpen, (open) => {
  if (!open) connectionSearch.value = "";
});

watch(
  () => props.draft.connectionId,
  () => {
    databaseSearch.value = "";
  },
);
</script>

<template>
  <div class="grid gap-5 py-1">
    <div class="space-y-2">
      <Label>{{ t("databaseBackup.connection") }}</Label>
      <Popover v-model:open="connectionPickerOpen">
        <PopoverTrigger as-child>
          <Button data-backup-connection-picker type="button" variant="outline" role="combobox" :aria-expanded="connectionPickerOpen" class="w-full justify-between font-normal">
            <span class="truncate">{{ selectedConnectionName }}</span>
            <ChevronDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-[var(--reka-popover-trigger-width)] p-1">
          <div class="relative">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="connectionSearch" data-backup-connection-search class="h-9 pl-8" :aria-label="t('databaseBackup.searchConnections')" :placeholder="t('databaseBackup.searchConnections')" />
          </div>
          <div class="max-h-60 overflow-y-auto py-1">
            <button
              v-for="connection in filteredConnections"
              :key="connection.id"
              type="button"
              class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
              @click="selectConnection(connection.id)"
            >
              <Check class="h-4 w-4 shrink-0" :class="connection.id === draft.connectionId ? 'opacity-100' : 'opacity-0'" />
              <span class="min-w-0 flex-1 truncate">{{ connection.name }}</span>
            </button>
            <div v-if="filteredConnections.length === 0" class="px-2 py-2 text-sm text-muted-foreground">{{ t("databaseBackup.noMatchingConnections") }}</div>
          </div>
        </PopoverContent>
      </Popover>
    </div>

    <div class="space-y-2">
      <Label>{{ t("databaseBackup.destination") }}</Label>
      <div class="flex gap-2">
        <Input v-model="draft.destinationDirectory" readonly class="min-w-0" />
        <Button variant="outline" size="icon" class="shrink-0" :title="t('databaseBackup.selectDestination')" @click="emit('chooseDestination')">
          <FolderOpen class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ t("databaseBackup.compression") }}</Label>
      <label class="flex items-center gap-2 text-sm">
        <input :checked="draft.outputCompression === 'gzip'" type="checkbox" class="h-4 w-4 accent-primary" @change="draft.outputCompression = ($event.target as HTMLInputElement).checked ? 'gzip' : 'none'" />
        {{ t("databaseBackup.compressionGzip") }}
      </label>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-4">
        <Label>{{ t("databaseBackup.databases") }}</Label>
        <label class="flex items-center gap-2 text-sm">
          <input :checked="allDatabases" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" @change="emit('update:allDatabases', ($event.target as HTMLInputElement).checked)" />
          {{ t("databaseBackup.allDatabases") }}
        </label>
      </div>
      <div v-if="!allDatabases" class="space-y-2">
        <div class="relative">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="databaseSearch" data-backup-database-search class="h-9 pl-8" :aria-label="t('databaseBackup.searchDatabases')" :placeholder="t('databaseBackup.searchDatabases')" />
        </div>
        <div class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-2">
          <div v-if="loadingDatabases" class="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</div>
          <template v-else-if="filteredDatabaseOptions.length">
            <label v-for="database in filteredDatabaseOptions" :key="database" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
              <input type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :checked="selectedDatabases.includes(database)" @change="emit('toggleDatabase', database)" />
              <span class="truncate">{{ database }}</span>
            </label>
          </template>
          <div v-else class="px-2 py-2 text-sm text-muted-foreground">{{ t("databaseBackup.noMatchingDatabases") }}</div>
        </div>
      </div>
    </div>

    <div class="space-y-3">
      <div class="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div class="space-y-2">
          <Label>{{ t("databaseBackup.tableScope") }}</Label>
          <Select v-model="draft.tableFilterMode">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("databaseBackup.allTables") }}</SelectItem>
              <SelectItem value="include">{{ t("databaseBackup.includeTables") }}</SelectItem>
              <SelectItem value="exclude">{{ t("databaseBackup.excludeTables") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="draft.tableFilterMode !== 'all'" class="space-y-2">
          <Label>{{ t("databaseBackup.tablePatterns") }}</Label>
          <Input :model-value="tablePatternsInput" :placeholder="t('databaseBackup.tablePatternsPlaceholder')" @update:model-value="(value: any) => emit('update:tablePatternsInput', String(value))" />
        </div>
      </div>
      <p v-if="draft.tableFilterMode !== 'all'" class="text-xs text-muted-foreground">{{ t("databaseBackup.tablePatternsHint") }}</p>
    </div>

    <div class="space-y-3">
      <Label>{{ t("databaseBackup.contents") }}</Label>
      <div class="grid gap-2 sm:grid-cols-2">
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeStructure" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeStructure") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeData" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeData") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeObjects" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeObjects") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.dropTableIfExists" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.dropTableIfExists") }}</label>
      </div>
    </div>
  </div>
</template>
