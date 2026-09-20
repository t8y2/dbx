<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Command, FileCode, FileText, Search, FolderPlus, SlidersHorizontal, X } from "@lucide/vue";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import { useQuickOpen, type QuickOpenItem } from "@/composables/useQuickOpen";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";
import { getGlobalSearchRoots, saveGlobalSearchRoots, getGlobalSearchExtensions, saveGlobalSearchExtensions } from "@/lib/globalSearch/globalSearchSettings";

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
const { searchQuery, filteredItems, selectedIndex, selectedItem, selectNext, selectPrevious, setQuery, loadExternalSqlFiles, loadPluginWorkbenches, contentMode, contentGroups, contentSelectedItem, contentSearching, setContentMode } = useQuickOpen();
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const settingsStore = useSettingsStore();
const globalSearchShortcut = computed(() => formatShortcutDisplay(settingsStore.editorSettings.shortcuts.globalSearch || "Mod+Shift+F"));

// Search settings panel state (extra search roots and file extensions).
const searchSettingsOpen = ref(false);
const searchRoots = ref<string[]>([]);
const extensionsInput = ref("");

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

interface ContentRow {
  isHeader: boolean;
  header?: string;
  filePath?: string;
  count?: number; // match count under a header
  item?: QuickOpenItem;
  flatIndex: number; // index into the flattened selectable matches
}

const contentRows = computed<ContentRow[]>(() => {
  const rows: ContentRow[] = [];
  let flatIndex = 0;
  for (const group of contentGroups.value) {
    rows.push({ isHeader: true, header: group.header, filePath: group.filePath, count: group.matches.length, item: undefined, flatIndex: -1 });
    for (const match of group.matches) {
      rows.push({ isHeader: false, header: undefined, filePath: group.filePath, count: undefined, item: match, flatIndex: flatIndex++ });
    }
  }
  return rows;
});

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
  set: (value) => emit("update:open", value),
});

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectNext();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectPrevious();
  } else if (e.key === "Enter") {
    const target = contentMode.value ? contentSelectedItem.value : selectedItem.value;
    if (target) {
      e.preventDefault();
      handleSelect(target);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    dialogOpen.value = false;
  }
}

function handleSelect(item: QuickOpenItem): void {
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
  if (type === "sql_file") return FileCode;
  if (type === "sql_library_file") return FileText;
  return null;
}

watch(
  () => props.open,
  (newOpen) => {
    if (newOpen) {
      setQuery("");
      setContentMode(props.initialContentMode === true);
      searchSettingsOpen.value = false;
      refreshSearchSettings();
      // Eagerly load external SQL files so they appear in the initial list
      void loadExternalSqlFiles();
      // Refresh plugin workbench entries so installs/uninstalls show up without a restart
      void loadPluginWorkbenches();
      nextTick(() => {
        inputRef.value?.focus();
      });
    }
  },
);

