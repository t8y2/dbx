<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Cable, Command, Database, FileCode, FileText, FolderPlus, Layers3, Search, Server, SlidersHorizontal, Table2, Terminal, X } from "@lucide/vue";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import GlobalSearchCategoryBar from "./GlobalSearchCategoryBar.vue";
import GlobalSearchHome from "./GlobalSearchHome.vue";
import GlobalSearchPreview from "./GlobalSearchPreview.vue";
import GlobalSearchResultList from "./GlobalSearchResultList.vue";
import GlobalSearchScopeRail from "./GlobalSearchScopeRail.vue";
import { useQuickOpen, type QuickOpenItem } from "@/composables/useQuickOpen";
import { usePluginCommandPalette } from "@/lib/plugins/pluginCommandPalette";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";
import { parseQuickSearchQuery, quickSearchCategory as itemCategory, type QuickSearchCategory as SearchCategory } from "@/lib/quickOpen/quickSearch";
import { getGlobalSearchRoots, saveGlobalSearchRoots, getGlobalSearchExtensions, saveGlobalSearchExtensions } from "@/lib/globalSearch/globalSearchSettings";

const QuickOpenFilePreview = defineAsyncComponent(() => import("./QuickOpenFilePreview.vue"));

const props = defineProps<{
  open: boolean;
  /** When true, start in content (full-text) search mode on open. */
  initialContentMode?: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [item: QuickOpenItem];
}>();

const { t } = useI18n();
// Plugin commandPalette commands (HOST_PLUGIN_UI_SPEC §5): injected as extra quick-open entries;
// list refresh is driven by dbx:plugins-changed / focus / locale change, with a fallback refresh when the dialog opens.
const pluginPalette = usePluginCommandPalette();
const { toast } = useToast();
const activeCategory = ref<SearchCategory>("all");
const {
  searchQuery,
  matchingItems,
  filteredItems,
  homeItems,
  selectedIndex,
  selectedItem,
  selectNext,
  selectPrevious,
  setQuery,
  recordRecentItem,
  loadExternalSqlFiles,
  loadPluginWorkbenches,
  contentMode,
  contentGroups,
  contentSelectedItem,
  contentSearching,
  contentSearchError,
  retryContentSearch,
  setContentMode: setSearchContentMode,
  cancelSearch,
  scopeConnectionIds,
  scopeActive,
  setScopeConnectionIds,
} = useQuickOpen({ extraItems: pluginPalette.items, category: activeCategory, enabled: computed(() => props.open) });
const previewEditing = ref(false);
const pinnedPreviewItem = ref<QuickOpenItem | null>(null);

const categoryDefinitions: Array<{ id: SearchCategory; label: string; icon: typeof Server }> = [
  { id: "all", label: "quickOpen.categoryAll", icon: Layers3 },
  { id: "connections", label: "quickOpen.categoryConnections", icon: Cable },
  { id: "databases", label: "quickOpen.categoryDatabases", icon: Database },
  { id: "objects", label: "quickOpen.categoryObjects", icon: Table2 },
  { id: "fields", label: "quickOpen.categoryFields", icon: Layers3 },
  { id: "files", label: "quickOpen.categoryFiles", icon: FileCode },
  { id: "content", label: "quickOpen.categoryContent", icon: Search },
  { id: "commands", label: "quickOpen.categoryCommands", icon: Terminal },
];

const categoryCounts = computed(() => {
  const counts = Object.fromEntries(categoryDefinitions.map(({ id }) => [id, 0])) as Record<SearchCategory, number>;
  counts.all = matchingItems.value.length;
  for (const item of matchingItems.value) counts[itemCategory(item)] += 1;
  counts.content = contentMatchCount.value;
  return counts;
});

const visibleItems = filteredItems;
const isHomeView = computed(() => !contentMode.value && !searchQuery.value.trim() && activeCategory.value === "all");
const homeSelectedId = ref<string | null>(null);
const displayItems = computed(() => (isHomeView.value ? homeItems.value : visibleItems.value));
const selectedDisplayItem = computed(() => {
  if (isHomeView.value) return displayItems.value.find((item) => item.id === homeSelectedId.value) || displayItems.value[0] || null;
  if (activeCategory.value === "all") return selectedItem.value;
  return visibleItems.value.find((item) => item.id === selectedItem.value?.id) || visibleItems.value[0] || null;
});

