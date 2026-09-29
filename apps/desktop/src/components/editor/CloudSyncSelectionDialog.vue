<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SyncCatalogItem, SyncSelection, SyncSnapshotCatalog } from "@/lib/backend/api";
import { transferCategoryForKey, type SettingsTransferCategoryId } from "@/lib/settings/settingsTransfer";
import { clonePluginData } from "@/lib/plugins/pluginData";

type BackupSettingsCategoryId = Exclude<SettingsTransferCategoryId, "other"> | "ai";

const props = defineProps<{
  open: boolean;
  mode: "upload" | "restore";
  catalog: SyncSnapshotCatalog | null;
  defaultIncludeSecrets?: boolean;
  secretsPassphraseAvailable?: boolean;
  showLocalExportPath?: boolean;
  localExportPath?: string;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [selection: SyncSelection];
  "choose-local-export-path": [];
}>();

const selection = ref<SyncSelection>(emptySelection());
const secretsPassphraseRequired = ref(false);
const localExportPathRequired = ref(false);
const isRestore = computed(() => props.mode === "restore");

const backupSettingsCategoryOrder: readonly BackupSettingsCategoryId[] = ["appearance", "editor", "formatter", "navigation", "data", "shortcuts", "snippets", "ai"];
const backupSettingsCategoryLabelKeys: Record<BackupSettingsCategoryId, string> = {
  appearance: "settings.appearanceTab",
  ai: "settings.aiTab",
  editor: "settings.editorTab",
  formatter: "settings.sqlFormatterTab",
  navigation: "settings.navigationTab",
  data: "settings.dataTab",
  shortcuts: "settings.shortcutsTab",
  snippets: "settings.snippetsTab",
};
const nonSyncableEditorSettingIds = new Set(["updateNotificationsEnabled", "autoDownloadUpdates", "autoUpdateApp", "autoUpdateDrivers", "autoUpdateJdbc", "autoUpdateMcp", "autoUpdatePlugins", "updateDownloadSource", "ignoredUpdateVersion"]);
const desktopSettingCategories: Record<string, BackupSettingsCategoryId> = {
  show_tray_icon: "appearance",
  icon_theme: "appearance",
  quit_on_close: "appearance",
  close_action_prompted: "appearance",
  sidebar_table_page_size: "navigation",
  metadata_cache_max_memory_mb: "data",
  duckdb_worker_process_isolation: "data",
  duckdb_worker_max_processes: "data",
};
const editorSettingCategoryOverrides: Partial<Record<string, BackupSettingsCategoryId>> = {
  aiFontFamily: "ai",
  aiFontSize: "ai",
  customThemeColors: "appearance",
  appLayout: "appearance",
  tabLayout: "appearance",
  tabPlacement: "appearance",
  tabGroupMode: "appearance",
  tabGroupCustomizations: "appearance",
  tabSortMode: "appearance",
  compactTabTitle: "appearance",
  executeModeDefaultVersion: "editor",
  globalConnectTimeoutSecs: "editor",
  connectTimeoutInheritConnectionIds: "editor",
  globalQueryTimeoutSecs: "editor",
  queryTimeoutInheritConnectionIds: "editor",
  timeoutInheritanceMigrationVersion: "editor",
  blockDangerousRedisCommands: "editor",
  tableDdlWordWrap: "editor",
  refreshDdlOnOpen: "editor",
  excludeDdlStorage: "editor",
  sqlSemanticDiagnosticsEnabled: "editor",
  infiniteScrollMaxRows: "data",
  tableFontSize: "data",
  mongoViewMode: "data",
  dataGridMultiRowTranspose: "data",
  dataGridHideNullColumns: "data",
  dataGridBooleanDisplayMode: "data",
  numericColumnRightAlign: "data",
  structureEditorDensity: "data",
  tableInfoActiveTab: "data",
  tableInfoDrawerPinned: "data",
  tableInfoDrawerWidth: "data",
  cellDetailDrawerWidth: "data",
  cellDetailPanelLayout: "data",
  cellDetailJsonFormatted: "data",
  cellDetailMetadataCollapsed: "data",
  localFilterPopoverWidth: "data",
  dataGridRenderMode: "data",
  dataGridSearchMode: "data",
  dataGridRowNumberMode: "data",
  dataGridCopyExtractor: "data",
  dataGridExtractorOptions: "data",
  dataGridExtractorOptionsMigrationVersion: "data",
  resultRunDisplayMode: "data",
  dataGridTextFilterPanelHeight: "data",
  columnWidthDensity: "data",
  dataGridColumnWidthMode: "data",
  sidebarConnectionSortMode: "navigation",
  sidebarTableSearchLocal: "navigation",
  sidebarGlobalSearchLocal: "navigation",
  sidebarBrowseObjectsOnDatabaseActivationMigrationVersion: "navigation",
  rememberedConnectionDatabases: "navigation",
  sidebarShowConnectionNotes: "navigation",
  customColumnFormatters: "data",
  columnFormatters: "data",
  pluginShortcuts: "shortcuts",
  objectBrowserShowCheckbox: "data",
  objectBrowserViewMode: "data",
};