// While the dialog is open, Ctrl+P / Ctrl+Shift+F switch the mode without
// closing it. The parent drives this by mutating the `initialContentMode` prop.
watch(
  () => props.initialContentMode,
  (enabled) => {
    if (props.open) setContentMode(enabled === true);
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
    <DialogContent class="max-w-2xl p-0 gap-0 rounded-lg overflow-hidden">
      <div class="flex flex-col bg-background">
        <!-- Search Input -->
        <div class="flex items-center gap-3 px-4 pr-12 py-3 border-b">
          <Command class="h-5 w-5 text-muted-foreground" />
          <Input
            ref="inputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="contentMode ? t('quickOpen.contentPlaceholder') : t('quickOpen.placeholder')"
            class="flex-1 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none"
            @keydown="handleKeyDown"
          />
          <div class="flex items-center gap-1 shrink-0">
            <!-- Object/file ⇄ file content mode toggle -->
            <div class="flex items-center rounded-md bg-muted p-0.5 text-muted-foreground">
              <button class="flex h-7 w-7 items-center justify-center rounded" :class="contentMode ? 'hover:bg-muted-foreground/10' : 'bg-background text-foreground shadow-sm'" :title="t('quickOpen.modeObjects')" @click="setContentMode(false)">
                <FileCode class="h-4 w-4" />
              </button>
              <button class="flex h-7 w-7 items-center justify-center rounded" :class="contentMode ? 'bg-background text-foreground shadow-sm' : 'hover:bg-muted-foreground/10'" :title="t('quickOpen.modeContent')" @click="setContentMode(true)">
                <Search class="h-4 w-4" />
              </button>
            </div>
            <!-- Search settings (roots & extensions) -->
            <button class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :class="searchSettingsOpen ? 'bg-muted text-foreground' : ''" :title="t('quickOpen.searchSettings')" @click="searchSettingsOpen = !searchSettingsOpen">
              <SlidersHorizontal class="h-4 w-4" />
            </button>
          </div>
        </div>

        <!-- Search settings panel -->
        <div v-if="searchSettingsOpen" class="space-y-3 border-b bg-muted/30 px-4 py-3 text-sm">
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

        <!-- Results List -->
        <div ref="listRef" class="max-h-[400px] overflow-y-auto">
          <!-- Content search mode: group matches by file (DataGrip-style) -->
          <template v-if="contentMode">
            <div v-if="contentSearching" class="px-4 py-8 text-center text-muted-foreground">
              {{ t("quickOpen.searchingContent") }}
            </div>
            <div v-else-if="contentRows.length === 0" class="px-4 py-8 text-center text-muted-foreground">
              <p v-if="!searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
              <p v-else>{{ t("quickOpen.noResults") }}</p>
            </div>
            <div v-else class="divide-y">
              <template v-for="row in contentRows" :key="row.isHeader ? `h-${row.filePath}` : row.item!.id">
                <!-- Group header -->
                <div v-if="row.isHeader" class="flex items-center justify-between gap-3 px-4 py-1.5 bg-muted/50">
                  <div class="flex items-center gap-2 min-w-0">
                    <FileCode class="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span class="text-xs font-semibold text-foreground truncate">{{ row.header }}</span>
                  </div>
                  <span class="text-xs text-muted-foreground whitespace-nowrap">{{ row.count }}</span>
                </div>
                <!-- Match line -->
                <div v-else class="px-4 py-1.5 cursor-pointer" :data-selected="row.flatIndex === selectedIndex" :class="[row.flatIndex === selectedIndex ? 'bg-accent' : 'hover:bg-muted']" @click="handleSelect(row.item!)" @mouseenter="selectedIndex = row.flatIndex">
                  <!-- Filename-only match (no content hit): show highlighted file name -->
                  <div v-if="row.item!.line === 0" class="flex items-center gap-2 min-w-0">
                    <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span class="font-mono text-xs truncate">
                      <template v-for="(part, i) in getHighlightedLineParts(row.item!)" :key="i">
                        <span v-if="part.highlight" class="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded-[0.1875rem] px-0.5 font-semibold">{{ part.text }}</span>
                        <span v-else>{{ part.text }}</span>
                      </template>
                    </span>
                  </div>
                  <!-- Content match: line number + highlighted snippet -->
                  <div v-else class="flex items-center gap-2 min-w-0">
                    <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ row.item!.line }}</span>
                    <span class="font-mono text-xs truncate">
                      <template v-for="(part, i) in getHighlightedLineParts(row.item!)" :key="i">
                        <span v-if="part.highlight" class="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded-[0.1875rem] px-0.5 font-semibold">{{ part.text }}</span>
                        <span v-else>{{ part.text }}</span>
                      </template>
                    </span>
                  </div>
                </div>
              </template>
            </div>
          </template>

          <!-- Normal mode -->
          <div v-else-if="filteredItems.length === 0" class="px-4 py-8 text-center text-muted-foreground">
            <p v-if="!searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
            <p v-else>{{ t("quickOpen.noResults") }}</p>
          </div>

          <div v-else class="divide-y">
            <div v-for="(item, index) in filteredItems" :key="item.id" :data-selected="index === selectedIndex" :class="['px-4 py-2 cursor-pointer', index === selectedIndex ? 'bg-accent' : 'hover:bg-muted']" @click="handleSelect(item)" @mouseenter="selectedIndex = index">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <PluginIcon v-if="item.type === 'plugin_workbench' && item.pluginId" :plugin-id="item.pluginId" :icon="item.pluginIcon" :contribution-id="item.contributionId" class="h-4 w-4 shrink-0" />
                  <component v-if="getItemIcon(item.type)" :is="getItemIcon(item.type)" class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">
                      <template v-for="(part, i) in getHighlightedLabel(item)" :key="i">
                        <span v-if="typeof part === 'object'" :class="{ 'bg-yellow-200 dark:bg-yellow-800 font-semibold': part.highlight }">
                          {{ part.text }}
                        </span>
                        <span v-else>{{ part }}</span>
                      </template>
                    </div>
                    <div v-if="item.description" class="text-xs text-muted-foreground truncate">
                      {{ item.description }}
                    </div>
                  </div>
                </div>
                <div class="text-xs px-2 py-1 rounded bg-muted text-muted-foreground whitespace-nowrap">
                  {{ getTypeLabel(item.type) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-4 py-2 border-t text-xs text-muted-foreground flex justify-between">
          <div>{{ contentMode ? contentMatchCount : filteredItems.length }} {{ t("quickOpen.results") }}</div>
          <div class="flex gap-4">
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
