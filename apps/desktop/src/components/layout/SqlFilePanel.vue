<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, FileCode, FolderClosed, ChevronRight, ChevronDown, X, Trash2, RefreshCw, FolderSearch, Copy, Play, ChevronsUpDown, ChevronsDownUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { translateBackendError } from "@/i18n/backend-errors";
import { copyToClipboard } from "@/lib/common/clipboard";
import { resolveExternalSqlFileTarget, unassociatedExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { externalSqlFileOpenErrorMessage, formatSqlFileSize, isExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";
import { getSqlFileFolderPaths, saveSqlFileFolderPaths, notifySqlFileFoldersChanged } from "@/lib/sqlFile/sqlFileFolders";
import { orderedListRangeAnchorIndex, orderedListSelectionIntent, type OrderedListSelectionItem } from "@/lib/selection/orderedListSelection";

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const { toast } = useToast();

interface FolderState {
  path: string;
  entries: SqlFileEntry[];
  expanded: Set<string>;
  loading: boolean;
  collapsed: boolean;
}

const folders = ref<FolderState[]>([]);

// Right-click target. `kind` discriminates between a folder header, a tree
// directory entry, and a tree file entry. `folderPath` is the owning top-level
// folder (for refresh scoping); `entryPath` is the right-clicked node path.
type ContextTarget = { kind: "panel" } | { kind: "folderHeader"; folderPath: string } | { kind: "dir"; folderPath: string; entry: SqlFileEntry } | { kind: "file"; folderPath: string; entry: SqlFileEntry };

const contextTarget = ref<ContextTarget | null>(null);

const selectedPaths = ref<Set<string>>(new Set());
const activePath = ref<string | null>(null);
const selectionAnchorIndex = ref<number | null>(null);

function clearSelection() {
  selectedPaths.value = new Set();
  activePath.value = null;
  selectionAnchorIndex.value = null;
}

function isPathHighlighted(path: string) {
  return activePath.value === path || selectedPaths.value.has(path);
}

function loadSavedFolders(): string[] {
  return getSqlFileFolderPaths();
}

function saveFolders() {
  const paths = folders.value.map((f) => f.path);
  saveSqlFileFolderPaths(paths);
}

async function pickFolder() {
  if (!isTauriRuntime()) {
    toast(t("sqlFileTree.desktopOnly"), 3000);
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const folderPath = selected as string;
    if (folders.value.some((f) => f.path === folderPath)) {
      toast(t("sqlFileTree.folderAlreadyOpen"), 2000);
      return;
    }
    await addFolder(folderPath);
  } catch (e: any) {
    toast(t("sqlFileTree.openFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function addFolder(folderPath: string) {
  const folder: FolderState = {
    path: folderPath,
    entries: [],
    expanded: new Set(),
    loading: true,
    collapsed: false,
  };
  folders.value.push(folder);
  saveFolders();
  await loadFolderEntries(folderPath);
}

// Re-scan a single top-level folder and replace its entries. Mutated via the
// reactive proxy (folders.value[idx]) so Vue tracks the change — see the note
// in addFolder above.
async function loadFolderEntries(folderPath: string) {
  const idx = folders.value.findIndex((f) => f.path === folderPath);
  if (idx === -1) return;
  folders.value[idx].loading = true;
  try {
    const entries = await api.listSqlFilesInFolder(folderPath);
    const target = folders.value.findIndex((f) => f.path === folderPath);
    if (target !== -1) {
      folders.value[target].entries = entries;
      // Drop expand state for paths that no longer exist after the refresh so
      // stale entries don't keep phantom directories open.
      const stillPresent = new Set<string>();
      collectPaths(entries, stillPresent);
      const nextExpanded = new Set<string>();
      for (const p of folders.value[target].expanded) {
        if (stillPresent.has(p)) nextExpanded.add(p);
      }
      folders.value[target].expanded = nextExpanded;
    }
  } catch (e: any) {
    toast(t("sqlFileTree.loadFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    const target = folders.value.findIndex((f) => f.path === folderPath);
    if (target !== -1) {
      folders.value[target].loading = false;
    }
  }
}

function collectPaths(entries: SqlFileEntry[], into: Set<string>) {
  for (const e of entries) {
    into.add(e.path);
    if (e.is_dir && e.children.length) collectPaths(e.children, into);
  }
}

async function refreshFolder(folderPath: string) {
  await loadFolderEntries(folderPath);
  notifySqlFileFoldersChanged();
  toast(t("sqlFileTree.refreshed"), 1500);
}

async function refreshAll() {
  await Promise.all(folders.value.map((f) => loadFolderEntries(f.path)));
  notifySqlFileFoldersChanged();
  toast(t("sqlFileTree.refreshed"), 1500);
}

async function removeFolder(index: number) {
  folders.value.splice(index, 1);
  saveFolders();
}

async function revealInFileManager(path: string) {
  if (!isTauriRuntime()) {
    toast(t("sqlFileTree.desktopOnly"), 3000);
    return;
  }
  try {
    await api.revealPathInFileManager(path);
  } catch (e: any) {
    toast(t("sqlFileTree.revealFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

async function copyPath(path: string) {
  try {
    await copyToClipboard(path);
    toast(t("sqlFileTree.pathCopied"), 1500);
  } catch {
    toast(t("sqlFileTree.copyFailed"), 3000);
  }
}

function toggleExpand(folder: FolderState, path: string) {
  const next = new Set(folder.expanded);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  folder.expanded = next;
}

function toggleFolderCollapse(folder: FolderState) {
  folder.collapsed = !folder.collapsed;
}

// Expand/collapse every directory beneath the given top-level folder.
function setAllExpanded(folder: FolderState, expanded: boolean) {
  if (expanded) {
    const next = new Set(folder.expanded);
    collectDirPaths(folder.entries, next);
    folder.expanded = next;
  } else {
    folder.expanded = new Set();
  }
}

function collectDirPaths(entries: SqlFileEntry[], into: Set<string>) {
  for (const e of entries) {
    if (e.is_dir) {
      into.add(e.path);
      collectDirPaths(e.children, into);
    }
  }
}

async function openFile(path: string) {
  if (!isTauriRuntime()) return;
  try {
    const snapshot = await api.readExternalSqlFileSnapshot(path);
    const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), unassociatedExternalSqlFileTarget());
    queryStore.openExternalSqlFile(target.connectionId, target.database, path, snapshot.content, snapshot.version, target.catalog);
  } catch (e: any) {
    if (isExternalSqlFileTooLargeError(e)) {
      executeFile(path);
      toast(t("sqlFile.largeFileExecutionOpened", { size: formatSqlFileSize(e.sizeBytes) }), 6000);
      return;
    }
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
  }
}

// Open the App-level SQL file execution dialog with this file pre-selected so
// the user can review its statements and pick a connection/database before run.
function executeFile(path: string) {
  const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), unassociatedExternalSqlFileTarget());
  connectionStore.sqlFileSource = {
    connectionId: target.connectionId,
    database: target.database,
    filePath: path,
  };
}

function folderName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.pop() || path;
}

onMounted(async () => {
  const saved = loadSavedFolders();
  for (const path of saved) {
    await addFolder(path);
  }
});

type TreeEntry = { entry: SqlFileEntry; depth: number };
function flatTree(entries: SqlFileEntry[], expanded: Set<string>): TreeEntry[] {
  const result: TreeEntry[] = [];
  function walk(items: SqlFileEntry[], depth: number) {
    for (const item of items) {
      result.push({ entry: item, depth });
      if (item.is_dir && expanded.has(item.path)) {
        walk(item.children, depth + 1);
      }
    }
  }
  walk(entries, 0);
  return result;
}

const visibleItems = computed<OrderedListSelectionItem[]>(() => {
  const items: OrderedListSelectionItem[] = [];
  for (const folder of folders.value) {
    items.push({ type: "folderHeader", id: folder.path });
    if (folder.collapsed) continue;
    for (const { entry } of flatTree(folder.entries, folder.expanded)) {
      items.push({ type: entry.is_dir ? "dir" : "file", id: entry.path });
    }
  }
  return items;
});

function selectedRangeAnchorIndex() {
  const activeItem = activePath.value ? (visibleItems.value.find((item) => item.id === activePath.value) ?? null) : null;
  return orderedListRangeAnchorIndex(visibleItems.value, selectionAnchorIndex.value, activeItem);
}

function selectRangeTo(currentIndex: number) {
  const anchorIndex = selectedRangeAnchorIndex();
  if (anchorIndex === null) {
    const current = visibleItems.value[currentIndex];
    selectedPaths.value = new Set(current ? [current.id] : []);
    selectionAnchorIndex.value = currentIndex;
    return;
  }

  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  const next = new Set(selectedPaths.value);
  for (let i = start; i <= end; i++) {
    const item = visibleItems.value[i];
    if (item) next.add(item.id);
  }
  selectedPaths.value = next;
}

function handlePathClick(path: string, type: OrderedListSelectionItem["type"], event: MouseEvent, activate: () => void) {
  const currentIndex = visibleItems.value.findIndex((item) => item.id === path && item.type === type);
  if (currentIndex < 0) return;

  const selectionIntent = orderedListSelectionIntent(event);
  if (selectionIntent === "range") {
    event.preventDefault();
    event.stopPropagation();
    selectRangeTo(currentIndex);
    return;
  }
  if (selectionIntent === "toggle") {
    event.preventDefault();
    event.stopPropagation();
    const next = new Set(selectedPaths.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectedPaths.value = next;
    selectionAnchorIndex.value = currentIndex;
    return;
  }

  selectedPaths.value = new Set();
  activePath.value = path;
  selectionAnchorIndex.value = currentIndex;
  activate();
}

function handlePanelClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("[data-sql-file-row='true']")) clearSelection();
}

// ---- context menu ----
const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const target = contextTarget.value;
  if (!target) return [];

  if (target.kind === "panel") {
    const items: ContextMenuItem[] = [{ label: t("sqlFileTree.openFolder"), action: pickFolder, icon: FolderOpen }];
    if (folders.value.length > 0) {
      items.push({ label: "", separator: true });
      items.push({ label: t("sqlFileTree.refreshAll"), action: refreshAll, icon: RefreshCw });
    }
    return items;
  }

  if (target.kind === "folderHeader") {
    const folderIdx = folders.value.findIndex((f) => f.path === target.folderPath);
    const folder = folderIdx !== -1 ? folders.value[folderIdx] : undefined;
    return [
      { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.folderPath), icon: FolderSearch },
      { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.folderPath), icon: Copy },
      { label: "", separator: true },
      { label: t("sqlFileTree.expandAll"), action: () => folder && setAllExpanded(folder, true), icon: ChevronsUpDown, disabled: !folder },
      { label: t("sqlFileTree.collapseAll"), action: () => folder && setAllExpanded(folder, false), icon: ChevronsDownUp, disabled: !folder },
      { label: "", separator: true },
      { label: t("sqlFileTree.refreshFolder"), action: () => refreshFolder(target.folderPath), icon: RefreshCw },
      { label: "", separator: true },
      { label: t("sqlFileTree.removeFolder"), action: () => folderIdx !== -1 && removeFolder(folderIdx), icon: Trash2, variant: "destructive" },
    ];
  }

  if (target.kind === "dir") {
    return [
      { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch },
      { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy },
      { label: "", separator: true },
      { label: t("sqlFileTree.expandAll"), action: () => expandSubtree(target), icon: ChevronsUpDown },
      { label: t("sqlFileTree.collapseAll"), action: () => collapseSubtree(target), icon: ChevronsDownUp },
    ];
  }

  // file
  return [
    { label: t("sqlFileTree.openFile"), action: () => openFile(target.entry.path), icon: FileCode },
    { label: t("sqlFileTree.executeSqlFile"), action: () => executeFile(target.entry.path), icon: Play },
    { label: "", separator: true },
    { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch },
    { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy },
  ];
});

function expandSubtree(target: Extract<ContextTarget, { kind: "dir" }>) {
  const folder = folders.value.find((f) => f.path === target.folderPath);
  if (!folder) return;
  const next = new Set(folder.expanded);
  next.add(target.entry.path);
  collectDirPaths(target.entry.children, next);
  folder.expanded = next;
}

function collapseSubtree(target: Extract<ContextTarget, { kind: "dir" }>) {
  const folder = folders.value.find((f) => f.path === target.folderPath);
  if (!folder) return;
  const subtree = new Set<string>();
  collectDirPaths(target.entry.children, subtree);
  subtree.add(target.entry.path);
  const next = new Set<string>();
  for (const p of folder.expanded) {
    if (!subtree.has(p)) next.add(p);
  }
  folder.expanded = next;
}

function clearContextTarget() {
  contextTarget.value = null;
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("sqlFileTree.title") }}</span>
      <span class="flex-1" />
      <LightTooltip v-if="folders.length > 0" :text="t('sqlFileTree.refreshAll')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="refreshAll">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sqlFileTree.openFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="pickFolder">
          <FolderOpen class="h-3 w-3" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sqlFileTree.closePanel')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
          <X class="h-3 w-3" />
        </Button>
      </LightTooltip>
    </div>

    <CustomContextMenu :items="contextMenuItems" @close="clearContextTarget">
      <template #default="{ onContextMenu }">
        <div
          class="flex-1 overflow-y-auto"
          @click="handlePanelClick"
          @contextmenu.capture="contextTarget = { kind: 'panel' }"
          @contextmenu.prevent="
            contextTarget = { kind: 'panel' };
            onContextMenu($event);
          "
        >
          <div v-if="folders.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
            <span>{{ t("sqlFileTree.noFolder") }}</span>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="pickFolder"> <FolderOpen class="h-3.5 w-3.5 mr-1" />{{ t("sqlFileTree.openFolder") }} </Button>
          </div>

          <div v-else>
            <div v-for="(folder, fi) in folders" :key="folder.path" class="border-b last:border-b-0">
              <div
                data-sql-file-row="true"
                class="flex cursor-default items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-muted-foreground bg-muted/10 sticky top-0 select-none"
                :class="isPathHighlighted(folder.path) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'"
                @click.stop="handlePathClick(folder.path, 'folderHeader', $event, () => toggleFolderCollapse(folder))"
                @contextmenu.capture="
                  contextTarget = { kind: 'folderHeader', folderPath: folder.path };
                  activePath = folder.path;
                "
                @contextmenu.prevent="
                  contextTarget = { kind: 'folderHeader', folderPath: folder.path };
                  activePath = folder.path;
                  onContextMenu($event);
                "
              >
                <ChevronRight v-if="folder.collapsed" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <FolderOpen class="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span class="truncate shrink-0" :title="folder.path">{{ folderName(folder.path) }}</span>
                <span class="truncate flex-1 text-[10px] text-muted-foreground/50" :title="folder.path">{{ folder.path }}</span>
                <LightTooltip :text="t('sqlFileTree.refreshFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground" @click.stop="refreshFolder(folder.path)">
                    <RefreshCw class="h-3 w-3" :class="folder.loading ? 'animate-spin' : ''" />
                  </Button>
                </LightTooltip>
                <LightTooltip :text="t('sqlFileTree.revealInFileManager')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground" @click.stop="revealInFileManager(folder.path)">
                    <FolderSearch class="h-3 w-3" />
                  </Button>
                </LightTooltip>
                <LightTooltip :text="t('sqlFileTree.removeFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive" @click.stop="removeFolder(fi)">
                    <Trash2 class="h-3 w-3" />
                  </Button>
                </LightTooltip>
              </div>
              <div v-show="!folder.collapsed">
                <div v-if="folder.loading" class="px-3 py-2 text-xs text-muted-foreground">
                  {{ t("sqlFileTree.loading") }}
                </div>
                <div v-else-if="folder.entries.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
                  {{ t("sqlFileTree.noSqlFiles") }}
                </div>
                <div v-else>
                  <div
                    data-sql-file-row="true"
                    v-for="{ entry, depth } in flatTree(folder.entries, folder.expanded)"
                    :key="entry.path"
                    class="flex cursor-default select-none items-center gap-1 px-2 py-1 text-sm"
                    :class="[entry.is_dir ? 'rounded-sm' : 'rounded-none', isPathHighlighted(entry.path) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40']"
                    :style="{ paddingLeft: depth * 16 + 8 + 'px' }"
                    @click.stop="handlePathClick(entry.path, entry.is_dir ? 'dir' : 'file', $event, () => (entry.is_dir ? toggleExpand(folder, entry.path) : openFile(entry.path)))"
                    @contextmenu.capture="
                      contextTarget = entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry } : { kind: 'file', folderPath: folder.path, entry };
                      activePath = entry.path;
                    "
                    @contextmenu.prevent="
                      contextTarget = entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry } : { kind: 'file', folderPath: folder.path, entry };
                      activePath = entry.path;
                      onContextMenu($event);
                    "
                  >
                    <template v-if="entry.is_dir">
                      <ChevronRight v-if="!folder.expanded.has(entry.path)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <FolderClosed v-if="!folder.expanded.has(entry.path)" class="h-4 w-4 shrink-0 text-amber-500" />
                      <FolderOpen v-else class="h-4 w-4 shrink-0 text-amber-500" />
                    </template>
                    <template v-else>
                      <span class="w-3.5 shrink-0" />
                      <FileCode class="h-4 w-4 shrink-0 text-blue-500" />
                    </template>
                    <span class="truncate ml-1">{{ entry.name }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </CustomContextMenu>
  </div>
</template>