function editorSettingCategory(id: string): BackupSettingsCategoryId {
  const transferCategory = transferCategoryForKey(id);
  if (transferCategory === "other") return "editor";
  return editorSettingCategoryOverrides[id] ?? transferCategory ?? "editor";
}

function selectableDesktopSettings(catalog: SyncSnapshotCatalog): SyncCatalogItem[] {
  return catalog.desktopSettings.filter((item) => Object.prototype.hasOwnProperty.call(desktopSettingCategories, item.id));
}

function selectableEditorSettings(catalog: SyncSnapshotCatalog): SyncCatalogItem[] {
  return catalog.editorSettings.filter((item) => !nonSyncableEditorSettingIds.has(item.id));
}

function selectedSettings(savedIds: string[] | undefined, items: SyncCatalogItem[]): string[] {
  if (savedIds === undefined) return items.map((item) => item.id);
  const saved = new Set(savedIds);
  return items.filter((item) => saved.has(item.id)).map((item) => item.id);
}

const backupSettingsCategories = computed(() => {
  const catalog = props.catalog;
  if (!catalog) return [];
  const groups = new Map<BackupSettingsCategoryId, { desktop: SyncCatalogItem[]; editor: SyncCatalogItem[] }>();
  for (const category of backupSettingsCategoryOrder) groups.set(category, { desktop: [], editor: [] });
  for (const item of selectableDesktopSettings(catalog)) groups.get(desktopSettingCategories[item.id])?.desktop.push(item);
  for (const item of selectableEditorSettings(catalog)) groups.get(editorSettingCategory(item.id))?.editor.push(item);
  return backupSettingsCategoryOrder.flatMap((category) => {
    const group = groups.get(category)!;
    const desktopSelected = group.desktop.filter((item) => selection.value.desktopSettings?.includes(item.id)).length;
    const editorSelected = group.editor.filter((item) => selection.value.editorSettings?.includes(item.id)).length;
    const total = group.desktop.length + group.editor.length;
    if (!total) return [];
    return [{ id: category, labelKey: backupSettingsCategoryLabelKeys[category], desktop: group.desktop, editor: group.editor, total, selected: desktopSelected + editorSelected }];
  });
});

function emptySelection(): SyncSelection {
  return {
    connections: [],
    connectionSecrets: [],
    tunnelProfiles: [],
    tunnelSecrets: [],
    savedSqlFolders: [],
    savedSqlFiles: [],
    desktopSettings: [],
    editorSettings: [],
    aiConfigs: [],
    pluginUiStorage: [],
    sidebarLayout: false,
    pinnedTreeNodeIds: false,
    includeSecrets: false,
    syncCredentials: false,
  };
}

