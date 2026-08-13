<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, FileCode, FolderClosed, ChevronRight, ChevronDown, X, Trash2, RefreshCw, FolderSearch, Copy, Play, ChevronsUpDown, ChevronsDownUp, Settings, ShieldAlert, FilePlus, FolderPlus, Pencil, LocateFixed, History } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import ProjectSettingsDialog from "@/components/layout/ProjectSettingsDialog.vue";
import SqlFileHistoryDialog from "@/components/layout/SqlFileHistoryDialog.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { translateBackendError } from "@/i18n/backend-errors";
import { copyToClipboard } from "@/lib/common/clipboard";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { externalSqlFileOpenErrorMessage, formatSqlFileSize, isExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";
import { focusSidebarRenameInput } from "@/lib/sidebar/sidebarRenameFocus";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";
import type { SqlProject } from "@/lib/backend/tauri";
import { notifySqlFileFoldersChanged } from "@/lib/sqlFile/sqlFileFolders";
import { orderedListRangeAnchorIndex, orderedListSelectionIntent, type OrderedListSelectionItem } from "@/lib/selection/orderedListSelection";
import { useFolderWatcherLifecycle } from "@/composables/useFolderWatcherLifecycle";

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const projectStore = useProjectStore();
const { toast } = useToast();

interface FolderState {
  project: SqlProject;
  path: string;
  entries: SqlFileEntry[];
  expanded: Set<string>;
  loading: boolean;
  collapsed: boolean;
}

const folders = ref<FolderState[]>([]);

// Right-click target. `kind` discriminates between a folder header, a tree
// directory entry, and a tree file entry. `folderPath` is the owning top-level
// project root (for refresh scoping); `entryPath` is the right-clicked node path.
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

function selectPath(path: string | null) {
  if (path === null) {
    clearSelection();
    return;
  }
  selectedPaths.value = new Set([path]);
  activePath.value = path;
  const index = visibleItems.value.findIndex((item) => item.id === path);
  selectionAnchorIndex.value = index >= 0 ? index : null;
}

function isPathHighlighted(path: string) {
  return activePath.value === path || selectedPaths.value.has(path);
}

function normalizeSqlPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativeToRoot(rootPath: string, absPath: string): string {
  const root = normalizeSqlPath(rootPath);
  const target = normalizeSqlPath(absPath);
  if (target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return target.slice(root.length + 1);
  return target.split("/").pop() || target;
}

function pathIsUnder(path: string, rootPath: string): boolean {
  const root = normalizeSqlPath(rootPath);
  const target = normalizeSqlPath(path);
  return target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(`${root.toLowerCase()}/`);
}

// ---- project <-> panel section sync ----

function createFolderState(project: SqlProject): FolderState {
  return {
    project,
    path: project.rootPath,
    entries: [],
    expanded: new Set(),
    loading: true,
    collapsed: false,
  };
}

function syncFromProjects() {
  const wanted = projectStore.projects;
  for (const folder of folders.value) {
    if (!wanted.some((project) => project.id === folder.project.id)) dropFolderWatcher(folder.path);
  }
  folders.value = folders.value.filter((folder) => wanted.some((project) => project.id === folder.project.id));
  for (const folder of folders.value) {
    const updated = wanted.find((project) => project.id === folder.project.id);
    if (updated) folder.project = updated;
  }
  for (const project of wanted) {
    if (!folders.value.some((folder) => folder.project.id === project.id)) {
      folders.value.push(createFolderState(project));
      void loadFolderEntries(project.rootPath);
      // watcher 由 useFolderWatcherLifecycle 管理仅激活项目
    }
  }
  folders.value.sort((a, b) => wanted.findIndex((p) => p.id === a.project.id) - wanted.findIndex((p) => p.id === b.project.id));
  queueTrustPrompts();
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
    await projectStore.openProjectByPath(folderPath);
  } catch (e: any) {
    toast(t("sqlFileTree.openFailed", { message: e?.message || String(e) }), 5000);
  }
}

// Re-scan a single top-level project and replace its entries. Mutated via the
// reactive proxy (folders.value[idx]) so Vue tracks the change. `silent` skips
// the loading indicator and error toasts (used by window-focus background refresh).
async function loadFolderEntries(folderPath: string, options: { silent?: boolean } = {}) {
  const idx = folders.value.findIndex((f) => f.path === folderPath);
  if (idx === -1) return;
  if (!options.silent) folders.value[idx].loading = true;
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
    if (!options.silent) toast(t("sqlFileTree.loadFailed", { message: e?.message || String(e) }), 5000);
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
  await projectStore.loadProjects({ force: true });
  await Promise.all(folders.value.map((f) => loadFolderEntries(f.path)));
  notifySqlFileFoldersChanged();
  toast(t("sqlFileTree.refreshed"), 1500);
}

function findFolder(folderPath: string): FolderState | undefined {
  return folders.value.find((f) => f.path === folderPath);
}

function findFolderForPath(path: string): FolderState | undefined {
  return folders.value.find((f) => pathIsUnder(path, f.project.rootPath));
}

// ---- single active project view（单激活项目视图） ----

// 树只渲染当前激活项目，其余项目通过顶部切换器切换。
const activeFolder = computed<FolderState | null>(() => {
  const id = projectStore.activeProjectId;
  return folders.value.find((folder) => folder.project.id === id) ?? folders.value[0] ?? null;
});

const visibleFolders = computed<FolderState[]>(() => (activeFolder.value ? [activeFolder.value] : []));

const showProjectSwitcher = ref(false);

function toggleProjectSwitcher() {
  showProjectSwitcher.value = !showProjectSwitcher.value;
}

async function switchProject(project: SqlProject) {
  showProjectSwitcher.value = false;
  if (project.id === projectStore.activeProjectId) return;
  try {
    await projectStore.openProjectByPath(project.rootPath, { activate: true });
  } catch (e: any) {
    toast(t("sqlFileTree.openFailed", { message: e?.message || String(e) }), 5000);
  }
}

function requestRemoveProjectByProject(project: SqlProject) {
  const folder = folders.value.find((f) => f.project.id === project.id);
  if (folder) requestRemoveProject(folder);
}

// ---- dirty markers（未保存状态上树） ----

// 已打开且未保存的外部 SQL 文件路径集合（归一化小写），用于在树中显示 * 标记。
const dirtyExternalPaths = computed(() => {
  const set = new Set<string>();
  for (const tab of queryStore.tabs) {
    if (tab.mode === "query" && tab.externalSqlPath && queryStore.isTabDirty(tab)) {
      set.add(normalizeSqlPath(tab.externalSqlPath).toLowerCase());
    }
  }
  return set;
});

function isEntryDirty(path: string): boolean {
  return dirtyExternalPaths.value.has(normalizeSqlPath(path).toLowerCase());
}

// ---- local history（本地历史） ----

const historyTarget = ref<{ project: SqlProject; path: string } | null>(null);
const showFileHistory = ref(false);

function openFileHistory(folder: FolderState, entry: SqlFileEntry) {
  historyTarget.value = { project: folder.project, path: entry.path };
  showFileHistory.value = true;
}

// ---- file system watch（文件系统监视增量刷新） ----

// 每个项目根目录一个 watcher；插件自带 delayMs 防抖。自身保存触发的重扫是
// 只读操作，不会再次写盘，因此不会形成循环，无需额外抑制回显。
const folderWatchers = new Map<string, () => void>();
let watchModulePromise: Promise<typeof import("@tauri-apps/plugin-fs")> | null = null;

async function ensureFolderWatcher(folderPath: string) {
  if (!isTauriRuntime() || folderWatchers.has(folderPath)) return;
  try {
    watchModulePromise = watchModulePromise ?? import("@tauri-apps/plugin-fs");
    const { watch } = await watchModulePromise;
    const unwatch = await watch(
      folderPath,
      () => {
        void loadFolderEntries(folderPath, { silent: true });
      },
      { recursive: true, delayMs: 400 },
    );
    folderWatchers.set(folderPath, unwatch);
  } catch {
    // 监听不可用时退回"窗口聚焦刷新"，不影响面板基本使用
  }
}

function dropFolderWatcher(folderPath: string) {
  const unwatch = folderWatchers.get(folderPath);
  if (!unwatch) return;
  try {
    unwatch();
  } catch {
    // ignore
  }
  folderWatchers.delete(folderPath);
}

// ---- watcher 生命周期：仅激活项目 watch，切换时自动拆除/创建 ----
const activeFolderPath = computed(() => activeFolder.value?.path ?? null);
const watcherLifecycle = useFolderWatcherLifecycle({
  activeFolderPath,
  ensureWatcher: (path) => void ensureFolderWatcher(path),
  dropWatcher: (path) => dropFolderWatcher(path),
  rescan: (path) => void loadFolderEntries(path, { silent: true }),
  isEnabled: () => isTauriRuntime(),
});

// ---- trust flow ----

const trustPrompt = ref<FolderState | null>(null);
const trustQueue = ref<FolderState[]>([]);
const trustPromptedIds = new Set<string>();

function queueTrustPrompts() {
  for (const folder of folders.value) {
    if (!folder.project.trusted && !trustPromptedIds.has(folder.project.id)) {
      trustPromptedIds.add(folder.project.id);
      trustQueue.value.push(folder);
    }
  }
  processTrustQueue();
}

function processTrustQueue() {
  if (trustPrompt.value || trustQueue.value.length === 0) return;
  const folder = trustQueue.value.shift()!;
  if (folder.project.trusted || !folders.value.includes(folder)) {
    processTrustQueue();
    return;
  }
  trustPrompt.value = folder;
}

async function confirmTrust() {
  const folder = trustPrompt.value;
  trustPrompt.value = null;
  if (folder) {
    try {
      await projectStore.markTrusted(folder.project);
    } catch (e: any) {
      toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
    }
  }
  processTrustQueue();
}

function declineTrust() {
  trustPrompt.value = null;
  processTrustQueue();
}

/** Returns false (and shows the trust dialog) when the project is not trusted yet. */
function ensureTrusted(folder: FolderState): boolean {
  if (folder.project.trusted) return true;
  trustPromptedIds.add(folder.project.id);
  trustPrompt.value = folder;
  return false;
}

// ---- connection injection ----

function boundConnectionId(folder: FolderState): string {
  const id = folder.project.connectionId;
  return id && connectionStore.getConfig(id) ? id : "";
}

function executionConnectionId(folder: FolderState): string {
  return boundConnectionId(folder) || connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
}

// ---- open / execute ----

async function openFile(folder: FolderState, path: string) {
  if (!isTauriRuntime()) return;
  if (!ensureTrusted(folder)) return;
  try {
    const snapshot = await api.readExternalSqlFileSnapshot(path);
    const connectionId = executionConnectionId(folder);
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = connection ? resolveDefaultDatabase(connection, []) : "";
    const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), { connectionId, database });
    queryStore.openExternalSqlFile(target.connectionId, target.database, path, snapshot.content, snapshot.version, {
      catalog: target.catalog,
      projectId: folder.project.id,
      fileEncoding: snapshot.encoding,
      fileLineEnding: snapshot.lineEnding,
    });
  } catch (e: any) {
    if (isExternalSqlFileTooLargeError(e)) {
      executeFile(folder, path);
      toast(t("sqlFile.largeFileExecutionOpened", { size: formatSqlFileSize(e.sizeBytes) }), 6000);
      return;
    }
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
  }
}

