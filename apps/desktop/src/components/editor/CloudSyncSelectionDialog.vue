<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, FoldVertical, FolderOpen, ListChecks, ListX, Lock, UnfoldVertical } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PluginUiStorageItemRef, SyncCatalogItem, SyncSelection, SyncSnapshotCatalog } from "@/lib/backend/api";
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
const localExportPathRequired = ref(false);
const isRestore = computed(() => props.mode === "restore");
// Without a passphrase no encrypted item can be selected, so the dialog hides the secret
// checkboxes entirely and shows a persistent hint inside the affected groups instead.
const secretsUnavailable = computed(() => props.secretsPassphraseAvailable === false);

const SYNC_GROUP_IDS = ["connections", "tunnels", "savedSql", "settings", "secrets", "workspace"] as const;
type SyncGroupId = (typeof SYNC_GROUP_IDS)[number];
const collapsedGroups = ref<Set<SyncGroupId>>(new Set(SYNC_GROUP_IDS));
const allGroupsCollapsed = computed(() => SYNC_GROUP_IDS.every((id) => collapsedGroups.value.has(id)));

function toggleGroup(id: SyncGroupId) {
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
}

function expandGroup(id: SyncGroupId) {
  if (!collapsedGroups.value.has(id)) return;
  const next = new Set(collapsedGroups.value);
  next.delete(id);
  collapsedGroups.value = next;
}

function toggleAllGroups() {
  collapsedGroups.value = allGroupsCollapsed.value ? new Set() : new Set(SYNC_GROUP_IDS);
}

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
  tabMaxWidth: "appearance",
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

const savedSqlSummary = computed(() => {
  const catalog = props.catalog;
  return {
    selected: ids("savedSqlFolders").length + ids("savedSqlFiles").length,
    total: (catalog?.savedSqlFolders.length ?? 0) + (catalog?.savedSqlFiles.length ?? 0),
  };
});

const settingsSummary = computed(() => {
  let selected = 0;
  let total = 0;
  for (const category of backupSettingsCategories.value) {
    selected += category.selected;
    total += category.total;
  }
  return { selected, total };
});

// Connection/tunnel credentials render under their own groups but are encrypted items too, so the group aggregate counts all five buckets.
// Selected counts intersect with the catalog: a saved selection can keep ids that the snapshot does not actually carry (e.g. connections
// exported as secret-eligible that had no stored password), and those are not restorable items.
const secretsSummary = computed(() => {
  const catalog = props.catalog;
  if (!catalog) return { selected: 0, total: 0 };
  const aiTotal = catalog.aiConfigs.length;
  const pluginTotal = catalog.pluginUiStorage.length;
  const aiSelected = selection.value.aiConfigs === undefined ? aiTotal : catalog.aiConfigs.filter((item) => selection.value.aiConfigs?.includes(item.id)).length;
  const pluginSelected = selection.value.pluginUiStorage === undefined ? pluginTotal : catalog.pluginUiStorage.filter((item) => selection.value.pluginUiStorage?.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key)).length;
  const selected = catalog.connectionSecrets.filter((id) => selection.value.connectionSecrets?.includes(id)).length + catalog.tunnelSecrets.filter((id) => selection.value.tunnelSecrets?.includes(id)).length + (selection.value.syncCredentials ? 1 : 0) + aiSelected + pluginSelected;
  const total = catalog.connectionSecrets.length + catalog.tunnelSecrets.length + 1 + aiTotal + pluginTotal;
  return { selected, total };
});

// Connection/tunnel credentials render per-item under their own groups; the aggregate rows inside
// the encrypted group exist so the group header count adds up to its visible children.
const connectionSecretsSummary = computed(() => ({
  selected: props.catalog?.connectionSecrets.filter((id) => selection.value.connectionSecrets?.includes(id)).length ?? 0,
  total: props.catalog?.connectionSecrets.length ?? 0,
}));

const tunnelSecretsSummary = computed(() => ({
  selected: props.catalog?.tunnelSecrets.filter((id) => selection.value.tunnelSecrets?.includes(id)).length ?? 0,
  total: props.catalog?.tunnelSecrets.length ?? 0,
}));

const workspaceSummary = computed(() => {
  const catalog = props.catalog;
  if (!catalog) return { selected: 0, total: 0 };
  return {
    selected: (selection.value.sidebarLayout ? 1 : 0) + (selection.value.pinnedTreeNodeIds ? 1 : 0),
    total: (catalog.hasSidebarLayout ? 1 : 0) + (catalog.hasPinnedTreeNodeIds ? 1 : 0),
  };
});

