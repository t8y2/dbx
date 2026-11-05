<script setup lang="ts">
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpTooltip } from "@/components/ui/tooltip";
import { Check, ChevronDown, Filter, FolderOpen, Loader2, Search, X } from "@lucide/vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import { databaseBackupFileNamePatternHasRunId, databaseBackupFileNamePatternIsValid, supportsNavicatBackupFormat, type DatabaseBackupExecutionConfig } from "@/lib/backup/scheduledDatabaseBackup";
import type { ConnectionConfig } from "@/types/database";
import BackupTableSelector from "./BackupTableSelector.vue";
import type { DatabaseBackupTableSelectionState } from "@/lib/backup/scheduledDatabaseBackup";

const props = withDefaults(
  defineProps<{
    draft: DatabaseBackupExecutionConfig;
    connections: Array<Pick<ConnectionConfig, "id" | "name"> & Partial<Pick<ConnectionConfig, "db_type">>>;
    allDatabases: boolean;
    selectedDatabases: string[];
    databaseOptions: string[];
    tablePatternsInput: string;
    loadingDatabases: boolean;
    databaseLoadError?: string;
    runDirectoryPattern?: string;
    runDirectoryPatternValid?: boolean;
    outputPathPreview?: string;
    /** Turns the connection picker into a multi-select driven by `selectedConnectionIds`. */
    multiSelectConnections?: boolean;
    selectedConnectionIds?: string[];
  }>(),
  { connections: () => [], selectedDatabases: () => [], databaseOptions: () => [], databaseLoadError: "", runDirectoryPatternValid: true, outputPathPreview: "", multiSelectConnections: false, selectedConnectionIds: () => [] },
);

const emit = defineEmits<{
  changeConnection: [connectionId: string];
  toggleConnection: [connectionId: string];
  chooseDestination: [];
  toggleDatabase: [database: string];
  tableSelectionState: [state: DatabaseBackupTableSelectionState];
  "update:allDatabases": [value: boolean];
  "update:selectedDatabases": [value: string[]];
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
const selectedConnectionType = computed(() => props.connections.find((connection) => connection.id === props.draft.connectionId)?.db_type);
// Database names and exact table lists belong to one connection, so they only apply when a single connection is selected.
const multipleConnectionsSelected = computed(() => props.multiSelectConnections && props.selectedConnectionIds.length > 1);
const selectedConnectionTypes = computed(() => {
  const connectionIds = props.multiSelectConnections ? props.selectedConnectionIds : props.draft.connectionId ? [props.draft.connectionId] : [];
  return connectionIds.map((connectionId) => props.connections.find((connection) => connection.id === connectionId)?.db_type);
});
const navicatFormatSupported = computed(() => supportsNavicatBackupFormat(selectedConnectionTypes.value));
// A saved schedule may still carry `.nb3` after its connection changed to an unsupported type.
const navicatFormatUnsupported = computed(() => props.draft.outputCompression === "nb3" && !navicatFormatSupported.value);
const connectionPickerLabel = computed(() => (multipleConnectionsSelected.value ? t("databaseBackup.connectionsSelected", { count: props.selectedConnectionIds.length }) : selectedConnectionName.value));
const fileNamePatternNeedsRunId = computed(() => multipleConnectionsSelected.value && !databaseBackupFileNamePatternHasRunId(props.draft.fileNamePattern));
const filteredConnections = computed(() => {
  const query = connectionSearch.value.trim().toLocaleLowerCase();
  if (!query) return props.connections;
  return props.connections.filter((connection) => connection.name.toLocaleLowerCase().includes(query));
});
const showOnlySelected = ref(false);
const selectedDatabaseSet = computed(() => new Set(props.selectedDatabases));
// Chips removal and the count badge are only valid against a successfully loaded option list:
// during a load the options are cleared, and after a failed load they stay empty, so removing
// one chip would silently drop the entire seeded selection.
const databaseOptionsReady = computed(() => !props.loadingDatabases && !props.databaseLoadError);

const filteredDatabaseOptions = computed(() => {
  let list = props.databaseOptions;
  if (showOnlySelected.value) {
    list = list.filter((database) => selectedDatabaseSet.value.has(database));
  }
  const query = databaseSearch.value.trim().toLocaleLowerCase();
  if (!query) return list;
  return list.filter((database) => database.toLocaleLowerCase().includes(query));
});

const allFilteredDatabasesSelected = computed(() => {
  if (filteredDatabaseOptions.value.length === 0) return false;
  return filteredDatabaseOptions.value.every((database) => selectedDatabaseSet.value.has(database));
});

const hasAnyFilteredDatabasesSelected = computed(() => {
  return filteredDatabaseOptions.value.some((database) => selectedDatabaseSet.value.has(database));
});

function clearAllSelectedDatabases() {
  emit("update:selectedDatabases", []);
}

function selectAllFilteredDatabases() {
  const next = new Set(props.selectedDatabases);
  for (const db of filteredDatabaseOptions.value) {
    next.add(db);
  }
  emit(
    "update:selectedDatabases",
    props.databaseOptions.filter((d) => next.has(d)),
  );
}

function deselectAllFilteredDatabases() {
  const removing = new Set(filteredDatabaseOptions.value);
  emit(
    "update:selectedDatabases",
    props.selectedDatabases.filter((d) => !removing.has(d)),
  );
}
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

function isConnectionSelected(connectionId: string): boolean {
  return props.multiSelectConnections ? props.selectedConnectionIds.includes(connectionId) : connectionId === props.draft.connectionId;
}

function selectConnection(connectionId: string) {
  if (props.multiSelectConnections) {
    emit("toggleConnection", connectionId);
    return;
  }
  emit("changeConnection", connectionId);
  connectionPickerOpen.value = false;
}

function syncConnectionPickerWidth() {
  const element = connectionPickerTrigger.value?.$el;
  if (!(element instanceof HTMLElement)) return;
  const width = Math.ceil(element.getBoundingClientRect().width);
  if (width > 0) connectionPickerWidth.value = width;
}

function handleScrollOutside(event: Event) {
  if (!connectionPickerOpen.value) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest?.('[data-slot="popover-content"]')) return;
  connectionPickerOpen.value = false;
}