// Open the App-level SQL file execution dialog with this file pre-selected so
// the user can review its statements and pick a connection/database before run.
function executeFile(folder: FolderState, path: string) {
  if (!ensureTrusted(folder)) return;
  connectionStore.sqlFileSource = {
    connectionId: executionConnectionId(folder),
    database: "",
    filePath: path,
  };
}

function collectFileSqlPaths(entries: SqlFileEntry[], into: string[]) {
  for (const entry of entries) {
    if (entry.is_dir) collectFileSqlPaths(entry.children, into);
    else into.push(entry.path);
  }
}

// Run every SQL file beneath a directory via the execution dialog (multi-file).
function executeFolder(folder: FolderState, entry: SqlFileEntry) {
  if (!ensureTrusted(folder)) return;
  const paths: string[] = [];
  collectFileSqlPaths(entry.children, paths);
  if (paths.length === 0) {
    toast(t("sqlFileTree.executeFolderEmpty"), 3000);
    return;
  }
  connectionStore.sqlFileSource = {
    connectionId: executionConnectionId(folder),
    database: "",
    filePaths: paths,
  };
}

// ---- create / rename / delete entries ----

type CreatingTarget = { folderPath: string; parentPath: string | null; kind: "file" | "folder" };
const creatingTarget = ref<CreatingTarget | null>(null);
const creatingName = ref("");
const creatingInputRef = ref<HTMLInputElement | null>(null);

