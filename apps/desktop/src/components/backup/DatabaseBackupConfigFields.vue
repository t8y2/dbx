<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpTooltip } from "@/components/ui/tooltip";
import { Check, ChevronDown, FolderOpen, Loader2, Search } from "@lucide/vue";
import { databaseBackupFileNamePatternIsValid, type DatabaseBackupExecutionConfig } from "@/lib/backup/scheduledDatabaseBackup";
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
    databaseLoadError?: string;
    runDirectoryPattern?: string;
    runDirectoryPatternValid?: boolean;
    outputPathPreview?: string;
  }>(),
  { connections: () => [], selectedDatabases: () => [], databaseOptions: () => [], databaseLoadError: "", runDirectoryPatternValid: true, outputPathPreview: "" },
);

const emit = defineEmits<{
  changeConnection: [connectionId: string];
  chooseDestination: [];
  toggleDatabase: [database: string];
  "update:allDatabases": [value: boolean];
  "update:tablePatternsInput": [value: string];
  "update:runDirectoryPattern": [value: string];
}>();

const { t } = useI18n();
const connectionPickerOpen = ref(false);
const connectionSearch = ref("");
const databaseSearch = ref("");
const connectionPickerTrigger = ref<ComponentPublicInstance | null>(null);
const connectionPickerWidth = ref<number>();

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
const runDirectoryTemplateVariables = computed(() => [
  { token: "{schedule}", description: t("databaseBackup.templateVariableSchedule") },
  { token: "{date}", description: t("databaseBackup.templateVariableDate") },
  { token: "{timestamp}", description: t("databaseBackup.templateVariableTimestamp") },
  { token: "{runId}", description: t("databaseBackup.templateVariableRunId") },
]);
const fileNameTemplateVariables = computed(() => [
  { token: "{schedule}", description: t("databaseBackup.templateVariableSchedule") },
  { token: "{date}", description: t("databaseBackup.templateVariableDate") },
  { token: "{timestamp}", description: t("databaseBackup.templateVariableTimestamp") },
  { token: "{database}", description: t("databaseBackup.templateVariableDatabase") },
  { token: "{runId}", description: t("databaseBackup.templateVariableRunId") },
]);

function selectConnection(connectionId: string) {
  emit("changeConnection", connectionId);
  connectionPickerOpen.value = false;
}

function syncConnectionPickerWidth() {
  const element = connectionPickerTrigger.value?.$el;
  if (!(element instanceof HTMLElement)) return;
  const width = Math.ceil(element.getBoundingClientRect().width);
  if (width > 0) connectionPickerWidth.value = width;
}

watch(connectionPickerOpen, async (open) => {
  if (!open) {
    connectionSearch.value = "";
    return;
  }
  await nextTick();
  syncConnectionPickerWidth();
});

watch(
  () => props.draft.connectionId,
  () => {
    databaseSearch.value = "";
  },
);
</script>