function selectCategoryFromBar(category: string): void {
  if (categoryDefinitions.some((definition) => definition.id === category)) selectCategory(category as SearchCategory);
}

function selectCategory(category: SearchCategory): void {
  if (!canLeavePreview()) return;
  activeCategory.value = category;
  if (category === "content") {
    setContentMode(true, category);
    return;
  }
  if (contentMode.value) setContentMode(false, category);
  const first = category === "all" ? filteredItems.value[0] : filteredItems.value.find((item) => itemCategory(item) === category);
  selectedIndex.value = first ? filteredItems.value.findIndex((item) => item.id === first.id) : 0;
}

function navigateVisible(direction: -1 | 1): void {
  const items = displayItems.value;
  if (items.length === 0) return;
  const selectedId = selectedDisplayItem.value?.id;
  const current = items.findIndex((item) => item.id === selectedId);
  const next = current < 0 ? (direction > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, current + direction));
  if (isHomeView.value) homeSelectedId.value = items[next]!.id;
  const globalIndex = filteredItems.value.findIndex((item) => item.id === items[next]!.id);
  if (globalIndex >= 0) selectedIndex.value = globalIndex;
}

function appendSearchToken(token: string): void {
  if (!canLeavePreview()) return;
  setQuery(`${searchQuery.value.trim()} ${token}`.trim());
  nextTick(() => inputRef.value?.$el.focus());
}
const previewItem = computed(() => (previewEditing.value ? pinnedPreviewItem.value : contentMode.value ? contentSelectedItem.value : selectedDisplayItem.value));

function handlePreviewEditing(value: boolean): void {
  if (value) pinnedPreviewItem.value = contentSelectedItem.value ? { ...contentSelectedItem.value } : null;
  if (value) searchSettingsOpen.value = false;
  previewEditing.value = value;
}

function canLeavePreview(): boolean {
  if (!previewEditing.value) return true;
  toast(t("quickOpen.finishEditing"));
  return false;
}

function setContentMode(value: boolean, category?: SearchCategory): void {
  if (!canLeavePreview()) return;
  activeCategory.value = category ?? (value ? "content" : "all");
  setSearchContentMode(value);
}
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const listRef = ref<HTMLElement | null>(null);
const settingsStore = useSettingsStore();
const globalSearchShortcut = computed(() => formatShortcutDisplay(settingsStore.editorSettings.shortcuts.globalSearch || "Mod+Shift+F"));
const secondaryActionShortcut = computed(() => formatShortcutDisplay("Mod+Enter"));

// Search settings panel state (extra search roots and file extensions).
const searchSettingsOpen = ref(false);
const searchRoots = ref<string[]>([]);
const extensionsInput = ref("");
const parsedSearchQuery = computed(() => parseQuickSearchQuery(searchQuery.value));
const activeSearchFilters = computed(() => Object.entries(parsedSearchQuery.value.filters).filter(([, value]) => Boolean(value)) as Array<[string, string]>);

// Connection scope: empty selection = all connections.
const connectionStore = useConnectionStore();
const scopeConnections = computed(() => connectionStore.connections);
/** Select value for "all connections"; a real connection id never uses this sentinel. */
const SCOPE_ALL_VALUE = "__all_connections__";

const scopeSelection = computed<string>({
  get: () => (scopeActive.value && scopeConnectionIds.value.length === 1 ? scopeConnectionIds.value[0] : SCOPE_ALL_VALUE),
  set: (value) => {
    setScopeConnectionIds(value === SCOPE_ALL_VALUE ? [] : [value]);
  },
});

function refreshSearchSettings(): void {
  searchRoots.value = getGlobalSearchRoots();
  extensionsInput.value = getGlobalSearchExtensions().join(", ");
}

async function addSearchDirectory(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: true });
    if (!selected) return;
    const chosen = Array.isArray(selected) ? selected : [selected];
    const next = [...new Set([...searchRoots.value, ...chosen.filter((p): p is string => typeof p === "string")])];
    saveGlobalSearchRoots(next);
    refreshSearchSettings();
  } catch {
    // Native directory picker is only available inside the Tauri shell.
  }
}

function removeSearchRoot(root: string): void {
  saveGlobalSearchRoots(searchRoots.value.filter((r) => r !== root));
  refreshSearchSettings();
}

