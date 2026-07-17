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
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { copyToClipboard } from "@/lib/common/clipboard";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";

const STORAGE_KEY = "dbx-sql-file-folders";

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

// The currently highlighted tree row (file or folder path). Set on click or
// right-click so the user sees which item an opened context menu refers to.
const selectedPath = ref<string | null>(null);

function selectPath(path: string | null) {
  selectedPath.value = path;
}

function loadSavedFolders(): string[] {
  try {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveFolders() {
  const paths = folders.value.map((f) => f.path);
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(paths));
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
  toast(t("sqlFileTree.refreshed"), 1500);
}

async function refreshAll() {
  await Promise.all(folders.value.map((f) => loadFolderEntries(f.path)));
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
    toast(t("sqlFileTree.revealFailed", { message: e?.message || String(e) }), 5000);
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
    const content = await api.readExternalSqlFile(path);
    const connectionId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = connection ? resolveDefaultDatabase(connection, []) : "";
    queryStore.openExternalSqlFile(connectionId, database, path, content);
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
  }
}

// Open the App-level SQL file execution dialog with this file pre-selected so
// the user can review its statements and pick a connection/database before run.
function executeFile(path: string) {
  connectionStore.sqlFileSource = {
    connectionId: connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "",
    database: "",
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
          @contextmenu.capture="contextTarget = { kind: 'panel' }"
          @contextmenu.prevent="
            contextTarget = { kind: 'panel' };
            onContextMenu($event);
          "
          @click.self="selectPath(null)"
        >
          <div v-if="folders.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
            <span>{{ t("sqlFileTree.noFolder") }}</span>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="pickFolder"> <FolderOpen class="h-3.5 w-3.5 mr-1" />{{ t("sqlFileTree.openFolder") }} </Button>
          </div>

          <div v-else>
            <div v-for="(folder, fi) in folders" :key="folder.path" class="border-b last:border-b-0">
              <div
                class="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-muted-foreground bg-muted/10 sticky top-0 cursor-pointer select-none hover:bg-muted/30"
                :class="selectedPath === folder.path ? 'bg-accent/60 text-accent-foreground' : ''"
                @click="
                  toggleFolderCollapse(folder);
                  selectPath(folder.path);
                "
                @contextmenu.capture="
                  contextTarget = { kind: 'folderHeader', folderPath: folder.path };
                  selectPath(folder.path);
                "
                @contextmenu.prevent="
                  contextTarget = { kind: 'folderHeader', folderPath: folder.path };
                  selectPath(folder.path);
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
                    v-for="{ entry, depth } in flatTree(folder.entries, folder.expanded)"
                    :key="entry.path"
                    class="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-muted/60 text-sm"
                    :class="[entry.is_dir ? 'rounded-sm' : 'rounded-none', selectedPath === entry.path ? 'bg-accent text-accent-foreground' : '']"
                    :style="{ paddingLeft: depth * 16 + 8 + 'px' }"
                    @click="
                      selectPath(entry.path);
                      entry.is_dir ? toggleExpand(folder, entry.path) : openFile(entry.path);
                    "
                    @contextmenu.capture="
                      contextTarget = entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry } : { kind: 'file', folderPath: folder.path, entry };
                      selectPath(entry.path);
                    "
                    @contextmenu.prevent="
                      contextTarget = entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry } : { kind: 'file', folderPath: folder.path, entry };
                      selectPath(entry.path);
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