watch(connectionPickerOpen, async (open) => {
  if (!open) {
    window.removeEventListener("scroll", handleScrollOutside, { capture: true });
    connectionSearch.value = "";
    return;
  }
  window.addEventListener("scroll", handleScrollOutside, { capture: true, passive: true });
  await nextTick();
  syncConnectionPickerWidth();
});

watch(
  () => props.draft,
  () => {
    connectionPickerOpen.value = false;
    connectionSearch.value = "";
    databaseSearch.value = "";
    showOnlySelected.value = false;
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("scroll", handleScrollOutside, { capture: true });
});

watch(
  () => props.draft.connectionId,
  () => {
    databaseSearch.value = "";
    showOnlySelected.value = false;
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
            <span class="truncate">{{ connectionPickerLabel }}</span>
            <ChevronDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" :collision-padding="24" :hide-when-detached="true" class="w-[var(--reka-popover-trigger-width)] max-w-[calc(100vw-48px)] p-1" :style="connectionPickerWidth ? { width: `${connectionPickerWidth}px` } : undefined">
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
              :role="multiSelectConnections ? 'checkbox' : undefined"
              :aria-checked="multiSelectConnections ? isConnectionSelected(connection.id) : undefined"
              @click="selectConnection(connection.id)"
            >
              <span v-if="multiSelectConnections" class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border" :class="isConnectionSelected(connection.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">
                <Check v-if="isConnectionSelected(connection.id)" class="h-3 w-3" />
              </span>
              <Check v-else class="h-4 w-4 shrink-0" :class="isConnectionSelected(connection.id) ? 'opacity-100' : 'opacity-0'" />
              <ConnectionGroupBadge :connection-id="connection.id" />
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
        <Input v-model="draft.destinationDirectory" :readonly="isTauriRuntime()" :title="draft.destinationDirectory" />
        <Button v-if="isTauriRuntime()" variant="outline" size="icon" class="backup-destination-picker" :title="t('databaseBackup.selectDestination')" @click="emit('chooseDestination')">
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
        <Input v-model="draft.fileNamePattern" data-backup-file-name-pattern :aria-invalid="!databaseBackupFileNamePatternIsValid(draft.fileNamePattern || '') || fileNamePatternNeedsRunId" />
        <p class="text-xs text-muted-foreground">{{ t("databaseBackup.fileNamePatternHint") }}</p>
        <p v-if="!databaseBackupFileNamePatternIsValid(draft.fileNamePattern || '')" class="text-xs text-destructive">{{ t("databaseBackup.fileNamePatternInvalid") }}</p>
        <p v-if="fileNamePatternNeedsRunId" data-backup-file-name-run-id-required class="text-xs text-destructive">{{ t("databaseBackup.multiConnectionRunIdRequired") }}</p>
      </div>

      <div v-if="outputPathPreview" data-backup-output-path-preview class="backup-output-path-preview space-y-1 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
        <div class="text-xs font-medium text-muted-foreground">{{ t("databaseBackup.outputPathPreview") }}</div>
        <div class="backup-output-path-value font-mono text-xs text-foreground" :title="outputPathPreview">{{ outputPathPreview }}</div>
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ t("databaseBackup.backupFormat") }}</Label>
      <Select v-model="draft.outputCompression">
        <SelectTrigger data-backup-output-format class="w-full sm:w-65" :aria-invalid="navicatFormatUnsupported"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{{ t("databaseBackup.formatSql") }}</SelectItem>
          <SelectItem value="gzip">{{ t("databaseBackup.compressionGzip") }}</SelectItem>
          <SelectItem value="nb3" :disabled="!navicatFormatSupported">{{ t("databaseBackup.formatNb3") }}</SelectItem>
        </SelectContent>
      </Select>
      <p v-if="navicatFormatUnsupported" data-backup-nb3-unsupported class="text-xs text-destructive">{{ t("databaseBackup.formatNb3Unsupported") }}</p>
      <p v-else-if="draft.outputCompression === 'nb3'" data-backup-nb3-hint class="text-xs text-muted-foreground">{{ t("databaseBackup.formatNb3Hint") }}</p>
    </div>

    <div v-if="multipleConnectionsSelected" data-backup-multi-connection-hint class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {{ t("databaseBackup.multiConnectionScopeHint") }}
    </div>
    <div v-else class="space-y-3">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2">
          <Label>{{ t("databaseBackup.databases") }}</Label>
          <Badge v-if="!allDatabases && databaseOptionsReady" variant="secondary" data-backup-selected-databases-badge class="h-5 px-1.5 text-[11px] font-normal">
            {{ t("databaseBackup.selectedDatabasesCount", { selected: selectedDatabases.length, total: databaseOptions.length }) }}
          </Badge>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input :checked="allDatabases" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" @change="emit('update:allDatabases', ($event.target as HTMLInputElement).checked)" />
          {{ t("databaseBackup.allDatabases") }}
        </label>
      </div>
      <div v-if="!allDatabases" class="space-y-2.5">
        <!-- Visual Selected Databases Preview Area (Chips / Tags) -->
        <div v-if="databaseOptionsReady && selectedDatabases.length > 0" data-backup-selected-databases-preview class="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div class="flex items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-1.5 font-medium text-muted-foreground">
              <span>{{ t("databaseBackup.selectedDatabasesList") }}</span>
              <span class="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-foreground">{{ selectedDatabases.length }}</span>
            </div>
            <button type="button" data-backup-clear-selected-databases class="text-xs text-muted-foreground transition-colors hover:text-destructive focus:outline-none" @click="clearAllSelectedDatabases">
              {{ t("databaseBackup.clearSelection") }}
            </button>
          </div>
          <div class="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pt-0.5" data-backup-selected-database-tags>
            <Badge v-for="database in selectedDatabases" :key="database" variant="secondary" data-backup-selected-database-chip class="inline-flex max-w-[200px] items-center gap-1 py-0.5 pl-2 pr-1 text-xs font-normal" :title="database">
              <span class="truncate">{{ database }}</span>
              <button
                type="button"
                data-backup-remove-selected-database
                class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground focus:outline-none"
                :aria-label="t('databaseBackup.removeDatabase', { name: database })"
                @click.stop="emit('toggleDatabase', database)"
              >
                <X class="h-3 w-3" />
              </button>
            </Badge>
          </div>
        </div>

        <!-- Search & Filter Controls -->
        <div class="flex items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="databaseSearch" data-backup-database-search class="h-9 pl-8 text-xs" :aria-label="t('databaseBackup.searchDatabases')" :placeholder="t('databaseBackup.searchDatabases')" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-backup-filter-selected-toggle
            class="h-9 shrink-0 gap-1.5 px-2.5 text-xs font-normal"
            :class="showOnlySelected ? 'border-primary bg-primary/10 text-primary hover:bg-primary/15' : ''"
            :title="t('databaseBackup.showOnlySelectedHint')"
            @click="showOnlySelected = !showOnlySelected"
          >
            <Filter class="h-3.5 w-3.5" />
            <span>{{ t("databaseBackup.showOnlySelected") }}</span>
            <span v-if="selectedDatabases.length" class="ml-0.5 rounded-full bg-primary/20 px-1.5 py-0.2 text-[10px] font-medium leading-tight">{{ selectedDatabases.length }}</span>
          </Button>
        </div>

        <!-- Quick actions: Available count & Select all / Deselect all -->
        <div v-if="databaseOptions.length > 0 && !loadingDatabases" class="flex items-center justify-between px-0.5 text-xs text-muted-foreground">
          <span>{{ t("databaseBackup.availableDatabasesCount", { count: filteredDatabaseOptions.length }) }}</span>
          <div class="flex items-center gap-3">
            <button v-if="!allFilteredDatabasesSelected" type="button" data-backup-select-all-filtered class="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none" @click="selectAllFilteredDatabases">
              {{ t("databaseBackup.selectAll") }}
            </button>
            <button v-if="hasAnyFilteredDatabasesSelected" type="button" data-backup-deselect-all-filtered class="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none" @click="deselectAllFilteredDatabases">
              {{ t("databaseBackup.deselectAll") }}
            </button>
          </div>
        </div>

        <!-- Database Checklist -->
        <div class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-2">
          <div v-if="loadingDatabases" class="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</div>
          <template v-else-if="filteredDatabaseOptions.length">
            <label v-for="database in filteredDatabaseOptions" :key="database" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
              <input type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :checked="selectedDatabases.includes(database)" @change="emit('toggleDatabase', database)" />
              <span class="truncate">{{ database }}</span>
            </label>
          </template>
          <div v-else class="px-2 py-2 text-sm text-muted-foreground">
            {{ showOnlySelected ? t("databaseBackup.noSelectedDatabasesMatching") : t("databaseBackup.noMatchingDatabases") }}
          </div>
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
              <SelectItem v-if="!multipleConnectionsSelected" value="selected">{{ t("databaseBackup.exactTables") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="draft.tableFilterMode === 'include' || draft.tableFilterMode === 'exclude'" class="space-y-2">
          <Label>{{ t("databaseBackup.tablePatterns") }}</Label>
          <Input :model-value="tablePatternsInput" :placeholder="t('databaseBackup.tablePatternsPlaceholder')" @update:model-value="(value: any) => emit('update:tablePatternsInput', String(value))" />
        </div>
      </div>
      <p v-if="draft.tableFilterMode === 'include' || draft.tableFilterMode === 'exclude'" class="text-xs text-muted-foreground">{{ t("databaseBackup.tablePatternsHint") }}</p>
      <BackupTableSelector
        v-if="draft.tableFilterMode === 'selected'"
        :connection-id="draft.connectionId"
        :database-type="selectedConnectionType"
        :databases="allDatabases ? [] : selectedDatabases"
        :model-value="draft.selectedTables ?? []"
        @update:model-value="(value) => (draft.selectedTables = value)"
        @state-change="(state) => emit('tableSelectionState', state)"
      />
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