// Locked encrypted items use `undefined` to mean "include all of the remote data", so they count as selected via secretsSummary.
const hasAnySelection = computed(() => {
  const s = selection.value;
  return !!(s.connections?.length || s.tunnelProfiles?.length || s.savedSqlFolders?.length || s.savedSqlFiles?.length || s.desktopSettings?.length || s.editorSettings?.length || s.sidebarLayout || s.pinnedTreeNodeIds || secretsSummary.value.selected);
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
  const secretsAvailable = !secretsUnavailable.value;
  const desktopSettings = selectableDesktopSettings(catalog);
  const editorSettings = selectableEditorSettings(catalog);
  selection.value = {
    ...emptySelection(),
    connections: saved?.connections ?? catalog.connections.map((item) => item.id),
    connectionSecrets: secretsAvailable ? (saved?.connectionSecrets ?? (catalog.hasEncryptedSecrets ? catalog.connectionSecrets : [])) : [],
    tunnelProfiles: saved?.tunnelProfiles ?? catalog.tunnelProfiles.map((item) => item.id),
    tunnelSecrets: secretsAvailable ? (saved?.tunnelSecrets ?? (catalog.hasEncryptedSecrets ? catalog.tunnelSecrets : [])) : [],
    savedSqlFolders: saved?.savedSqlFolders ?? catalog.savedSqlFolders.map((item) => item.id),
    savedSqlFiles: saved?.savedSqlFiles ?? catalog.savedSqlFiles.map((item) => item.id),
    desktopSettings: selectedSettings(saved?.desktopSettings, desktopSettings),
    editorSettings: selectedSettings(saved?.editorSettings, editorSettings),
    aiConfigs: secretsAvailable ? (saved?.aiConfigs ?? (catalog.aiConfigsLocked ? undefined : catalog.aiConfigs.map((item) => item.id))) : [],
    // While locked the plugin items cannot be enumerated, so the selection is an aggregate "include all" flag.
    // The encrypted blob only contains what the saved selection covered, so `undefined` restores the same data.
    // `[]` (not `undefined`) when no passphrase is available: `undefined` would mean "include all".
    pluginUiStorage: secretsAvailable ? (catalog.pluginUiStorageLocked ? undefined : (saved?.pluginUiStorage ?? catalog.pluginUiStorage)) : [],
    sidebarLayout: saved?.sidebarLayout ?? catalog.hasSidebarLayout,
    pinnedTreeNodeIds: saved?.pinnedTreeNodeIds ?? catalog.hasPinnedTreeNodeIds,
    includeSecrets: secretsAvailable && (saved?.includeSecrets ?? (isRestore.value ? catalog.hasEncryptedSecrets : !!props.defaultIncludeSecrets)),
    syncCredentials: secretsAvailable && (saved?.syncCredentials ?? (isRestore.value ? catalog.hasEncryptedSecrets : !!props.defaultIncludeSecrets)),
  };
  if (selection.value.includeSecrets && !saved) fillMissingSecrets();
}

watch(
  () => [props.open, props.catalog] as const,
  ([open]) => {
    if (open) {
      localExportPathRequired.value = false;
      collapsedGroups.value = new Set(SYNC_GROUP_IDS);
      resetFromCatalog();
    }
  },
  { immediate: true },
);

function ids(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs") {
  return selection.value[key] ?? [];
}

function allSelected(key: "connections" | "tunnelProfiles" | "savedSqlFolders" | "savedSqlFiles" | "aiConfigs", items: SyncCatalogItem[]) {
  return items.length > 0 && items.every((item) => ids(key).includes(item.id));
}

type SelectionState = "none" | "partial" | "all";

function selectionState(key: "connections" | "tunnelProfiles" | "savedSqlFolders" | "savedSqlFiles" | "aiConfigs", items: SyncCatalogItem[]): SelectionState {
  const selected = ids(key);
  const count = items.reduce((total, item) => total + (selected.includes(item.id) ? 1 : 0), 0);
  return count === 0 ? "none" : count === items.length ? "all" : "partial";
}

function summaryState(summary: { selected: number; total: number }): SelectionState {
  if (summary.total === 0 || summary.selected === 0) return "none";
  return summary.selected === summary.total ? "all" : "partial";
}

const aiConfigsState = computed<SelectionState>(() => {
  const catalog = props.catalog;
  if (!catalog) return "none";
  if (selection.value.aiConfigs === undefined) return catalog.aiConfigs.length === 0 ? "none" : "all";
  return selectionState("aiConfigs", catalog.aiConfigs);
});

const pluginUiStorageState = computed<SelectionState>(() => {
  const catalog = props.catalog;
  if (!catalog) return "none";
  const selected = selection.value.pluginUiStorage;
  const total = catalog.pluginUiStorage.length;
  if (selected === undefined) return total === 0 ? "none" : "all";
  const count = catalog.pluginUiStorage.filter((item) => selected.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key)).length;
  return count === 0 ? "none" : count === total ? "all" : "partial";
});