function setCreatingInputRef(el: unknown) {
  creatingInputRef.value = (el as HTMLInputElement) ?? null;
}

function siblingNames(folder: FolderState, parentPath: string | null): Set<string> {
  if (!parentPath) return new Set(folder.entries.map((entry) => entry.name.toLowerCase()));
  const names = new Set<string>();
  const walk = (entries: SqlFileEntry[]): boolean => {
    for (const entry of entries) {
      if (entry.path === parentPath) {
        for (const child of entry.children) names.add(child.name.toLowerCase());
        return true;
      }
      if (entry.is_dir && walk(entry.children)) return true;
    }
    return false;
  };
  walk(folder.entries);
  return names;
}

function uniqueName(base: string, extension: string | null, taken: Set<string>): string {
  const build = (candidate: string) => (extension ? `${candidate}${extension}` : candidate);
  let candidate = build(base);
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = build(`${base} (${counter})`);
    counter++;
  }
  return candidate;
}

function startCreate(folder: FolderState, parentPath: string | null, kind: "file" | "folder") {
  if (!ensureTrusted(folder)) return;
  if (parentPath) {
    const next = new Set(folder.expanded);
    next.add(parentPath);
    folder.expanded = next;
  }
  folder.collapsed = false;
  const taken = siblingNames(folder, parentPath);
  creatingName.value = kind === "file" ? uniqueName("new_query", ".sql", taken) : uniqueName(t("sqlFileTree.newFolderDefault"), null, taken);
  creatingTarget.value = { folderPath: folder.path, parentPath, kind };
  nextTick(() => {
    focusSidebarRenameInput(() => creatingInputRef.value ?? undefined);
  });
}