function saveExtensions(): void {
  const exts = extensionsInput.value
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^\.+/, "").toLowerCase())
    .filter((s) => s.length > 0);
  saveGlobalSearchExtensions(exts);
  refreshSearchSettings();
}

// Content mode exposes the same shared searchQuery; only featured results differ.

const contentMatchCount = computed(() => contentGroups.value.reduce((total, group) => total + group.matches.length, 0));

function getHighlightedLineParts(item: QuickOpenItem): Array<{ text: string; highlight: boolean }> {
  const text = item.lineText || "";
  const range = item.highlightIndices;
  if (!range) return [{ text, highlight: false }];
  const start = Math.max(0, Math.min(range[0], text.length));
  const end = Math.max(start, Math.min(range[1], text.length));
  return [
    { text: text.slice(0, start), highlight: false },
    { text: text.slice(start, end), highlight: true },
    { text: text.slice(end), highlight: false },
  ];
}

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => {
    if (value || canLeavePreview()) emit("update:open", value);
  },
});

function handleKeyDown(e: KeyboardEvent): void {
  if (previewEditing.value) return;
  if ((e.metaKey || e.ctrlKey) && /^[1-8]$/.test(e.key)) {
    e.preventDefault();
    selectCategory(categoryDefinitions[Number(e.key) - 1]!.id);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (contentMode.value) selectNext();
    else navigateVisible(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (contentMode.value) selectPrevious();
    else navigateVisible(-1);
  } else if (e.key === "Enter") {
    const target = contentMode.value ? contentSelectedItem.value : selectedDisplayItem.value;
    if (target) {
      e.preventDefault();
      const supportsSecondaryAction = target.type === "column" || target.type === "table" || target.type === "view";
      if ((e.metaKey || e.ctrlKey) && !contentMode.value && supportsSecondaryAction) handleSecondaryAction(target);
      else handleSelect(target);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    dialogOpen.value = false;
  }
}

function handlePreviewNavigate(direction: -1 | 1): void {
  if (previewEditing.value) return;
  if (direction === 1) selectNext();
  else selectPrevious();
  inputRef.value?.$el.focus();
}

function openPreviewMatch(): void {
  if (contentSelectedItem.value) handleSelect(contentSelectedItem.value);
}

function handleSelect(item: QuickOpenItem): void {
  if (!canLeavePreview()) return;
  recordRecentItem(item);
  // Plugin commands execute inside this component: they are NOT dispatched to App.vue object navigation (that chain
  // connectionId-based connection/expand logic is meaningless for command entries); execution errors surface via the existing toast.
  if (item.type === "plugin_command") {
    const result = pluginPalette.open(item);
    if (result.error) toast(result.error, 5000);
    dialogOpen.value = false;
    return;
  }
  emit("select", item);
  dialogOpen.value = false;
}

function getHighlightedLabel(item: any): (string | { text: string; highlight: boolean })[] {
  if (!searchQuery.value.trim() || !item.matchIndices) {
    return [item.label];
  }

  const indices = new Set(item.matchIndices);
  const parts: (string | { text: string; highlight: boolean })[] = [];
  let current = "";
  let isHighlighting = false;

  for (let i = 0; i < item.label.length; i++) {
    const char = item.label[i];
    const shouldHighlight = indices.has(i);

    if (shouldHighlight !== isHighlighting) {
      if (current) {
        parts.push({
          text: current,
          highlight: isHighlighting,
        });
      }
      current = char;
      isHighlighting = shouldHighlight;
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push({
      text: current,
      highlight: isHighlighting,
    });
  }

  return parts;
}

function getTypeLabel(type: string): string {
  switch (type) {
    case "connection":
      return t("common.connection");
    case "database":
      return t("common.database");
    case "schema":
      return t("common.schema");
    case "table":
      return t("common.table");
    case "column":
      return t("common.column");
    case "view":
      return t("common.view");
    case "materialized_view":
      return t("common.materializedView");
    case "procedure":
      return t("common.procedure");
    case "function":
      return t("common.function");
    case "sequence":
      return t("common.sequence");
    case "package":
      return t("common.package");
    case "package-body":
      return t("common.packageBody");
    case "sql_file":
      return t("quickOpen.sqlFile");
    case "sql_library_file":
      return t("quickOpen.sqlLibraryFile");
    case "plugin_workbench":
      return t("quickOpen.pluginWorkbench");
    default:
      return type;
  }
}

function getItemIcon(type: string) {
  if (type === "connection") return Cable;
  if (type === "database") return Database;
  if (type === "schema") return Layers3;
  if (type === "table" || type === "view" || type === "materialized_view") return Table2;
  if (type === "column") return Layers3;
  if (type === "sql_file") return FileCode;
  if (type === "sql_library_file") return FileText;
  if (type === "plugin_command") return Terminal;
  return null;
}

/** Right badge copy: plugin commands show the source plugin name as provenance; others keep the type label. */
function getTypeBadge(item: QuickOpenItem): string {
  if (item.type === "plugin_command") return item.pluginName || item.pluginId || "";
  return getTypeLabel(item.type);
}

function getSourceLabel(item: QuickOpenItem): string {
  if (item.source === "remote" || item.id.startsWith("structure-")) return t("quickOpen.sourceRemote");
  if (item.source === "file" || item.type === "sql_file" || item.type === "sql_library_file" || item.type === "content_match") return t("quickOpen.sourceFile");
  if (item.source === "plugin" || item.type === "plugin_command" || item.type === "plugin_workbench") return t("quickOpen.sourcePlugin");
  return t("quickOpen.sourceCache");
}

function getPrimaryAction(item: QuickOpenItem): string {
  if (item.type === "connection") return t("quickOpen.actionConnect");
  if (item.type === "column") return t("quickOpen.actionOpenStructureAndColumn");
  if (item.type === "table" || item.type === "view" || item.type === "materialized_view") return t("quickOpen.actionOpenData");
  if (item.type === "procedure" || item.type === "function" || item.type === "package" || item.type === "package-body") return t("quickOpen.actionOpenSource");
  if (item.type === "sql_file" || item.type === "sql_library_file") return t("quickOpen.actionOpenSqlFile");
  if (item.type === "plugin_command") return t("quickOpen.actionExecuteCommand");
  return t("quickOpen.actionOpen");
}

function getSecondaryAction(item: QuickOpenItem): string {
  return item.type === "column" ? t("quickOpen.secondaryOpenData") : t("quickOpen.secondaryOpenStructure");
}

function getPrimaryActionHint(item: QuickOpenItem): string {
  if (item.type === "column") return t("quickOpen.secondaryActionHint", { shortcut: secondaryActionShortcut.value, action: getSecondaryAction(item) });
  if (item.type === "table" || item.type === "view") return t("quickOpen.secondaryActionHint", { shortcut: secondaryActionShortcut.value, action: getSecondaryAction(item) });
  return t("quickOpen.primaryActionHint");
}

function handleSecondaryAction(item: QuickOpenItem): void {
  if (item.type === "column" && item.tableName) {
    const tableType = item.tableType?.toUpperCase().replaceAll(" ", "_");
    const target: QuickOpenItem = {
      ...item,
      id: JSON.stringify(["relation", item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.tableName]),
      type: tableType === "MATERIALIZED_VIEW" ? "materialized_view" : tableType === "VIEW" ? "view" : "table",
      label: item.tableName,
      objectName: item.tableName,
      columnName: undefined,
      columnComment: undefined,
      searchScope: "data",
    };
    handleSelect(target);
    return;
  }
  if (item.type === "table" || item.type === "view") {
    handleSelect({ ...item, searchScope: "structure" });
  }
}

function getResultContext(item: QuickOpenItem): string {
  if (item.type === "content_match") return item.filePath || item.description || "";
  return [item.connectionName, item.catalog, item.database, item.schema, item.tableName || item.objectName, item.signature ? `(${item.signature})` : ""].filter(Boolean).join(" / ");
}

function getResultCategory(item: QuickOpenItem): "objects" | "files" | "commands" {
  if (item.type === "sql_file" || item.type === "sql_library_file" || item.type === "content_match") return "files";
  if (item.type === "plugin_command" || item.type === "plugin_workbench") return "commands";
  return "objects";
}

function getResultCategoryLabel(category: "objects" | "files" | "commands"): string {
  if (category === "files") return t("quickOpen.categoryFiles");
  if (category === "commands") return t("quickOpen.categoryCommands");
  return t("quickOpen.categoryObjects");
}

function getResultCategoryCount(category: "objects" | "files" | "commands"): number {
  return filteredItems.value.filter((item) => getResultCategory(item) === category).length;
}

watch(
  [isHomeView, homeItems],
  () => {
    if (!isHomeView.value) {
      homeSelectedId.value = null;
      return;
    }
    if (homeItems.value.length === 0) {
      homeSelectedId.value = null;
      return;
    }
    if (!homeSelectedId.value || !homeItems.value.some((item) => item.id === homeSelectedId.value)) homeSelectedId.value = homeItems.value[0]!.id;
    const index = filteredItems.value.findIndex((item) => item.id === homeSelectedId.value);
    if (index >= 0) selectedIndex.value = index;
  },
  { immediate: true },
);

watch(
  parsedSearchQuery,
  (parsed) => {
    const kind = parsed.filters.kind;
    const categoryByKind: Record<string, SearchCategory> = {
      object: "all",
      connection: "connections",
      database: "databases",
      schema: "databases",
      table: "objects",
      view: "objects",
      materialized_view: "objects",
      column: "fields",
      procedure: "objects",
      function: "objects",
      sequence: "objects",
      package: "objects",
      "package-body": "objects",
      file: "files",
      sql_library_file: "files",
      sql_file: "files",
      plugin_command: "commands",
      plugin_workbench: "commands",
      command: "commands",
    };
    const categoryFromQuery = kind && categoryByKind[kind] ? categoryByKind[kind] : parsed.filters.category === "files" ? "files" : parsed.filters.category === "commands" ? "commands" : parsed.filters.category === "objects" ? "all" : undefined;
    if (categoryFromQuery) activeCategory.value = categoryFromQuery;
    if (contentMode.value && Object.keys(parsed.filters).length > 0) {
      setContentMode(false, categoryFromQuery ?? "all");
    }
  },
  { deep: true },
);

watch(
  () => props.open,
  (newOpen) => {
    if (!newOpen) {
      cancelSearch();
      return;
    }
    if (newOpen) {
      setQuery("");
      activeCategory.value = props.initialContentMode === true ? "content" : "all";
      setContentMode(props.initialContentMode === true);
      searchSettingsOpen.value = false;
      refreshSearchSettings();
      // Fallback refresh of the plugin command list on open (regular refresh is event-driven via dbx:plugins-changed).
      void pluginPalette.refresh();
      // Eagerly load external SQL files so they appear in the initial list
      void loadExternalSqlFiles();
      // Refresh plugin workbench entries so installs/uninstalls show up without a restart
      void loadPluginWorkbenches();
      nextTick(() => {
        inputRef.value?.$el.focus();
      });
    }
  },
);

// While the dialog is open, Ctrl+P / Ctrl+Shift+F switch the mode without
// closing it. The parent drives this by mutating the `initialContentMode` prop.
watch(
  () => props.initialContentMode,
  (enabled) => {
    if (props.open) {
      setContentMode(enabled === true);
    }
  },
);

// Keep the highlighted row in view when keyboard navigation moves the selection.
watch(selectedIndex, async () => {
  await nextTick();
  const container = listRef.value;
  if (!container) return;
  container.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
});
</script>

<template>
  <Dialog :open="dialogOpen" @update:open="dialogOpen = $event">
    <DialogContent class="max-w-6xl p-0 gap-0 rounded-xl overflow-hidden">
      <div class="flex max-h-[calc(var(--dbx-viewport-height)-2rem)] min-h-0 flex-col bg-background">
        <!-- Search Input -->
        <div class="flex shrink-0 items-center gap-3 px-4 pr-12 py-3 border-b">
          <Command class="h-5 w-5 text-muted-foreground" />
          <Input
            ref="inputRef"
            v-model="searchQuery"
            :disabled="previewEditing"
            type="text"
            :placeholder="contentMode ? t('quickOpen.contentPlaceholder') : t('quickOpen.placeholder')"
            class="flex-1 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none"
            @keydown="handleKeyDown"
          />
          <div class="flex items-center gap-1 shrink-0">
            <!-- Object/file ⇄ file content mode toggle -->
            <div class="flex items-center rounded-md bg-muted p-0.5 text-muted-foreground">
              <button :disabled="previewEditing" class="flex h-7 w-7 items-center justify-center rounded disabled:opacity-50" :class="contentMode ? 'hover:bg-muted-foreground/10' : 'bg-background text-foreground shadow-sm'" :title="t('quickOpen.modeObjects')" @click="setContentMode(false)">
                <FileCode class="h-4 w-4" />
              </button>
              <button :disabled="previewEditing" class="flex h-7 w-7 items-center justify-center rounded disabled:opacity-50" :class="contentMode ? 'bg-background text-foreground shadow-sm' : 'hover:bg-muted-foreground/10'" :title="t('quickOpen.modeContent')" @click="setContentMode(true)">
                <Search class="h-4 w-4" />
              </button>
            </div>
            <!-- Search settings (roots & extensions) -->
            <button
              :disabled="previewEditing"
              class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              :class="searchSettingsOpen ? 'bg-muted text-foreground' : ''"
              :title="t('quickOpen.searchSettings')"
              @click="searchSettingsOpen = !searchSettingsOpen"
            >
              <SlidersHorizontal class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div v-if="!contentMode && (activeSearchFilters.length > 0 || !searchQuery.trim())" class="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2 text-xs">
          <span v-if="activeSearchFilters.length > 0" class="mr-1 text-muted-foreground">{{ t("quickOpen.filterLabel") }}</span>
          <span v-for="[key, value] in activeSearchFilters" :key="key" class="rounded-full bg-muted px-2 py-0.5 text-foreground"> {{ key }}:{{ value }} </span>
          <span v-if="activeSearchFilters.length === 0" class="text-muted-foreground">{{ t("quickOpen.syntaxHint") }}</span>
        </div>

        <!-- Category navigation: the main entry point for the search workspace. -->
        <GlobalSearchCategoryBar :categories="categoryDefinitions" :active="activeCategory" :counts="{ ...categoryCounts, content: contentMatchCount }" @select="selectCategoryFromBar" />

        <!-- Search settings panel -->
        <div v-if="searchSettingsOpen" class="max-h-[30vh] shrink-0 space-y-3 overflow-y-auto border-b bg-muted/30 px-4 py-3 text-sm">
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <span class="text-xs text-muted-foreground">{{ t("quickOpen.searchRoots") }}</span>
              <button class="flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground hover:bg-muted" @click="addSearchDirectory"><FolderPlus class="h-3.5 w-3.5" /> {{ t("quickOpen.addDirectory") }}</button>
            </div>
            <div v-if="searchRoots.length === 0" class="text-xs text-muted-foreground">
              {{ t("quickOpen.noRootsConfigured") }}
            </div>
            <div v-else class="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
              <span v-for="root in searchRoots" :key="root" class="group flex max-w-full items-center gap-1 rounded bg-background px-2 py-1 text-xs">
                <span class="max-w-[280px] truncate" :title="root">{{ root }}</span>
                <button class="text-muted-foreground hover:text-foreground" :title="t('quickOpen.removePath')" @click="removeSearchRoot(root)">
                  <X class="h-3 w-3" />
                </button>
              </span>
            </div>
          </div>
          <div>
            <span class="text-xs text-muted-foreground">{{ t("quickOpen.searchExtensions") }}</span>
            <div class="mt-1 flex items-center gap-2">
              <Input v-model="extensionsInput" type="text" class="h-8 flex-1" :placeholder="t('quickOpen.extensionsPlaceholder')" />
              <button class="rounded px-3 py-1.5 text-xs text-foreground hover:bg-muted" @click="saveExtensions">{{ t("quickOpen.apply") }}</button>
            </div>
          </div>
        </div>

        <!-- Three-column search workspace. Each pane owns its presentation and emits session actions. -->
        <div class="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)_290px]">
          <GlobalSearchScopeRail
            :content-mode="contentMode"
            :preview-editing="previewEditing"
            :scope-selection="scopeSelection"
            :scope-all-value="SCOPE_ALL_VALUE"
            :connections="scopeConnections"
            :connected-ids="connectionStore.connectedIds"
            @update:scope-selection="scopeSelection = $event"
            @token="appendSearchToken"
          />
          <div ref="listRef" class="min-h-0">
            <GlobalSearchHome
              v-if="!contentMode && !searchQuery.trim() && activeCategory === 'all'"
              :items="displayItems"
              :selected-id="selectedDisplayItem?.id"
              @open="handleSelect"
              @hover="
                (item) => {
                  homeSelectedId = item.id;
                  selectedIndex = filteredItems.findIndex((candidate) => candidate.id === item.id);
                }
              "
              @token="appendSearchToken"
              @content="selectCategory('content')"
            />
            <GlobalSearchResultList
              v-else
              :content-mode="contentMode"
              :content-searching="contentSearching"
              :content-search-error="contentSearchError"
              :content-groups="contentGroups"
              :selected-index="selectedIndex"
              :search-query="searchQuery"
              :items="displayItems"
              :selected-id="selectedDisplayItem?.id"
              :get-highlighted-line-parts="getHighlightedLineParts"
              :get-highlighted-label="getHighlightedLabel"
              :get-item-icon="getItemIcon"
              :get-result-category="getResultCategory"
              :get-result-category-label="getResultCategoryLabel"
              :get-result-category-count="getResultCategoryCount"
              :get-source-label="getSourceLabel"
              :get-type-badge="getTypeBadge"
              :get-result-context="getResultContext"
              @open="handleSelect"
              @hover="
                (item) => {
                  selectedIndex = filteredItems.findIndex((candidate) => candidate.id === item.id);
                }
              "
              @content-hover="(index) => !previewEditing && (selectedIndex = index)"
              @retry-content-search="retryContentSearch"
            />
          </div>
          <aside class="min-h-0 border-t bg-muted/10 p-4 md:col-span-2 lg:col-span-1 lg:overflow-y-auto lg:border-l lg:border-t-0" :class="previewItem && (previewEditing || (contentMode && !contentSearching)) ? 'block' : 'hidden lg:block'">
            <QuickOpenFilePreview v-if="previewItem && (previewEditing || (contentMode && !contentSearching))" :item="previewItem" class="h-[300px] lg:h-full" @editing="handlePreviewEditing" @navigate="handlePreviewNavigate" @open="openPreviewMatch" @close="dialogOpen = false" />
            <GlobalSearchPreview
              v-else-if="selectedDisplayItem"
              :item="selectedDisplayItem"
              :type-badge="getTypeBadge"
              :source-label="getSourceLabel"
              :context="getResultContext"
              :primary-action="getPrimaryAction"
              :secondary-action="getSecondaryAction"
              :secondary-shortcut="secondaryActionShortcut"
              :primary-action-hint="getPrimaryActionHint"
              @open="handleSelect(selectedDisplayItem!)"
              @secondary="handleSecondaryAction(selectedDisplayItem!)"
            />
            <div v-else class="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-xs text-muted-foreground">
              <Server class="mb-3 h-8 w-8 opacity-30" />
              <p>{{ t("quickOpen.previewEmptyTitle") }}</p>
              <p class="mt-1 opacity-70">{{ t("quickOpen.previewEmptyHint") }}</p>
            </div>
          </aside>
        </div>

        <div v-if="previewItem && !previewEditing && !contentMode" class="border-t bg-muted/10 px-4 py-3 lg:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs font-semibold text-foreground">{{ previewItem.label }}</div>
              <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ getResultContext(previewItem) || previewItem.description }}</div>
            </div>
            <button class="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background" @click="handleSelect(previewItem)">{{ getPrimaryAction(previewItem) }}</button>
          </div>
        </div>

        <!-- Footer -->
        <div class="shrink-0 flex flex-wrap justify-between gap-2 px-4 py-2 border-t text-xs text-muted-foreground">
          <div>{{ contentMode ? contentMatchCount : displayItems.length }} {{ t("quickOpen.results") }}</div>
          <div v-if="previewEditing" role="status">{{ t("quickOpen.finishEditing") }}</div>
          <div v-else class="flex gap-4">
            <span><kbd class="px-2 py-1 rounded bg-muted">↑↓</kbd> {{ t("quickOpen.navigate") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">⏎</kbd> {{ t("quickOpen.select") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">ESC</kbd> {{ t("quickOpen.close") }}</span>
            <span class="hidden sm:inline"
              ><kbd class="px-2 py-1 rounded bg-muted">{{ globalSearchShortcut }}</kbd> {{ t("quickOpen.globalSearchHint") }}</span
            >
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep([data-slot="dialog-content"]) {
  border-color: color-mix(in srgb, var(--border) 80%, var(--ring));
  box-shadow: 0 24px 70px rgb(0 0 0 / 0.32);
}

:deep(.divide-y > div.bg-accent) {
  background-color: var(--info-bg) !important;
  box-shadow: inset 3px 0 0 var(--info) !important;
}

:deep(.bg-yellow-200),
:deep(.dark .bg-yellow-800) {
  background-color: var(--warning-bg) !important;
  border-radius: 0.1875rem;
  padding: 0 0.0625rem;
}
</style>