const pluginUiGroups = computed(() => {
  const catalog = props.catalog;
  if (!catalog) return [];
  const groups = new Map<string, { pluginId: string; name: string; items: PluginUiStorageItemRef[] }>();
  for (const item of catalog.pluginUiStorage) {
    let group = groups.get(item.pluginId);
    if (!group) {
      group = { pluginId: item.pluginId, name: item.pluginName || item.pluginId, items: [] };
      groups.set(item.pluginId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
});

// A locked selection is `undefined` and means "include all", so every item counts as selected.
function pluginGroupSelected(group: { items: PluginUiStorageItemRef[] }) {
  const selected = selection.value.pluginUiStorage;
  if (selected === undefined) return group.items.length;
  return group.items.filter((item) => selected.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key)).length;
}

function pluginGroupState(group: { items: PluginUiStorageItemRef[] }): SelectionState {
  const selected = pluginGroupSelected(group);
  return selected === 0 ? "none" : selected === group.items.length ? "all" : "partial";
}

// Deselecting a connection/tunnel also drops its credentials: a kept secret id would stay counted
// in the encrypted aggregate even though its owner is no longer part of the backup.
function pruneOrphanSecrets(key: "connections" | "tunnelProfiles") {
  const secretsKey = key === "connections" ? "connectionSecrets" : "tunnelSecrets";
  const owners = new Set(ids(key));
  const kept = ids(secretsKey).filter((id) => owners.has(id));
  if (kept.length !== ids(secretsKey).length) {
    selection.value[secretsKey] = kept;
    syncIncludeSecrets();
  }
}

function toggleId(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", id: string) {
  const current = ids(key);
  const removing = current.includes(id);
  selection.value[key] = removing ? current.filter((item) => item !== id) : [...current, id];
  if (removing && (key === "connections" || key === "tunnelProfiles")) pruneOrphanSecrets(key);
}

function toggleAll(key: "connections" | "tunnelProfiles" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", items: SyncCatalogItem[]) {
  const current = ids(key);
  const isAllSelected = items.length > 0 && items.every((item) => current.includes(item.id));
  selection.value[key] = isAllSelected ? [] : items.map((item) => item.id);
  if (isAllSelected && (key === "connections" || key === "tunnelProfiles")) pruneOrphanSecrets(key);
}

function toggleSavedSql() {
  const catalog = props.catalog;
  if (!catalog) return;
  const include = summaryState(savedSqlSummary.value) !== "all";
  selection.value.savedSqlFolders = include ? catalog.savedSqlFolders.map((item) => item.id) : [];
  selection.value.savedSqlFiles = include ? catalog.savedSqlFiles.map((item) => item.id) : [];
}

function toggleAllSettings() {
  const catalog = props.catalog;
  if (!catalog) return;
  const include = summaryState(settingsSummary.value) !== "all";
  selection.value.desktopSettings = include ? selectableDesktopSettings(catalog).map((item) => item.id) : [];
  selection.value.editorSettings = include ? selectableEditorSettings(catalog).map((item) => item.id) : [];
}

function toggleWorkspace() {
  const catalog = props.catalog;
  if (!catalog) return;
  const include = summaryState(workspaceSummary.value) !== "all";
  selection.value.sidebarLayout = include && catalog.hasSidebarLayout;
  selection.value.pinnedTreeNodeIds = include && catalog.hasPinnedTreeNodeIds;
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

function togglePluginItem(pluginId: string, key: string, event: Event) {
  const current = selection.value.pluginUiStorage ?? [];
  const exists = current.some((item) => item.pluginId === pluginId && item.key === key);
  if (!exists && !ensureSecretsEnabled()) {
    // State did not change, so Vue will not re-sync the checkbox the user just flipped; revert it manually.
    (event.target as HTMLInputElement).checked = false;
    return;
  }
  selection.value.pluginUiStorage = exists ? current.filter((item) => item.pluginId !== pluginId || item.key !== key) : [...current, props.catalog?.pluginUiStorage.find((item) => item.pluginId === pluginId && item.key === key)!];
  syncIncludeSecrets();
}

function togglePluginGroup(pluginId: string, event: Event) {
  const catalog = props.catalog;
  if (!catalog) return;
  const items = catalog.pluginUiStorage.filter((item) => item.pluginId === pluginId);
  const current = selection.value.pluginUiStorage ?? [];
  const allSelected = items.length > 0 && items.every((item) => current.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key));
  if (!allSelected && !ensureSecretsEnabled()) {
    // State did not change, so Vue will not re-sync the checkbox the user just flipped; revert it manually.
    const input = event.target as HTMLInputElement;
    input.checked = false;
    input.indeterminate = pluginGroupState({ items }) === "partial";
    return;
  }
  const rest = current.filter((entry) => entry.pluginId !== pluginId);
  selection.value.pluginUiStorage = allSelected ? rest : [...rest, ...items];
  syncIncludeSecrets();
}

function togglePluginAll() {
  if (props.catalog?.pluginUiStorageLocked) {
    selection.value.pluginUiStorage = selection.value.pluginUiStorage === undefined ? [] : undefined;
    syncIncludeSecrets();
    return;
  }
  const all = props.catalog?.pluginUiStorage ?? [];
  selection.value.pluginUiStorage = selection.value.pluginUiStorage?.length === all.length ? [] : [...all];
  syncIncludeSecrets();
}

function toggleAllAiConfigs() {
  if (props.catalog?.aiConfigsLocked) {
    selection.value.aiConfigs = selection.value.aiConfigs === undefined ? [] : undefined;
    syncIncludeSecrets();
    return;
  }
  toggleAll("aiConfigs", props.catalog?.aiConfigs ?? []);
  syncIncludeSecrets();
}

// The aggregate credential rows toggle every connection/tunnel secret id at once, under the same
// passphrase gate as the other encrypted items.
function toggleSecretIdsAll(key: "connectionSecrets" | "tunnelSecrets", event: Event) {
  const catalogIds = (key === "connectionSecrets" ? props.catalog?.connectionSecrets : props.catalog?.tunnelSecrets) ?? [];
  // Credentials of deselected connections/tunnels are filtered out server-side (metadata_ids),
  // so the aggregate row must only select ids whose owner row is still selected.
  const ownerIds = ids(key === "connectionSecrets" ? "connections" : "tunnelProfiles");
  const selectableIds = catalogIds.filter((id) => ownerIds.includes(id));
  const current = ids(key);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => current.includes(id));
  if (!allSelected && !ensureSecretsEnabled()) {
    // State did not change, so Vue will not re-sync the checkbox the user just flipped; revert it manually.
    const input = event.target as HTMLInputElement;
    input.checked = false;
    input.indeterminate = summaryState(key === "connectionSecrets" ? connectionSecretsSummary.value : tunnelSecretsSummary.value) === "partial";
    return;
  }
  selection.value[key] = allSelected ? [] : [...selectableIds];
  syncIncludeSecrets();
}

// The encrypted group checkbox is an aggregate over its items: locked `undefined` selections count as "include all".
function secretsLeafSelected(): boolean {
  const s = selection.value;
  return !!(s.connectionSecrets?.length || s.tunnelSecrets?.length || s.syncCredentials || s.aiConfigs === undefined || (s.aiConfigs?.length ?? 0) > 0 || s.pluginUiStorage === undefined || (s.pluginUiStorage?.length ?? 0) > 0);
}

function syncIncludeSecrets() {
  selection.value.includeSecrets = secretsLeafSelected();
}

function setAllSecretsItems() {
  const catalog = props.catalog;
  if (!catalog) return;
  selection.value.connectionSecrets = [...catalog.connectionSecrets];
  selection.value.tunnelSecrets = [...catalog.tunnelSecrets];
  selection.value.aiConfigs = catalog.aiConfigsLocked ? undefined : catalog.aiConfigs.map((item) => item.id);
  selection.value.pluginUiStorage = catalog.pluginUiStorageLocked ? undefined : [...catalog.pluginUiStorage];
  selection.value.syncCredentials = true;
  selection.value.includeSecrets = true;
}

function clearAllSecretsItems() {
  selection.value.connectionSecrets = [];
  selection.value.tunnelSecrets = [];
  selection.value.aiConfigs = [];
  selection.value.pluginUiStorage = [];
  selection.value.syncCredentials = false;
  selection.value.includeSecrets = false;
}

function fillMissingSecrets() {
  const catalog = props.catalog;
  if (!catalog) return;
  if (!selection.value.connectionSecrets?.length) selection.value.connectionSecrets = [...catalog.connectionSecrets];
  if (!selection.value.tunnelSecrets?.length) selection.value.tunnelSecrets = [...catalog.tunnelSecrets];
  if (!selection.value.aiConfigs?.length && catalog.aiConfigs.length) selection.value.aiConfigs = catalog.aiConfigs.map((item) => item.id);
  if (!selection.value.pluginUiStorage?.length && !catalog.pluginUiStorageLocked) selection.value.pluginUiStorage = [...catalog.pluginUiStorage];
  selection.value.syncCredentials = true;
}

function onSecretsGroupChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  if (secretsUnavailable.value) {
    // Nothing inside can be selected without a passphrase; open the group so the hint explains why.
    input.checked = false;
    expandGroup("secrets");
    return;
  }
  if (summaryState(secretsSummary.value) === "all") {
    clearAllSecretsItems();
    return;
  }
  if (!ensureSecretsEnabled()) {
    // State did not change, so Vue will not re-sync the checkbox the user just flipped; revert it manually.
    input.checked = false;
    input.indeterminate = summaryState(secretsSummary.value) === "partial";
    return;
  }
  setAllSecretsItems();
}