function cancelCreate() {
  creatingTarget.value = null;
  creatingName.value = "";
}

async function confirmCreate() {
  const creating = creatingTarget.value;
  if (!creating) return;
  const folder = findFolder(creating.folderPath);
  creatingTarget.value = null;
  const rawName = creatingName.value.trim();
  creatingName.value = "";
  if (!folder || !rawName) return;
  try {
    const parentRelative = creating.parentPath ? relativeToRoot(folder.project.rootPath, creating.parentPath) : "";
    if (creating.kind === "file") {
      const name = /\.sql$/i.test(rawName) ? rawName : `${rawName}.sql`;
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      const result = await api.createProjectFile(folder.project.rootPath, relativePath, "");
      await loadFolderEntries(folder.path);
      void openFile(folder, result.path);
    } else {
      const relativePath = parentRelative ? `${parentRelative}/${rawName}` : rawName;
      await api.createProjectFolder(folder.project.rootPath, relativePath);
      await loadFolderEntries(folder.path);
    }
    notifySqlFileFoldersChanged();
  } catch (e: any) {
    toast(t("sqlFileTree.createFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

type RenamingTarget = { folderPath: string; entryPath: string; isDir: boolean };
const renamingTarget = ref<RenamingTarget | null>(null);
const renameValue = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);

function setRenameInputRef(el: unknown) {
  renameInputRef.value = (el as HTMLInputElement) ?? null;
}

function isRenaming(entryPath: string): boolean {
  return renamingTarget.value?.entryPath === entryPath;
}

function startRename(folder: FolderState, entry: SqlFileEntry) {
  renamingTarget.value = { folderPath: folder.path, entryPath: entry.path, isDir: entry.is_dir };
  renameValue.value = entry.name;
  nextTick(() => {
    focusSidebarRenameInput(() => renameInputRef.value ?? undefined);
  });
}

function cancelRename() {
  renamingTarget.value = null;
  renameValue.value = "";
}

async function confirmRename() {
  const renaming = renamingTarget.value;
  if (!renaming) return;
  const folder = findFolder(renaming.folderPath);
  renamingTarget.value = null;
  const newName = renameValue.value.trim();
  renameValue.value = "";
  if (!folder || !newName) return;
  try {
    const result = await api.renameProjectEntry(folder.project.rootPath, relativeToRoot(folder.project.rootPath, renaming.entryPath), newName);
    if (renaming.isDir) {
      queryStore.syncExternalSqlFolderPrefix(renaming.entryPath, result.path);
    } else {
      queryStore.syncExternalSqlFilePath(renaming.entryPath, result.path);
    }
    await loadFolderEntries(folder.path);
    notifySqlFileFoldersChanged();
  } catch (e: any) {
    toast(t("sqlFileTree.renameFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

const deleteTarget = ref<{ folder: FolderState; entryPath: string; isDir: boolean; name: string; fileCount: number } | null>(null);
const showDeleteConfirm = ref(false);
const deletingEntry = ref(false);

async function requestDelete(folder: FolderState, entry: SqlFileEntry) {
  if (!ensureTrusted(folder)) return;
  let fileCount = 0;
  if (entry.is_dir) {
    try {
      fileCount = await api.countProjectEntryFiles(folder.project.rootPath, relativeToRoot(folder.project.rootPath, entry.path));
    } catch {
      fileCount = 0;
    }
  }
  deleteTarget.value = { folder, entryPath: entry.path, isDir: entry.is_dir, name: entry.name, fileCount };
  showDeleteConfirm.value = true;
}

async function executeDelete() {
  const target = deleteTarget.value;
  if (!target || deletingEntry.value) return;
  deletingEntry.value = true;
  try {
    await api.deleteProjectEntryToTrash(target.folder.project.rootPath, relativeToRoot(target.folder.project.rootPath, target.entryPath));
    if (target.isDir) {
      queryStore.markExternalSqlFilesUnderDirMissing(target.entryPath);
    } else {
      // Keep the tab open with its content; it will surface as missing on next save.
    }
    await loadFolderEntries(target.folder.path);
    notifySqlFileFoldersChanged();
  } catch (e: any) {
    toast(t("sqlFileTree.deleteFailed", { message: translateBackendError(t, e) }), 5000);
  } finally {
    deletingEntry.value = false;
    showDeleteConfirm.value = false;
    deleteTarget.value = null;
  }
}

// ---- project settings / removal ----

const settingsProject = ref<SqlProject | null>(null);
const showProjectSettings = ref(false);

function openProjectSettings(folder: FolderState) {
  settingsProject.value = folder.project;
  showProjectSettings.value = true;
}

async function saveProjectSettings(project: SqlProject) {
  try {
    await projectStore.updateProject(project);
  } catch (e: any) {
    toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
  }
}

const removeProjectTarget = ref<FolderState | null>(null);
const showRemoveProjectConfirm = ref(false);

function requestRemoveProject(folder: FolderState) {
  removeProjectTarget.value = folder;
  showRemoveProjectConfirm.value = true;
}

async function executeRemoveProject() {
  const folder = removeProjectTarget.value;
  showRemoveProjectConfirm.value = false;
  removeProjectTarget.value = null;
  if (!folder) return;
  try {
    await projectStore.removeProject(folder.project.id);
  } catch (e: any) {
    toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
  }
}

// ---- reveal active file (Scroll from Source) ----

async function revealActiveFile() {
  const activeTab = queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId);
  const path = activeTab?.externalSqlPath;
  if (!path) {
    toast(t("sqlFileTree.noFileToReveal"), 3000);
    return;
  }
  let folder = findFolderForPath(path);
  if (!folder) {
    const project = projectStore.projectForFilePath(path);
    if (!project) {
      toast(t("sqlFileTree.noFileToReveal"), 3000);
      return;
    }
    await projectStore.openProjectByPath(project.rootPath, { activate: false });
    folder = findFolderForPath(path);
    if (!folder) return;
  }
  folder.collapsed = false;
  if (folder.entries.length === 0) await loadFolderEntries(folder.path);
  const target = normalizeSqlPath(path);
  const next = new Set(folder.expanded);
  let found = false;
  const walk = (entries: SqlFileEntry[]): boolean => {
    for (const entry of entries) {
      const entryNorm = normalizeSqlPath(entry.path);
      if (entry.is_dir) {
        if (target.toLowerCase().startsWith(`${entryNorm.toLowerCase()}/`)) {
          next.add(entry.path);
          if (walk(entry.children)) return true;
        }
      } else if (entryNorm.toLowerCase() === target.toLowerCase()) {
        found = true;
        return true;
      }
    }
    return false;
  };
  walk(folder.entries);
  folder.expanded = next;
  if (!found) {
    toast(t("sqlFileTree.noFileToReveal"), 3000);
    return;
  }
  activePath.value = path;
  await nextTick();
  document.querySelector(`[data-sql-file-row="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "center" });
}

// ---- tree helpers ----

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

// Expand/collapse every directory beneath the given top-level project.
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

type TreeRow = { type: "entry"; entry: SqlFileEntry; depth: number } | { type: "create"; depth: number };

function rowsFor(folder: FolderState): TreeRow[] {
  const creating = creatingTarget.value;
  const result: TreeRow[] = [];
  const walk = (items: SqlFileEntry[], depth: number, parentPath: string | null) => {
    if (creating && creating.folderPath === folder.path && creating.parentPath === parentPath) {
      result.push({ type: "create", depth });
    }
    for (const item of items) {
      result.push({ type: "entry", entry: item, depth });
      if (item.is_dir && folder.expanded.has(item.path)) {
        walk(item.children, depth + 1, item.path);
      }
    }
  };
  walk(folder.entries, 0, null);
  return result;
}

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

function projectConnectionLabel(folder: FolderState): string {
  const id = folder.project.connectionId;
  if (!id) return t("sqlFileTree.noBoundConnection");
  return connectionStore.connections.find((connection) => connection.id === id)?.name || t("sqlFileTree.noBoundConnection");
}

onMounted(async () => {
  if (!isTauriRuntime()) return;
  window.addEventListener("focus", handleWindowFocus);
  try {
    await projectStore.loadProjects();
    syncFromProjects();
    watcherLifecycle.init();
  } catch {
    /* startup load errors surface via toast on later interactions */
  }
});

// 窗口聚焦时仅重扫激活项目（非全项目），减少后台 I/O。
function handleWindowFocus() {
  watcherLifecycle.handleFocus();
}

onBeforeUnmount(() => {
  window.removeEventListener("focus", handleWindowFocus);
  watcherLifecycle.cleanup();
});

watch(
  () => projectStore.projects,
  () => syncFromProjects(),
  { deep: true },
);

// Auto-open project settings when a brand-new project is created (OS drop / menu),
// so the user can immediately bind a connection. Consumes pendingSettingsProjectId.
watch(
  () => projectStore.pendingSettingsProjectId && projectStore.projects.find((p) => p.id === projectStore.pendingSettingsProjectId),
  (pendingProject) => {
    if (!pendingProject) return;
    projectStore.takePendingSettingsProject();
    settingsProject.value = pendingProject;
    showProjectSettings.value = true;
  },
  { immediate: true },
);

// ---- ordered list selection (from origin/main) ----
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
    const items: ContextMenuItem[] = [{ label: t("sqlFileTree.openProject"), action: pickFolder, icon: FolderOpen }];
    if (folders.value.length > 0) {
      items.push({ label: "", separator: true });
      items.push({ label: t("sqlFileTree.refreshAll"), action: refreshAll, icon: RefreshCw });
    }
    return items;
  }

  if (target.kind === "folderHeader") {
    const folder = findFolder(target.folderPath);
    return [
      { label: t("sqlFileTree.newSqlFile"), action: () => folder && startCreate(folder, null, "file"), icon: FilePlus, disabled: !folder },
      { label: t("sqlFileTree.newFolder"), action: () => folder && startCreate(folder, null, "folder"), icon: FolderPlus, disabled: !folder },
      { label: "", separator: true },
      { label: t("sqlFileTree.projectSettings"), action: () => folder && openProjectSettings(folder), icon: Settings, disabled: !folder },
      { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.folderPath), icon: FolderSearch },
      { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.folderPath), icon: Copy },
      { label: "", separator: true },
      { label: t("sqlFileTree.expandAll"), action: () => folder && setAllExpanded(folder, true), icon: ChevronsUpDown, disabled: !folder },
      { label: t("sqlFileTree.collapseAll"), action: () => folder && setAllExpanded(folder, false), icon: ChevronsDownUp, disabled: !folder },
      { label: "", separator: true },
      { label: t("sqlFileTree.refreshFolder"), action: () => refreshFolder(target.folderPath), icon: RefreshCw },
      { label: "", separator: true },
      { label: t("sqlFileTree.removeProject"), action: () => folder && requestRemoveProject(folder), icon: Trash2, variant: "destructive", disabled: !folder },
    ];
  }

  if (target.kind === "dir") {
    const folder = findFolder(target.folderPath);
    return [
      { label: t("sqlFileTree.newSqlFile"), action: () => folder && startCreate(folder, target.entry.path, "file"), icon: FilePlus, disabled: !folder },
      { label: t("sqlFileTree.newFolder"), action: () => folder && startCreate(folder, target.entry.path, "folder"), icon: FolderPlus, disabled: !folder },
      { label: "", separator: true },
      { label: t("sqlFileTree.executeFolder"), action: () => folder && executeFolder(folder, target.entry), icon: Play, disabled: !folder },
      { label: "", separator: true },
      { label: t("sqlFileTree.rename"), action: () => folder && startRename(folder, target.entry), icon: Pencil, disabled: !folder },
      { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch },
      { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy },
      { label: "", separator: true },
      { label: t("sqlFileTree.expandAll"), action: () => expandSubtree(target), icon: ChevronsUpDown },
      { label: t("sqlFileTree.collapseAll"), action: () => collapseSubtree(target), icon: ChevronsDownUp },
      { label: "", separator: true },
      { label: t("sqlFileTree.delete"), action: () => folder && requestDelete(folder, target.entry), icon: Trash2, variant: "destructive", disabled: !folder },
    ];
  }

  // file
  const folder = findFolder(target.folderPath);
  return [
    { label: t("sqlFileTree.openFile"), action: () => folder && openFile(folder, target.entry.path), icon: FileCode, disabled: !folder },
    { label: t("sqlFileTree.executeSqlFile"), action: () => folder && executeFile(folder, target.entry.path), icon: Play, disabled: !folder },
    { label: t("sqlFileTree.localHistory"), action: () => folder && openFileHistory(folder, target.entry), icon: History, disabled: !folder },
    { label: "", separator: true },
    { label: t("sqlFileTree.rename"), action: () => folder && startRename(folder, target.entry), icon: Pencil, disabled: !folder },
    { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch },
    { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy },
    { label: "", separator: true },
    { label: t("sqlFileTree.delete"), action: () => folder && requestDelete(folder, target.entry), icon: Trash2, variant: "destructive", disabled: !folder },
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

function clearContextTarget() {
  contextTarget.value = null;
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("sqlFileTree.title") }}</span>
      <span class="flex-1" />
      <LightTooltip v-if="folders.length > 0" :text="t('sqlFileTree.revealActiveFile')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="revealActiveFile">
          <LocateFixed class="h-3 w-3" />
        </Button>
      </LightTooltip>
      <LightTooltip v-if="folders.length > 0" :text="t('sqlFileTree.refreshAll')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="refreshAll">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sqlFileTree.openProject')" side="bottom" :delay="0" :close-delay="0" nowrap>
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

    <!-- Project switcher（单激活项目视图：切换/移除/打开项目） -->
    <div v-if="folders.length > 0" class="relative flex shrink-0 items-center gap-1 border-b bg-muted/10 px-2 py-1">
      <button type="button" class="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left text-[12px] hover:bg-muted/50" @click.stop="toggleProjectSwitcher">
        <FolderOpen class="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span class="truncate font-medium">{{ activeFolder?.project.name }}</span>
        <ChevronDown class="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      <div v-if="showProjectSwitcher" class="fixed inset-0 z-40" @click="showProjectSwitcher = false" />
      <div v-if="showProjectSwitcher" class="absolute left-2 right-2 top-full z-50 mt-1 overflow-hidden rounded border bg-popover shadow-md">
        <div class="max-h-60 overflow-y-auto">
          <div v-for="project in projectStore.projects" :key="project.id" class="flex cursor-default items-center gap-1.5 px-2 py-1.5 hover:bg-muted/50" :class="project.id === projectStore.activeProjectId ? 'bg-accent/60' : ''" @click="switchProject(project)">
            <FolderOpen class="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[12px]">{{ project.name }}</div>
              <div class="truncate text-[10px] text-muted-foreground" :title="project.rootPath">{{ project.rootPath }}</div>
            </div>
            <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive" @click.stop="requestRemoveProjectByProject(project)">
              <Trash2 class="h-3 w-3" />
            </Button>
          </div>
        </div>
        <div class="border-t px-1 py-1">
          <button
            type="button"
            class="flex w-full items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-muted/50"
            @click="
              showProjectSwitcher = false;
              pickFolder();
            "
          >
            <FolderPlus class="h-3.5 w-3.5" />
            {{ t("sqlFileTree.openProject") }}
          </button>
        </div>
      </div>
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
          <div v-if="visibleFolders.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
            <span>{{ t("sqlFileTree.noFolder") }}</span>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="pickFolder"> <FolderOpen class="h-3.5 w-3.5 mr-1" />{{ t("sqlFileTree.openProject") }} </Button>
          </div>

          <div v-else>
            <div v-for="folder in visibleFolders" :key="folder.project.id" class="border-b last:border-b-0">
              <div
                data-sql-file-row="true"
                class="flex cursor-default items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-muted-foreground bg-muted/10 sticky top-0 select-none hover:bg-muted/30"
                :class="isPathHighlighted(folder.path) ? 'bg-accent text-accent-foreground' : ''"
                :title="`${folder.project.rootPath}\n${projectConnectionLabel(folder)}`"
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
                <span class="truncate shrink-0" :title="folder.project.name">{{ folder.project.name }}</span>
                <ShieldAlert v-if="!folder.project.trusted" class="h-3 w-3 shrink-0 text-orange-500" />
                <span class="truncate flex-1 text-[10px] text-muted-foreground/50" :title="folder.path">{{ folder.path }}</span>
                <LightTooltip :text="t('sqlFileTree.projectSettings')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground" @click.stop="openProjectSettings(folder)">
                    <Settings class="h-3 w-3" />
                  </Button>
                </LightTooltip>
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
                <LightTooltip :text="t('sqlFileTree.removeProject')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive" @click.stop="requestRemoveProject(folder)">
                    <Trash2 class="h-3 w-3" />
                  </Button>
                </LightTooltip>
              </div>
              <div v-show="!folder.collapsed">
                <div v-if="folder.loading" class="px-3 py-2 text-xs text-muted-foreground">
                  {{ t("sqlFileTree.loading") }}
                </div>
                <div v-else-if="folder.entries.length === 0 && !creatingTarget" class="px-3 py-2 text-xs text-muted-foreground">
                  {{ t("sqlFileTree.noSqlFiles") }}
                </div>
                <div v-else>
                  <template v-for="row in rowsFor(folder)" :key="row.type === 'create' ? `create-${folder.path}` : row.entry.path">
                    <!-- inline create input row -->
                    <div v-if="row.type === 'create'" class="flex items-center gap-1 px-2 py-1 text-sm" :style="{ paddingLeft: row.depth * 16 + 8 + 'px' }">
                      <span class="w-3.5 shrink-0" />
                      <FilePlus v-if="creatingTarget?.kind === 'file'" class="h-4 w-4 shrink-0 text-blue-500" />
                      <FolderPlus v-else class="h-4 w-4 shrink-0 text-amber-500" />
                      <input :ref="setCreatingInputRef" v-model="creatingName" class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none" @keydown.enter.prevent="confirmCreate" @keydown.escape.prevent="cancelCreate" @blur="confirmCreate" @click.stop />
                    </div>
                    <!-- normal entry row -->
                    <div
                      v-else
                      class="flex cursor-default items-center gap-1 px-2 py-1 hover:bg-muted/60 text-sm"
                      :class="[row.entry.is_dir ? 'rounded-sm' : 'rounded-none', isPathHighlighted(row.entry.path) ? 'bg-accent text-accent-foreground' : '']"
                      :style="{ paddingLeft: row.depth * 16 + 8 + 'px' }"
                      :data-sql-file-row="row.entry.path"
                      @click="
                        selectPath(row.entry.path);
                        row.entry.is_dir ? toggleExpand(folder, row.entry.path) : openFile(folder, row.entry.path);
                      "
                      @contextmenu.capture="
                        contextTarget = row.entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry: row.entry } : { kind: 'file', folderPath: folder.path, entry: row.entry };
                        selectPath(row.entry.path);
                      "
                      @contextmenu.prevent="
                        contextTarget = row.entry.is_dir ? { kind: 'dir', folderPath: folder.path, entry: row.entry } : { kind: 'file', folderPath: folder.path, entry: row.entry };
                        selectPath(row.entry.path);
                        onContextMenu($event);
                      "
                    >
                      <template v-if="row.entry.is_dir">
                        <ChevronRight v-if="!folder.expanded.has(row.entry.path)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <FolderClosed v-if="!folder.expanded.has(row.entry.path)" class="h-4 w-4 shrink-0 text-amber-500" />
                        <FolderOpen v-else class="h-4 w-4 shrink-0 text-amber-500" />
                      </template>
                      <template v-else>
                        <span class="w-3.5 shrink-0" />
                        <FileCode class="h-4 w-4 shrink-0 text-blue-500" />
                      </template>
                      <input
                        v-if="isRenaming(row.entry.path)"
                        :ref="setRenameInputRef"
                        v-model="renameValue"
                        class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                        @keydown.enter.prevent="confirmRename"
                        @keydown.escape.prevent="cancelRename"
                        @blur="confirmRename"
                        @click.stop
                      />
                      <span v-else class="truncate ml-1">{{ row.entry.name }}</span>
                      <span v-if="!row.entry.is_dir && !isRenaming(row.entry.path) && isEntryDirty(row.entry.path)" class="ml-0.5 shrink-0 text-orange-500" :title="t('sqlFileTree.unsavedChanges')">*</span>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </CustomContextMenu>

    <!-- Trust project dialog -->
    <Dialog :open="!!trustPrompt" @update:open="(value) => !value && declineTrust()">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("sqlFileTree.trustTitle") }}</DialogTitle>
          <DialogDescription>
            {{ t("sqlFileTree.trustMessage", { name: trustPrompt?.project.name || "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="declineTrust">{{ t("dangerDialog.cancel") }}</Button>
          <Button size="sm" @click="confirmTrust">{{ t("sqlFileTree.trustConfirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Delete entry confirmation dialog -->
    <Dialog v-model:open="showDeleteConfirm">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("sqlFileTree.delete") }}</DialogTitle>
          <DialogDescription v-if="deleteTarget?.isDir">
            {{ t("sqlFileTree.deleteConfirmFolder", { name: deleteTarget?.name || "", count: deleteTarget?.fileCount || 0 }) }}
          </DialogDescription>
          <DialogDescription v-else>
            {{ t("sqlFileTree.deleteConfirmFile", { name: deleteTarget?.name || "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" :disabled="deletingEntry" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" size="sm" :disabled="deletingEntry" @click="executeDelete">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Remove project confirmation dialog -->
    <Dialog v-model:open="showRemoveProjectConfirm">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("sqlFileTree.removeProject") }}</DialogTitle>
          <DialogDescription>
            {{ t("sqlFileTree.removeProjectConfirm", { name: removeProjectTarget?.project.name || "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="showRemoveProjectConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" size="sm" @click="executeRemoveProject">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Project settings dialog -->
    <ProjectSettingsDialog v-model:open="showProjectSettings" :project="settingsProject" @save="saveProjectSettings" />

    <!-- Local history dialog -->
    <SqlFileHistoryDialog v-model:open="showFileHistory" :project="historyTarget?.project ?? null" :path="historyTarget?.path ?? null" />
  </div>
</template>