function resetFromCatalog() {
  const catalog = props.catalog;
  if (!catalog) return;
  const saved = catalog.selection;
  const desktopSettings = selectableDesktopSettings(catalog);
  const editorSettings = selectableEditorSettings(catalog);
  selection.value = {
    ...emptySelection(),
    connections: saved?.connections ?? catalog.connections.map((item) => item.id),
    connectionSecrets: saved?.connectionSecrets ?? (catalog.hasEncryptedSecrets ? catalog.connectionSecrets : []),
    tunnelProfiles: saved?.tunnelProfiles ?? catalog.tunnelProfiles.map((item) => item.id),
    tunnelSecrets: saved?.tunnelSecrets ?? (catalog.hasEncryptedSecrets ? catalog.tunnelSecrets : []),
    savedSqlFolders: saved?.savedSqlFolders ?? catalog.savedSqlFolders.map((item) => item.id),
    savedSqlFiles: saved?.savedSqlFiles ?? catalog.savedSqlFiles.map((item) => item.id),
    desktopSettings: selectedSettings(saved?.desktopSettings, desktopSettings),
    editorSettings: selectedSettings(saved?.editorSettings, editorSettings),
    aiConfigs: saved?.aiConfigs ?? (catalog.aiConfigsLocked ? undefined : catalog.aiConfigs.map((item) => item.id)),
    pluginUiStorage: saved?.pluginUiStorage ?? (catalog.pluginUiStorageLocked ? undefined : catalog.pluginUiStorage),
    sidebarLayout: saved?.sidebarLayout ?? catalog.hasSidebarLayout,
    pinnedTreeNodeIds: saved?.pinnedTreeNodeIds ?? catalog.hasPinnedTreeNodeIds,
    includeSecrets: props.secretsPassphraseAvailable === false ? false : (saved?.includeSecrets ?? (isRestore.value ? catalog.hasEncryptedSecrets : !!props.defaultIncludeSecrets)),
    syncCredentials: saved?.syncCredentials ?? (isRestore.value ? catalog.hasEncryptedSecrets : !!props.defaultIncludeSecrets),
  };
  if (selection.value.includeSecrets && !saved) onSecretsChanged();
}

watch(
  () => [props.open, props.catalog] as const,
  ([open]) => {
    if (open) {
      secretsPassphraseRequired.value = false;
      localExportPathRequired.value = false;
      resetFromCatalog();
    }
  },
  { immediate: true },
);

function ids(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs") {
  return selection.value[key] ?? [];
}

function allSelected(key: "connections" | "tunnelProfiles", items: SyncCatalogItem[]) {
  return items.length > 0 && items.every((item) => ids(key).includes(item.id));
}