// A secrets child can only take effect when the encrypted section is enabled; checking one turns the master switch on
// (same passphrase guard as the master checkbox), while unchecking stays allowed.
function ensureSecretsEnabled(): boolean {
  if (selection.value.includeSecrets) return true;
  if (secretsUnavailable.value) return false;
  selection.value.includeSecrets = true;
  return true;
}

function toggleSecretId(key: "connectionSecrets" | "tunnelSecrets" | "aiConfigs", id: string, event: Event) {
  if (!checked(key, id) && !ensureSecretsEnabled()) {
    // State did not change, so Vue will not re-sync the checkbox the user just flipped; revert it manually.
    (event.target as HTMLInputElement).checked = false;
    return;
  }
  toggleId(key, id);
  syncIncludeSecrets();
}

function onSyncCredentialsChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.checked && !ensureSecretsEnabled()) {
    input.checked = false;
    return;
  }
  selection.value.syncCredentials = input.checked;
  syncIncludeSecrets();
}

function onAiConfigsToggleAll(event: Event) {
  if (aiConfigsState.value === "all" || ensureSecretsEnabled()) {
    toggleAllAiConfigs();
    return;
  }
  (event.target as HTMLInputElement).checked = false;
}

function onPluginToggleAll(event: Event) {
  if (pluginUiStorageState.value === "all" || ensureSecretsEnabled()) {
    togglePluginAll();
    return;
  }
  (event.target as HTMLInputElement).checked = false;
}

