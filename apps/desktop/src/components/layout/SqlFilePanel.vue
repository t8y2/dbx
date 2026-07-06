<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, FileCode, FolderClosed, ChevronRight, ChevronDown, X, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
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
  try {
    const entries = await api.listSqlFilesInFolder(folderPath);
    // Mutate via the reactive proxy (folders.value[idx]) so Vue tracks the
    // change. Mutating the local `folder` object bypasses the proxy and the
    // view never updates until some other reactive write forces a re-render.
    const idx = folders.value.findIndex((f) => f.path === folderPath);
    if (idx !== -1) {
      folders.value[idx].entries = entries;
    }
  } catch (e: any) {
    toast(t("sqlFileTree.loadFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    const idx = folders.value.findIndex((f) => f.path === folderPath);
    if (idx !== -1) {
      folders.value[idx].loading = false;
    }
  }
}

async function removeFolder(index: number) {
  folders.value.splice(index, 1);
  saveFolders();
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

async function openFile(path: string) {
  if (!isTauriRuntime()) return;
  try {
    const content = await api.readExternalSqlFile(path);
    const connectionId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = connection ? resolveDefaultDatabase(connection, []) : "";
    const name = path.split("\\").pop()?.split("/").pop() || "script.sql";
    const tabId = queryStore.createTab(connectionId, database, name, "query");
    queryStore.updateSql(tabId, content);
    queryStore.linkExternalSqlPath(tabId, path, name);
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
  }
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
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex items-center gap-px px-3 text-xs font-medium text-muted-foreground border-b bg-muted/20 h-10 shrink-0">
      <span class="flex self-stretch items-center truncate">{{ t("sqlFileTree.title") }}</span>
      <span class="flex-1 self-stretch" />
      <LightTooltip :text="t('sqlFileTree.openFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="pickFolder">
          <FolderOpen class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sqlFileTree.closePanel')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
          <X class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
    </div>

    <div v-if="folders.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
      <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
      <span>{{ t("sqlFileTree.noFolder") }}</span>
      <Button variant="outline" size="sm" class="h-7 text-xs" @click="pickFolder"> <FolderOpen class="h-3.5 w-3.5 mr-1" />{{ t("sqlFileTree.openFolder") }} </Button>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <div v-for="(folder, fi) in folders" :key="folder.path" class="border-b last:border-b-0">
        <div class="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-muted-foreground bg-muted/10 sticky top-0 cursor-pointer select-none hover:bg-muted/30" @click="toggleFolderCollapse(folder)">
          <ChevronRight v-if="folder.collapsed" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <FolderOpen class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span class="truncate shrink-0" :title="folder.path">{{ folderName(folder.path) }}</span>
          <span class="truncate flex-1 text-[10px] text-muted-foreground/50" :title="folder.path">{{ folder.path }}</span>
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
              class="flex items-center gap-1 px-2 py-1 cursor-pointer rounded-sm hover:bg-muted/60 text-sm"
              :style="{ paddingLeft: depth * 16 + 8 + 'px' }"
              @click="entry.is_dir ? toggleExpand(folder, entry.path) : openFile(entry.path)"
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