function toggleId(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", id: string) {
  const current = ids(key);
  selection.value[key] = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

function toggleAll(key: "connections" | "tunnelProfiles" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", items: SyncCatalogItem[]) {
  const current = ids(key);
  const isAllSelected = items.length > 0 && items.every((item) => current.includes(item.id));
  selection.value[key] = isAllSelected ? [] : items.map((item) => item.id);
}

function toggleSettingsCategory(category: BackupSettingsCategoryId) {
  const catalog = props.catalog;
  const group = backupSettingsCategories.value.find((item) => item.id === category);
  if (!catalog || !group) return;
  const include = group.selected !== group.total;
  const desktopIds = new Set(selectedSettings(selection.value.desktopSettings, selectableDesktopSettings(catalog)));
  const editorIds = new Set(selectedSettings(selection.value.editorSettings, selectableEditorSettings(catalog)));
  for (const item of group.desktop) {
    if (include) desktopIds.add(item.id);
    else desktopIds.delete(item.id);
  }
  for (const item of group.editor) {
    if (include) editorIds.add(item.id);
    else editorIds.delete(item.id);
  }
  selection.value.desktopSettings = [...desktopIds];
  selection.value.editorSettings = [...editorIds];
}

function togglePluginItem(pluginId: string, key: string) {
  const current = selection.value.pluginUiStorage ?? [];
  const exists = current.some((item) => item.pluginId === pluginId && item.key === key);
  selection.value.pluginUiStorage = exists ? current.filter((item) => item.pluginId !== pluginId || item.key !== key) : [...current, props.catalog?.pluginUiStorage.find((item) => item.pluginId === pluginId && item.key === key)!];
}

function togglePluginAll() {
  if (props.catalog?.pluginUiStorageLocked) {
    selection.value.pluginUiStorage = selection.value.pluginUiStorage === undefined ? [] : undefined;
    return;
  }
  const all = props.catalog?.pluginUiStorage ?? [];
  selection.value.pluginUiStorage = selection.value.pluginUiStorage?.length === all.length ? [] : [...all];
}

function toggleAllAiConfigs() {
  if (props.catalog?.aiConfigsLocked) {
    selection.value.aiConfigs = selection.value.aiConfigs === undefined ? [] : undefined;
    return;
  }
  toggleAll("aiConfigs", props.catalog?.aiConfigs ?? []);
}

function onSecretsChanged(event?: Event) {
  if (event) {
    const includeSecrets = (event.target as HTMLInputElement).checked;
    if (includeSecrets && props.secretsPassphraseAvailable === false) {
      selection.value.includeSecrets = false;
      secretsPassphraseRequired.value = true;
      return;
    }
    selection.value.includeSecrets = includeSecrets;
    secretsPassphraseRequired.value = false;
  }
  if (!selection.value.includeSecrets || !props.catalog) return;
  if (!selection.value.connectionSecrets?.length) selection.value.connectionSecrets = [...props.catalog.connectionSecrets];
  if (!selection.value.tunnelSecrets?.length) selection.value.tunnelSecrets = [...props.catalog.tunnelSecrets];
  if (!selection.value.aiConfigs?.length && props.catalog.aiConfigs.length) selection.value.aiConfigs = props.catalog.aiConfigs.map((item) => item.id);
  if (!selection.value.pluginUiStorage?.length && !props.catalog.pluginUiStorageLocked) selection.value.pluginUiStorage = [...props.catalog.pluginUiStorage];
  selection.value.syncCredentials = true;
}

function checked(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", id: string) {
  return ids(key).includes(id);
}

function copySelection(): SyncSelection {
  const current = selection.value;
  return {
    connections: current.connections ? [...current.connections] : undefined,
    connectionSecrets: current.connectionSecrets ? [...current.connectionSecrets] : undefined,
    tunnelProfiles: current.tunnelProfiles ? [...current.tunnelProfiles] : undefined,
    tunnelSecrets: current.tunnelSecrets ? [...current.tunnelSecrets] : undefined,
    savedSqlFolders: current.savedSqlFolders ? [...current.savedSqlFolders] : undefined,
    savedSqlFiles: current.savedSqlFiles ? [...current.savedSqlFiles] : undefined,
    desktopSettings: current.desktopSettings ? [...current.desktopSettings] : undefined,
    editorSettings: current.editorSettings ? [...current.editorSettings] : undefined,
    aiConfigs: current.aiConfigs ? [...current.aiConfigs] : undefined,
    pluginUiStorage: current.pluginUiStorage?.map(({ pluginId, key, pluginName }) => ({ pluginId, key, pluginName })),
    sidebarLayout: current.sidebarLayout,
    pinnedTreeNodeIds: current.pinnedTreeNodeIds,
    includeSecrets: current.includeSecrets,
    syncCredentials: current.syncCredentials,
  };
}

function confirmSelection() {
  if (props.showLocalExportPath && !props.localExportPath?.trim()) {
    localExportPathRequired.value = true;
    return;
  }
  localExportPathRequired.value = false;
  if (props.catalog) {
    selection.value.desktopSettings = selectedSettings(selection.value.desktopSettings, selectableDesktopSettings(props.catalog));
    selection.value.editorSettings = selectedSettings(selection.value.editorSettings, selectableEditorSettings(props.catalog));
  }
  emit("confirm", clonePluginData(copySelection()));
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[min(88vh,calc(var(--dbx-viewport-height)-4rem))] flex-col gap-0 overflow-hidden border border-border !bg-background-solid p-0 text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[760px]">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <DialogTitle>{{ isRestore ? t("settings.syncSelectionRestoreTitle") : t("settings.syncSelectionUploadTitle") }}</DialogTitle>
        <DialogDescription>
          {{ isRestore ? t("settings.syncSelectionRestoreNote") : t("settings.syncSelectionBackupNote") }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="catalog" class="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
        <details open class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">
            <input :checked="allSelected('connections', catalog.connections)" type="checkbox" class="size-4 accent-primary" @click.stop.prevent="toggleAll('connections', catalog.connections)" />
            <span>{{ t("settings.syncSelectionConnections") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ selection.connections?.length ?? 0 }}/{{ catalog.connections.length }}</span>
          </summary>
          <div class="ml-6 space-y-1 pb-2">
            <div v-for="item in catalog.connections" :key="item.id" class="py-1">
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="checked('connections', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('connections', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
              <label v-if="catalog.connectionSecrets.includes(item.id)" class="ml-6 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                <input :checked="checked('connectionSecrets', item.id)" :disabled="!selection.includeSecrets || !selection.connections?.includes(item.id)" type="checkbox" class="size-3.5 accent-primary" @change="toggleId('connectionSecrets', item.id)" />
                <span>{{ t("settings.syncSelectionConnectionSecrets") }}</span>
              </label>
            </div>
            <p v-if="!catalog.connections.length" class="py-1 text-xs text-muted-foreground">{{ t("settings.syncSelectionNoConnections") }}</p>
          </div>
        </details>

        <details open class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">
            <input :checked="allSelected('tunnelProfiles', catalog.tunnelProfiles)" type="checkbox" class="size-4 accent-primary" @click.stop.prevent="toggleAll('tunnelProfiles', catalog.tunnelProfiles)" />
            <span>{{ t("settings.syncSelectionTunnels") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ selection.tunnelProfiles?.length ?? 0 }}/{{ catalog.tunnelProfiles.length }}</span>
          </summary>
          <div class="ml-6 space-y-1 pb-2">
            <div v-for="item in catalog.tunnelProfiles" :key="item.id" class="py-1">
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="checked('tunnelProfiles', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('tunnelProfiles', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
              <label v-if="catalog.tunnelSecrets.includes(item.id)" class="ml-6 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                <input :checked="checked('tunnelSecrets', item.id)" :disabled="!selection.includeSecrets || !selection.tunnelProfiles?.includes(item.id)" type="checkbox" class="size-3.5 accent-primary" @change="toggleId('tunnelSecrets', item.id)" />
                <span>{{ t("settings.syncSelectionTunnelSecrets") }}</span>
              </label>
            </div>
            <p v-if="!catalog.tunnelProfiles.length" class="py-1 text-xs text-muted-foreground">{{ t("settings.syncSelectionNoTunnels") }}</p>
          </div>
        </details>

        <details open class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">{{ t("settings.syncSelectionSavedSql") }}</summary>
          <div class="ml-6 space-y-2 pb-2">
            <div>
              <button type="button" class="mb-1 text-xs font-medium text-muted-foreground hover:text-foreground" @click="toggleAll('savedSqlFolders', catalog.savedSqlFolders)">
                {{ t("settings.syncSelectionFolders") }} ({{ selection.savedSqlFolders?.length ?? 0 }}/{{ catalog.savedSqlFolders.length }})
              </button>
              <label v-for="item in catalog.savedSqlFolders" :key="item.id" class="flex min-h-7 items-center gap-2 pl-1 text-sm">
                <input :checked="checked('savedSqlFolders', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('savedSqlFolders', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
            </div>
            <div>
              <button type="button" class="mb-1 text-xs font-medium text-muted-foreground hover:text-foreground" @click="toggleAll('savedSqlFiles', catalog.savedSqlFiles)">{{ t("settings.syncSelectionFiles") }} ({{ selection.savedSqlFiles?.length ?? 0 }}/{{ catalog.savedSqlFiles.length }})</button>
              <label v-for="item in catalog.savedSqlFiles" :key="item.id" class="flex min-h-7 items-center gap-2 pl-1 text-sm">
                <input :checked="checked('savedSqlFiles', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('savedSqlFiles', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
            </div>
          </div>
        </details>

        <details open class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">{{ t("settings.syncSelectionPersonalSettings") }}</summary>
          <div class="ml-6 space-y-1 py-2">
            <label v-for="category in backupSettingsCategories" :key="category.id" class="flex min-h-7 items-center gap-2 text-sm">
              <input :checked="category.total > 0 && category.selected === category.total" type="checkbox" class="size-4 accent-primary" @change="toggleSettingsCategory(category.id)" />
              <span>{{ t(category.labelKey) }}</span>
              <span class="ml-auto text-xs text-muted-foreground">{{ category.selected }}/{{ category.total }}</span>
            </label>
          </div>
        </details>

        <details open class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">
            <input :checked="selection.includeSecrets" type="checkbox" class="size-4 accent-primary" @click.stop @change="onSecretsChanged" />
            <span>{{ t("settings.syncSelectionEncrypted") }}</span>
          </summary>
          <div class="ml-6 space-y-2 pb-2">
            <p v-if="secretsPassphraseRequired" role="alert" class="text-xs text-destructive">
              {{ t("settings.localBackupSecretsPassphraseRequiredHint") }}
            </p>
            <label class="flex min-h-7 items-center gap-2 text-sm">
              <input v-model="selection.syncCredentials" :disabled="!selection.includeSecrets" type="checkbox" class="size-4 accent-primary" />
              <span>{{ t("settings.syncSelectionSyncCredentials") }}</span>
            </label>
            <div>
              <label v-if="catalog.aiConfigsLocked" class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="selection.aiConfigs === undefined" :disabled="!selection.includeSecrets" type="checkbox" class="size-4 accent-primary" @change="toggleAllAiConfigs" />
                <span>{{ t("settings.syncSelectionAiLocked") }}</span>
              </label>
              <template v-else>
                <button type="button" class="mb-1 text-xs font-medium text-muted-foreground hover:text-foreground" :disabled="!selection.includeSecrets" @click="toggleAllAiConfigs">
                  {{ t("settings.syncSelectionAiConfigs") }} ({{ selection.aiConfigs?.length ?? 0 }}/{{ catalog.aiConfigs.length }})
                </button>
                <label v-for="item in catalog.aiConfigs" :key="item.id" class="flex min-h-7 items-center gap-2 text-sm">
                  <input :checked="checked('aiConfigs', item.id)" :disabled="!selection.includeSecrets" type="checkbox" class="size-4 accent-primary" @change="toggleId('aiConfigs', item.id)" />
                  <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
                </label>
              </template>
            </div>
            <div>
              <label v-if="catalog.pluginUiStorageLocked" class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="selection.pluginUiStorage === undefined" :disabled="!selection.includeSecrets" type="checkbox" class="size-4 accent-primary" @change="togglePluginAll" />
                <span>{{ t("settings.syncSelectionPluginLocked") }}</span>
              </label>
              <template v-else>
                <button type="button" class="mb-1 text-xs font-medium text-muted-foreground hover:text-foreground" :disabled="!selection.includeSecrets" @click="togglePluginAll">
                  {{ t("settings.syncSelectionPluginData") }} ({{ selection.pluginUiStorage?.length ?? 0 }}/{{ catalog.pluginUiStorage.length }})
                </button>
                <label v-for="item in catalog.pluginUiStorage" :key="item.pluginId + '/' + item.key" class="flex min-h-7 items-center gap-2 text-sm">
                  <input :checked="selection.pluginUiStorage?.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key)" :disabled="!selection.includeSecrets" type="checkbox" class="size-4 accent-primary" @change="togglePluginItem(item.pluginId, item.key)" />
                  <span class="min-w-0 truncate">{{ item.pluginName || item.pluginId }} / {{ item.key }}</span>
                </label>
                <p v-if="!catalog.pluginUiStorage.length" class="text-xs text-muted-foreground">{{ t("settings.syncSelectionNoPluginData") }}</p>
              </template>
            </div>
            <p v-if="!catalog.hasEncryptedSecrets && isRestore" class="text-xs text-muted-foreground">{{ t("settings.syncSelectionNoEncrypted") }}</p>
          </div>
        </details>

        <details open class="pb-1">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium">{{ t("settings.syncSelectionWorkspace") }}</summary>
          <div class="ml-6 space-y-1 pb-2">
            <label class="flex min-h-7 items-center gap-2 text-sm">
              <input v-model="selection.sidebarLayout" :disabled="!catalog.hasSidebarLayout" type="checkbox" class="size-4 accent-primary" />
              <span>{{ t("settings.syncSelectionSidebar") }}</span>
            </label>
            <label class="flex min-h-7 items-center gap-2 text-sm">
              <input v-model="selection.pinnedTreeNodeIds" :disabled="!catalog.hasPinnedTreeNodeIds" type="checkbox" class="size-4 accent-primary" />
              <span>{{ t("settings.syncSelectionPinned") }}</span>
            </label>
          </div>
        </details>
      </div>

      <div v-if="showLocalExportPath" class="shrink-0 border-t px-5 py-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium">{{ t("settings.localBackupPathLabel") }}</p>
            <p class="truncate text-xs text-muted-foreground">
              {{ localExportPath || t("settings.localBackupPathUnset") }}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" @click="emit('choose-local-export-path')">
            <FolderOpen class="mr-1 h-3.5 w-3.5" />
            {{ t("settings.localBackupChoosePath") }}
          </Button>
        </div>
        <p v-if="localExportPathRequired" role="alert" class="mt-2 text-xs text-destructive">
          {{ t("settings.localBackupPathRequired") }}
        </p>
      </div>

      <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-5 pb-4 pt-3">
        <Button variant="outline" @click="emit('update:open', false)">{{ t("settings.syncSelectionCancel") }}</Button>
        <Button :disabled="!catalog" @click="confirmSelection">{{ isRestore ? t("settings.syncSelectionRestoreAction") : t("settings.syncSelectionUploadAction") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