function checked(key: "connections" | "connectionSecrets" | "tunnelProfiles" | "tunnelSecrets" | "savedSqlFolders" | "savedSqlFiles" | "desktopSettings" | "editorSettings" | "aiConfigs", id: string) {
  return ids(key).includes(id);
}

function selectAllItems() {
  const catalog = props.catalog;
  if (!catalog) return;
  // Encrypted items only make sense when the snapshot has them (restore) and the passphrase is available;
  // otherwise expand the encrypted group so its hint explains what was skipped.
  const wantsSecrets = !isRestore.value || catalog.hasEncryptedSecrets;
  const secretsAvailable = wantsSecrets && props.secretsPassphraseAvailable !== false;
  if (wantsSecrets && !secretsAvailable) expandGroup("secrets");
  selection.value = {
    connections: catalog.connections.map((item) => item.id),
    connectionSecrets: secretsAvailable ? [...catalog.connectionSecrets] : [],
    tunnelProfiles: catalog.tunnelProfiles.map((item) => item.id),
    tunnelSecrets: secretsAvailable ? [...catalog.tunnelSecrets] : [],
    savedSqlFolders: catalog.savedSqlFolders.map((item) => item.id),
    savedSqlFiles: catalog.savedSqlFiles.map((item) => item.id),
    desktopSettings: selectableDesktopSettings(catalog).map((item) => item.id),
    editorSettings: selectableEditorSettings(catalog).map((item) => item.id),
    // Locked encrypted sections cannot enumerate remote items; undefined means "include all" there.
    aiConfigs: secretsAvailable ? (catalog.aiConfigsLocked ? undefined : catalog.aiConfigs.map((item) => item.id)) : [],
    pluginUiStorage: secretsAvailable ? (catalog.pluginUiStorageLocked ? undefined : [...catalog.pluginUiStorage]) : [],
    sidebarLayout: catalog.hasSidebarLayout,
    pinnedTreeNodeIds: catalog.hasPinnedTreeNodeIds,
    includeSecrets: secretsAvailable,
    syncCredentials: secretsAvailable,
  };
}