<template>
  <div class="backup-config-fields grid gap-5 py-1">
    <div class="space-y-2">
      <Label>{{ t("databaseBackup.connection") }}</Label>
      <Popover v-model:open="connectionPickerOpen">
        <PopoverTrigger as-child>
          <Button ref="connectionPickerTrigger" data-backup-connection-picker type="button" variant="outline" role="combobox" :aria-expanded="connectionPickerOpen" class="w-full justify-between font-normal" @click="syncConnectionPickerWidth">
            <span class="truncate">{{ selectedConnectionName }}</span>
            <ChevronDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" :collision-padding="24" class="w-[var(--reka-popover-trigger-width)] max-w-[calc(100vw-48px)] p-1" :style="connectionPickerWidth ? { width: `${connectionPickerWidth}px` } : undefined">
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
      <div class="backup-destination-field">
        <Input v-model="draft.destinationDirectory" readonly :title="draft.destinationDirectory" />
        <Button variant="outline" size="icon" class="backup-destination-picker" :title="t('databaseBackup.selectDestination')" @click="emit('chooseDestination')">
          <FolderOpen class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <div class="space-y-4">
      <Label>{{ t("databaseBackup.outputPathTemplate") }}</Label>

      <div v-if="runDirectoryPattern !== undefined" class="space-y-2">
        <div class="flex items-center gap-1.5">
          <Label class="text-sm font-normal">{{ t("databaseBackup.runDirectoryPattern") }}</Label>
          <HelpTooltip :label="t('databaseBackup.templateVariablesHelp')" side="right" content-class="w-80 max-w-[calc(100vw-32px)]">
            <div class="space-y-2">
              <div class="font-medium">{{ t("databaseBackup.templateVariablesTitle") }}</div>
              <div v-for="variable in runDirectoryTemplateVariables" :key="variable.token" class="flex items-start gap-2">
                <code class="w-20 shrink-0 font-mono font-medium">{{ variable.token }}</code>
                <span>{{ variable.description }}</span>
              </div>
            </div>
          </HelpTooltip>
        </div>
        <Input :model-value="runDirectoryPattern" data-backup-run-directory-pattern :aria-invalid="!runDirectoryPatternValid" @update:model-value="(value: string | number) => emit('update:runDirectoryPattern', String(value))" />
        <p class="text-xs text-muted-foreground">{{ t("databaseBackup.runDirectoryPatternHint") }}</p>
        <p v-if="!runDirectoryPatternValid" class="text-xs text-destructive">{{ t("databaseBackup.runDirectoryPatternInvalid") }}</p>
      </div>

      <div class="space-y-2">
        <div class="flex items-center gap-1.5">
          <Label class="text-sm font-normal">{{ t("databaseBackup.fileNamePattern") }}</Label>
          <HelpTooltip :label="t('databaseBackup.templateVariablesHelp')" side="right" content-class="w-80 max-w-[calc(100vw-32px)]">
            <div class="space-y-2">
              <div class="font-medium">{{ t("databaseBackup.templateVariablesTitle") }}</div>
              <div v-for="variable in fileNameTemplateVariables" :key="variable.token" class="flex items-start gap-2">
                <code class="w-20 shrink-0 font-mono font-medium">{{ variable.token }}</code>
                <span>{{ variable.description }}</span>
              </div>
            </div>
          </HelpTooltip>
        </div>
        <Input v-model="draft.fileNamePattern" data-backup-file-name-pattern :aria-invalid="!databaseBackupFileNamePatternIsValid(draft.fileNamePattern || '')" />
        <p class="text-xs text-muted-foreground">{{ t("databaseBackup.fileNamePatternHint") }}</p>
        <p v-if="!databaseBackupFileNamePatternIsValid(draft.fileNamePattern || '')" class="text-xs text-destructive">{{ t("databaseBackup.fileNamePatternInvalid") }}</p>
      </div>

      <div v-if="outputPathPreview" data-backup-output-path-preview class="backup-output-path-preview space-y-1 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
        <div class="text-xs font-medium text-muted-foreground">{{ t("databaseBackup.outputPathPreview") }}</div>
        <div class="backup-output-path-value font-mono text-xs text-foreground" :title="outputPathPreview">{{ outputPathPreview }}</div>
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
        <p v-if="databaseLoadError" data-backup-database-load-error class="text-xs text-destructive">{{ databaseLoadError }}</p>
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

<style scoped>
.backup-config-fields {
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.backup-config-fields > * {
  min-width: 0;
  max-width: 100%;
}

.backup-destination-field {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding-right: 2.5rem;
}

.backup-destination-field > [data-slot="input"] {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
}

.backup-destination-picker {
  position: absolute;
  top: 0;
  right: 0;
  width: 2rem;
  height: 2rem;
  padding: 0;
}

.backup-output-path-preview {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.backup-output-path-value {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-all;
}
</style>