function deselectAllItems() {
  selection.value = emptySelection();
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

      <div v-if="catalog" class="flex shrink-0 items-center gap-1 border-b px-4 py-2">
        <Button variant="ghost" size="xs" @click="selectAllItems">
          <ListChecks />
          {{ t("settings.syncSelectionSelectAll") }}
        </Button>
        <Button variant="ghost" size="xs" @click="deselectAllItems">
          <ListX />
          {{ t("settings.syncSelectionDeselectAll") }}
        </Button>
        <Button variant="ghost" size="xs" class="ml-auto" @click="toggleAllGroups">
          <UnfoldVertical v-if="allGroupsCollapsed" />
          <FoldVertical v-else />
          {{ allGroupsCollapsed ? t("settings.syncSelectionExpandAll") : t("settings.syncSelectionCollapseAll") }}
        </Button>
      </div>

      <div v-if="catalog" class="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
        <details :open="!collapsedGroups.has('connections')" class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('connections')">
            <input
              :checked="allSelected('connections', catalog.connections)"
              :indeterminate="selectionState('connections', catalog.connections) === 'partial'"
              :disabled="!catalog.connections.length"
              type="checkbox"
              class="size-4 accent-primary"
              @click.stop
              @change="toggleAll('connections', catalog.connections)"
            />
            <span>{{ t("settings.syncSelectionConnections") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ selection.connections?.length ?? 0 }}/{{ catalog.connections.length }}</span>
            <ChevronDown v-if="!collapsedGroups.has('connections')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
          <div class="ml-6 space-y-1 pb-2">
            <p v-if="secretsUnavailable && catalog.connectionSecrets.length" class="py-1 text-xs text-destructive">
              {{ t("settings.localBackupSecretsPassphraseRequiredHint") }}
            </p>
            <div v-for="item in catalog.connections" :key="item.id" class="py-1">
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="checked('connections', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('connections', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
              <label v-if="!secretsUnavailable && catalog.connectionSecrets.includes(item.id)" class="ml-6 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                <input :checked="checked('connectionSecrets', item.id)" :disabled="!selection.connections?.includes(item.id)" type="checkbox" class="size-3.5 accent-primary" @change="toggleSecretId('connectionSecrets', item.id, $event)" />
                <span>{{ t("settings.syncSelectionConnectionSecrets") }}</span>
              </label>
            </div>
            <p v-if="!catalog.connections.length" class="py-1 text-xs text-muted-foreground">{{ t("settings.syncSelectionNoConnections") }}</p>
          </div>
        </details>

        <details :open="!collapsedGroups.has('tunnels')" class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('tunnels')">
            <input
              :checked="allSelected('tunnelProfiles', catalog.tunnelProfiles)"
              :indeterminate="selectionState('tunnelProfiles', catalog.tunnelProfiles) === 'partial'"
              :disabled="!catalog.tunnelProfiles.length"
              type="checkbox"
              class="size-4 accent-primary"
              @click.stop
              @change="toggleAll('tunnelProfiles', catalog.tunnelProfiles)"
            />
            <span>{{ t("settings.syncSelectionTunnels") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ selection.tunnelProfiles?.length ?? 0 }}/{{ catalog.tunnelProfiles.length }}</span>
            <ChevronDown v-if="!collapsedGroups.has('tunnels')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
          <div class="ml-6 space-y-1 pb-2">
            <p v-if="secretsUnavailable && catalog.tunnelSecrets.length" class="py-1 text-xs text-destructive">
              {{ t("settings.localBackupSecretsPassphraseRequiredHint") }}
            </p>
            <div v-for="item in catalog.tunnelProfiles" :key="item.id" class="py-1">
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="checked('tunnelProfiles', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('tunnelProfiles', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
              <label v-if="!secretsUnavailable && catalog.tunnelSecrets.includes(item.id)" class="ml-6 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                <input :checked="checked('tunnelSecrets', item.id)" :disabled="!selection.tunnelProfiles?.includes(item.id)" type="checkbox" class="size-3.5 accent-primary" @change="toggleSecretId('tunnelSecrets', item.id, $event)" />
                <span>{{ t("settings.syncSelectionTunnelSecrets") }}</span>
              </label>
            </div>
            <p v-if="!catalog.tunnelProfiles.length" class="py-1 text-xs text-muted-foreground">{{ t("settings.syncSelectionNoTunnels") }}</p>
          </div>
        </details>

        <details :open="!collapsedGroups.has('savedSql')" class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('savedSql')">
            <input :checked="summaryState(savedSqlSummary) === 'all'" :indeterminate="summaryState(savedSqlSummary) === 'partial'" :disabled="!savedSqlSummary.total" type="checkbox" class="size-4 accent-primary" @click.stop @change="toggleSavedSql" />
            <span>{{ t("settings.syncSelectionSavedSql") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ savedSqlSummary.selected }}/{{ savedSqlSummary.total }}</span>
            <ChevronDown v-if="!collapsedGroups.has('savedSql')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
          <div class="ml-6 space-y-2 pb-2">
            <div>
              <label class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                <input
                  :checked="allSelected('savedSqlFolders', catalog.savedSqlFolders)"
                  :indeterminate="selectionState('savedSqlFolders', catalog.savedSqlFolders) === 'partial'"
                  :disabled="!catalog.savedSqlFolders.length"
                  type="checkbox"
                  class="size-3.5 accent-primary"
                  @change="toggleAll('savedSqlFolders', catalog.savedSqlFolders)"
                />
                <span>{{ t("settings.syncSelectionFolders") }} ({{ selection.savedSqlFolders?.length ?? 0 }}/{{ catalog.savedSqlFolders.length }})</span>
              </label>
              <label v-for="item in catalog.savedSqlFolders" :key="item.id" class="flex min-h-7 items-center gap-2 pl-1 text-sm">
                <input :checked="checked('savedSqlFolders', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('savedSqlFolders', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
            </div>
            <div>
              <label class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                <input
                  :checked="allSelected('savedSqlFiles', catalog.savedSqlFiles)"
                  :indeterminate="selectionState('savedSqlFiles', catalog.savedSqlFiles) === 'partial'"
                  :disabled="!catalog.savedSqlFiles.length"
                  type="checkbox"
                  class="size-3.5 accent-primary"
                  @change="toggleAll('savedSqlFiles', catalog.savedSqlFiles)"
                />
                <span>{{ t("settings.syncSelectionFiles") }} ({{ selection.savedSqlFiles?.length ?? 0 }}/{{ catalog.savedSqlFiles.length }})</span>
              </label>
              <label v-for="item in catalog.savedSqlFiles" :key="item.id" class="flex min-h-7 items-center gap-2 pl-1 text-sm">
                <input :checked="checked('savedSqlFiles', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleId('savedSqlFiles', item.id)" />
                <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
              </label>
            </div>
          </div>
        </details>

        <details :open="!collapsedGroups.has('settings')" class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('settings')">
            <input :checked="summaryState(settingsSummary) === 'all'" :indeterminate="summaryState(settingsSummary) === 'partial'" :disabled="!settingsSummary.total" type="checkbox" class="size-4 accent-primary" @click.stop @change="toggleAllSettings" />
            <span>{{ t("settings.syncSelectionPersonalSettings") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ settingsSummary.selected }}/{{ settingsSummary.total }}</span>
            <ChevronDown v-if="!collapsedGroups.has('settings')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
          <div class="ml-6 space-y-1 py-2">
            <label v-for="category in backupSettingsCategories" :key="category.id" class="flex min-h-7 items-center gap-2 text-sm">
              <input :checked="category.total > 0 && category.selected === category.total" :indeterminate="category.selected > 0 && category.selected < category.total" type="checkbox" class="size-4 accent-primary" @change="toggleSettingsCategory(category.id)" />
              <span>{{ t(category.labelKey) }}</span>
              <span class="ml-auto text-xs text-muted-foreground">{{ category.selected }}/{{ category.total }}</span>
            </label>
          </div>
        </details>

        <details :open="!collapsedGroups.has('secrets')" class="border-b pb-2">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('secrets')">
            <input :checked="summaryState(secretsSummary) === 'all'" :indeterminate="summaryState(secretsSummary) === 'partial'" type="checkbox" class="size-4 accent-primary" @click.stop @change="onSecretsGroupChanged($event)" />
            <span>{{ t("settings.syncSelectionEncrypted") }}</span>
            <Lock v-if="secretsUnavailable" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="ml-auto text-xs text-muted-foreground">{{ secretsSummary.selected }}/{{ secretsSummary.total }}</span>
            <ChevronDown v-if="!collapsedGroups.has('secrets')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
          <div class="ml-6 space-y-2 pb-2">
            <template v-if="secretsUnavailable">
              <p v-if="isRestore && !catalog.hasEncryptedSecrets" class="text-xs text-muted-foreground">
                {{ t("settings.syncSelectionNoEncrypted") }}
              </p>
              <p v-else role="alert" class="text-xs text-destructive">
                {{ t("settings.localBackupSecretsPassphraseRequiredHint") }}
              </p>
            </template>
            <template v-else>
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="selection.syncCredentials" type="checkbox" class="size-4 accent-primary" @change="onSyncCredentialsChanged($event)" />
                <span>{{ t("settings.syncSelectionSyncCredentials") }}</span>
              </label>
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input
                  :checked="summaryState(connectionSecretsSummary) === 'all'"
                  :indeterminate="summaryState(connectionSecretsSummary) === 'partial'"
                  :disabled="!connectionSecretsSummary.total"
                  type="checkbox"
                  class="size-4 accent-primary"
                  @change="toggleSecretIdsAll('connectionSecrets', $event)"
                />
                <span>{{ t("settings.syncSelectionConnectionCredentials") }} ({{ connectionSecretsSummary.selected }}/{{ connectionSecretsSummary.total }})</span>
              </label>
              <label class="flex min-h-7 items-center gap-2 text-sm">
                <input :checked="summaryState(tunnelSecretsSummary) === 'all'" :indeterminate="summaryState(tunnelSecretsSummary) === 'partial'" :disabled="!tunnelSecretsSummary.total" type="checkbox" class="size-4 accent-primary" @change="toggleSecretIdsAll('tunnelSecrets', $event)" />
                <span>{{ t("settings.syncSelectionTunnelSecrets") }} ({{ tunnelSecretsSummary.selected }}/{{ tunnelSecretsSummary.total }})</span>
              </label>
              <div>
                <label v-if="catalog.aiConfigsLocked" class="flex min-h-7 items-center gap-2 text-sm">
                  <input :checked="selection.aiConfigs === undefined" type="checkbox" class="size-4 accent-primary" @change="onAiConfigsToggleAll($event)" />
                  <span>{{ t("settings.syncSelectionAiLocked") }}</span>
                </label>
                <template v-else>
                  <label class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <input :checked="aiConfigsState === 'all'" :indeterminate="aiConfigsState === 'partial'" :disabled="!catalog.aiConfigs.length" type="checkbox" class="size-3.5 accent-primary" @change="onAiConfigsToggleAll($event)" />
                    <span>{{ t("settings.syncSelectionAiConfigs") }} ({{ selection.aiConfigs?.length ?? 0 }}/{{ catalog.aiConfigs.length }})</span>
                  </label>
                  <label v-for="item in catalog.aiConfigs" :key="item.id" class="flex min-h-7 items-center gap-2 text-sm">
                    <input :checked="checked('aiConfigs', item.id)" type="checkbox" class="size-4 accent-primary" @change="toggleSecretId('aiConfigs', item.id, $event)" />
                    <span class="min-w-0 truncate">{{ item.label || item.id }}</span>
                  </label>
                </template>
              </div>
              <div>
                <label v-if="catalog.pluginUiStorageLocked" class="flex min-h-7 items-center gap-2 text-sm">
                  <input :checked="selection.pluginUiStorage === undefined" type="checkbox" class="size-4 accent-primary" @change="onPluginToggleAll($event)" />
                  <span>{{ t("settings.syncSelectionPluginLocked") }}</span>
                </label>
                <template v-else>
                  <label class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <input :checked="pluginUiStorageState === 'all'" :indeterminate="pluginUiStorageState === 'partial'" :disabled="!catalog.pluginUiStorage.length" type="checkbox" class="size-3.5 accent-primary" @change="onPluginToggleAll($event)" />
                    <span>{{ t("settings.syncSelectionPluginData") }} ({{ selection.pluginUiStorage?.length ?? 0 }}/{{ catalog.pluginUiStorage.length }})</span>
                  </label>
                  <div v-for="group in pluginUiGroups" :key="group.pluginId" class="pl-1">
                    <label class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                      <input :checked="pluginGroupState(group) === 'all'" :indeterminate="pluginGroupState(group) === 'partial'" type="checkbox" class="size-3.5 accent-primary" @change="togglePluginGroup(group.pluginId, $event)" />
                      <span class="min-w-0 truncate">{{ group.name }} ({{ pluginGroupSelected(group) }}/{{ group.items.length }})</span>
                    </label>
                    <label v-for="item in group.items" :key="item.key" class="flex min-h-7 items-center gap-2 pl-3 text-sm">
                      <input :checked="selection.pluginUiStorage?.some((entry) => entry.pluginId === item.pluginId && entry.key === item.key)" type="checkbox" class="size-4 accent-primary" @change="togglePluginItem(item.pluginId, item.key, $event)" />
                      <span class="min-w-0 truncate">{{ item.key }}</span>
                    </label>
                  </div>
                  <p v-if="!catalog.pluginUiStorage.length" class="text-xs text-muted-foreground">{{ t("settings.syncSelectionNoPluginData") }}</p>
                </template>
              </div>
              <p v-if="!catalog.hasEncryptedSecrets && isRestore" class="text-xs text-muted-foreground">{{ t("settings.syncSelectionNoEncrypted") }}</p>
            </template>
          </div>
        </details>

        <details :open="!collapsedGroups.has('workspace')" class="pb-1">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium" @click.prevent="toggleGroup('workspace')">
            <input :checked="summaryState(workspaceSummary) === 'all'" :indeterminate="summaryState(workspaceSummary) === 'partial'" :disabled="!workspaceSummary.total" type="checkbox" class="size-4 accent-primary" @click.stop @change="toggleWorkspace" />
            <span>{{ t("settings.syncSelectionWorkspace") }}</span>
            <span class="ml-auto text-xs text-muted-foreground">{{ workspaceSummary.selected }}/{{ workspaceSummary.total }}</span>
            <ChevronDown v-if="!collapsedGroups.has('workspace')" class="size-4 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="size-4 shrink-0 text-muted-foreground" />
          </summary>
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
        <Button :disabled="!catalog || !hasAnySelection" @click="confirmSelection">{{ isRestore ? t("settings.syncSelectionRestoreAction") : t("settings.syncSelectionUploadAction") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
