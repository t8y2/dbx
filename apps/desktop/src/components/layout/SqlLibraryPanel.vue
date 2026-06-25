<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, FileInput, FilePlus, FileText, FolderCog, FolderClosed, FolderOpen, FolderPlus, Library, LocateFixed, Pencil, Search, Trash2, Upload, X, ArrowDownWideNarrow } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CustomContextMenu, { type ContextMenuItem as CtxMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import * as api from "@/lib/api";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { focusSidebarRenameInput } from "@/lib/sidebarRenameFocus";
import { savedSqlFolderBranchFileCount } from "@/lib/savedSqlFolderCounts";
import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

const { t } = useI18n();
const { toast } = useToast();
const savedSqlStore = useSavedSqlStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();

const emit = defineEmits<{
  close: [];
}>();

const UNFILED_DROP_TARGET_ID = "__sql-library-unfiled__";
const DRAG_THRESHOLD = 5;

type DragItemType = "folder" | "file" | "unfiled";
type DropPosition = "before" | "after" | "inside";

const activeConnectionIds = computed(() => new Set(connectionStore.connections.map((c) => c.id)));
const searchText = ref("");
const searchQuery = computed(() => searchText.value.trim().toLowerCase());
const orphanedIds = computed(() => savedSqlStore.orphanedFileIds(activeConnectionIds.value));

// Sort mode: "folder" (default tree structure) or "date" (flat list by update date)
const sortMode = ref<"folder" | "date">("folder");

function isConnectionVisible(connectionId: string) {
  return activeConnectionIds.value.has(connectionId);
}

function getConnectionLabel(connectionId: string) {
  const conn = connectionStore.connections.find((c) => c.id === connectionId);
  return conn?.name || connectionId;
}

function activeImportConnectionId() {
  return connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
}

function importConnectionIdForFolder(folder?: SavedSqlFolder) {
  return folder?.connectionId || activeImportConnectionId();
}

function ensureSqlExtension(name: string) {
  return /\.sql$/i.test(name) ? name : `${name}.sql`;
}

function sanitizeFileSystemSegment(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "untitled";
}

function stripSqlExtension(name: string) {
  return name.replace(/\.sql$/i, "");
}

function relativeImportName(baseDir: string, filePath: string) {
  const normalizedBase = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  const relative = normalizedFile.startsWith(`${normalizedBase}/`) ? normalizedFile.slice(normalizedBase.length + 1) : normalizedFile.split("/").pop() || "import.sql";
  const pretty = relative.replace(/\//g, " - ");
  return ensureSqlExtension(pretty);
}

function uniqueImportedName(name: string, takenNames: Set<string>) {
  const normalized = ensureSqlExtension(name);
  if (!takenNames.has(normalized)) {
    takenNames.add(normalized);
    return normalized;
  }

  const base = stripSqlExtension(normalized);
  let counter = 2;
  while (true) {
    const candidate = `${base} (${counter}).sql`;
    if (!takenNames.has(candidate)) {
      takenNames.add(candidate);
      return candidate;
    }
    counter++;
  }
}

async function downloadText(content: string, fileName: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportSingleFile(file: SavedSqlFile) {
  try {
    const defaultFileName = sanitizeFileSystemSegment(ensureSqlExtension(file.name));
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!path) return;
      await writeTextFile(path, file.sql);
    } else {
      await downloadText(file.sql, defaultFileName);
    }
    toast(t("sqlLibrary.exported"), 2000);
  } catch (e: any) {
    toast(t("sqlLibrary.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportFolderContents(folder?: SavedSqlFolder) {
  if (!isTauriRuntime()) {
    toast(t("sqlLibrary.desktopOnly"), 4000);
    return;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const targetDir = await open({
      directory: true,
      multiple: false,
      recursive: true,
      title: folder ? t("sqlLibrary.exportFolder") : t("sqlLibrary.exportLibrary"),
    });
    if (!targetDir || Array.isArray(targetDir)) return;

    const rootDirName = sanitizeFileSystemSegment(folder?.name || t("savedSql.rootFolder"));
    const rootDir = await join(targetDir, rootDirName);
    await mkdir(rootDir, { recursive: true });

    const writeFolder = async (libraryFolder: SavedSqlFolder, dir: string): Promise<void> => {
      for (const child of savedSqlStore.allFolders.filter((item) => item.parentFolderId === libraryFolder.id)) {
        const childDir = await join(dir, sanitizeFileSystemSegment(child.name));
        await mkdir(childDir, { recursive: true });
        await writeFolder(child, childDir);
      }
      for (const file of savedSqlStore.filesInFolder(libraryFolder.id)) {
        const filePath = await join(dir, sanitizeFileSystemSegment(ensureSqlExtension(file.name)));
        await writeTextFile(filePath, file.sql);
      }
    };

    if (folder) {
      await writeFolder(folder, rootDir);
    } else {
      for (const libraryFolder of savedSqlStore.allFolders.filter((item) => isConnectionVisible(item.connectionId) && !item.parentFolderId)) {
        const folderDir = await join(rootDir, sanitizeFileSystemSegment(libraryFolder.name));
        await mkdir(folderDir, { recursive: true });
        await writeFolder(libraryFolder, folderDir);
      }

      const unfiled = savedSqlStore.filesWithoutFolder().filter((file) => !orphanedIds.value.has(file.id));
      if (unfiled.length > 0) {
        const unfiledDir = await join(rootDir, sanitizeFileSystemSegment(t("sqlLibrary.unfiled")));
        await mkdir(unfiledDir, { recursive: true });
        for (const file of unfiled) {
          const filePath = await join(unfiledDir, sanitizeFileSystemSegment(ensureSqlExtension(file.name)));
          await writeTextFile(filePath, file.sql);
        }
      }
    }

    toast(t("sqlLibrary.exported"), 2000);
  } catch (e: any) {
    toast(t("sqlLibrary.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function collectSqlFilesRecursively(dir: string): Promise<string[]> {
  const { readDir } = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");

  const results: string[] = [];
  for (const entry of await readDir(dir)) {
    const fullPath = await join(dir, entry.name);
    if (entry.isDirectory) {
      results.push(...(await collectSqlFilesRecursively(fullPath)));
      continue;
    }
    if (!entry.isFile) continue;
    if (!fullPath.toLowerCase().endsWith(".sql")) continue;
    results.push(fullPath);
  }
  return results;
}

async function importDirectoryIntoLibrary(targetFolder?: SavedSqlFolder) {
  if (!isTauriRuntime()) {
    toast(t("sqlLibrary.desktopOnly"), 4000);
    return;
  }

  const connectionId = importConnectionIdForFolder(targetFolder);
  if (!connectionId) {
    toast(t("sqlLibrary.noConnection"), 4000);
    return;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const selected = await open({
      directory: true,
      multiple: false,
      recursive: true,
      title: t("sqlLibrary.importDirectory"),
    });
    if (!selected || Array.isArray(selected)) return;

    const sqlPaths = await collectSqlFilesRecursively(selected);
    if (sqlPaths.length === 0) {
      toast(t("sqlLibrary.importNone"), 3000);
      return;
    }

    const takenNames = new Set((targetFolder ? savedSqlStore.filesInFolder(targetFolder.id) : savedSqlStore.filesWithoutFolder()).filter((file) => !orphanedIds.value.has(file.id)).map((file) => file.name));

    for (const path of sqlPaths) {
      const content = await readTextFile(path);
      const displayName = uniqueImportedName(relativeImportName(selected, path), takenNames);
      await savedSqlStore.saveFile({
        connectionId,
        folderId: targetFolder?.id,
        name: displayName,
        database: "",
        sql: content,
      });
    }

    toast(t("sqlLibrary.imported", { count: sqlPaths.length }), 2500);
  } catch (e: any) {
    toast(t("sqlLibrary.importFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function chooseSyncDirectory() {
  if (!isTauriRuntime()) {
    toast(t("sqlLibrary.desktopOnly"), 4000);
    return;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      recursive: true,
      title: t("sqlLibrary.chooseSyncDirectory"),
    });
    if (!selected || Array.isArray(selected)) return;

    await settingsStore.updateDesktopSettings({ saved_sql_sync_dir: selected });
    await savedSqlStore.syncToLocalDirectory();
    toast(t("sqlLibrary.syncDirectorySaved"), 2500);
  } catch (e: any) {
    toast(t("sqlLibrary.syncDirectoryFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function disableSyncDirectory() {
  try {
    await settingsStore.updateDesktopSettings({ saved_sql_sync_dir: null });
    toast(t("sqlLibrary.syncDirectoryDisabled"), 2500);
  } catch (e: any) {
    toast(t("sqlLibrary.syncDirectoryFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openSqlStorageDirectory() {
  if (!isTauriRuntime()) {
    toast(t("sqlLibrary.desktopOnly"), 4000);
    return;
  }

  const syncDir = settingsStore.desktopSettings.saved_sql_sync_dir?.trim();
  if (!syncDir) {
    toast(t("sqlLibrary.noSyncDirectory"), 3000);
    return;
  }
  try {
    await api.openSavedSqlStorageDir(syncDir);
  } catch (e: any) {
    toast(t("sqlLibrary.openDirectoryFailed", { message: e?.message || String(e) }), 5000);
  }
}

function fileMatchesQuery(file: SavedSqlFile) {
  const q = searchQuery.value;
  if (!q) return true;
  return [file.name, file.database, file.schema, file.sql, getConnectionLabel(file.connectionId)].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
}

function folderMatchesQuery(folder: SavedSqlFolder) {
  const q = searchQuery.value;
  if (!q) return true;
  if (folder.name.toLowerCase().includes(q)) return true;
  return savedSqlStore.filesInFolder(folder.id).some((file) => !orphanedIds.value.has(file.id) && fileMatchesQuery(file));
}

function childFolders(parentFolderId?: string) {
  return savedSqlStore.allFolders.filter((folder) => isConnectionVisible(folder.connectionId) && (folder.parentFolderId || "") === (parentFolderId || ""));
}

function descendantFolders(parentFolderId: string): SavedSqlFolder[] {
  const direct = childFolders(parentFolderId);
  return direct.flatMap((folder) => [folder, ...descendantFolders(folder.id)]);
}

function folderBranchMatchesQuery(folder: SavedSqlFolder) {
  if (folderMatchesQuery(folder)) return true;
  return descendantFolders(folder.id).some((child) => folderMatchesQuery(child));
}

function filesInFolder(folderId: string) {
  const folder = savedSqlStore.allFolders.find((item) => item.id === folderId);
  const includeAllFilesForMatchedFolder = !!folder && !!searchQuery.value && folder.name.toLowerCase().includes(searchQuery.value);
  return savedSqlStore
    .filesInFolder(folderId)
    .filter((file) => !orphanedIds.value.has(file.id))
    .filter((file) => includeAllFilesForMatchedFolder || fileMatchesQuery(file));
}

function folderFileCount(folderId: string) {
  const visibleFolders = savedSqlStore.allFolders.filter((folder) => isConnectionVisible(folder.connectionId));
  return savedSqlFolderBranchFileCount(folderId, visibleFolders, filesInFolder);
}

type SqlLibraryRow = { type: "folder"; folder: SavedSqlFolder; depth: number; folderIndex: number } | { type: "file"; file: SavedSqlFile; depth: number };

const visibleFolderRows = computed<SqlLibraryRow[]>(() => {
  const rows: SqlLibraryRow[] = [];
  let folderIndex = 0;
  const appendFolder = (folder: SavedSqlFolder, depth: number) => {
    if (!folderBranchMatchesQuery(folder)) return;
    rows.push({ type: "folder", folder, depth, folderIndex: folderIndex++ });
    if (!isFolderExpanded(folder.id)) return;
    for (const child of childFolders(folder.id)) {
      appendFolder(child, depth + 1);
    }
    for (const file of filesInFolder(folder.id)) {
      rows.push({ type: "file", file, depth: depth + 1 });
    }
  };
  for (const folder of childFolders()) {
    appendFolder(folder, 0);
  }
  return rows;
});

const visibleFiles = computed(() =>
  savedSqlStore
    .filesWithoutFolder()
    .filter((file) => !orphanedIds.value.has(file.id))
    .filter((file) => fileMatchesQuery(file)),
);

// Flat list sorted by updatedAt (descending) - combines all folders and files
const itemsByDate = computed(() => {
  const allFolders = savedSqlStore.allFolders
    .filter((folder) => isConnectionVisible(folder.connectionId))
    .filter((folder) => folderBranchMatchesQuery(folder))
    .map((folder) => ({ type: "folder" as const, item: folder, updatedAt: folder.updatedAt }));

  const allFiles = [...savedSqlStore.allFolders.flatMap((folder) => filesInFolder(folder.id)), ...visibleFiles.value].map((file) => ({ type: "file" as const, item: file, updatedAt: file.updatedAt }));

  return [...allFolders, ...allFiles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

const hasAnyVisibleItem = computed(() => visibleFolderRows.value.length > 0 || visibleFiles.value.length > 0);

const collapsedFolders = ref<Set<string>>(new Set());

function toggleFolder(folderId: string) {
  if (suppressNextRowClick.value) return;
  const next = new Set(collapsedFolders.value);
  if (next.has(folderId)) next.delete(folderId);
  else next.add(folderId);
  collapsedFolders.value = next;
}

function isFolderExpanded(folderId: string) {
  return !collapsedFolders.value.has(folderId);
}

async function openNewFolderInput(parentFolderId?: string) {
  const parent = parentFolderId ? savedSqlStore.allFolders.find((folder) => folder.id === parentFolderId) : undefined;
  const connectionId = parent?.connectionId || connectionStore.connections[0]?.id;
  if (!connectionId) return;
  if (parent?.id) {
    collapsedFolders.value = new Set([...collapsedFolders.value].filter((id) => id !== parent.id));
  }
  const folder = await savedSqlStore.createFolder(connectionId, t("savedSql.newFolderDefault"), parent?.id);
  startRenameFolder(folder);
}

async function openNewQueryInFolder(folder?: SavedSqlFolder) {
  const connectionId = folder?.connectionId || connectionStore.activeConnectionId || connectionStore.connections[0]?.id;
  if (!connectionId) return;

  const takenNames = folder
    ? new Set(savedSqlStore.filesInFolder(folder.id).map((f) => f.name))
    : new Set(
        savedSqlStore
          .filesWithoutFolder()
          .filter((file) => !orphanedIds.value.has(file.id))
          .map((f) => f.name),
      );
  const name = uniqueImportedName("new_query.sql", takenNames);
  const file = await savedSqlStore.saveFile({
    connectionId,
    folderId: folder?.id,
    name,
    database: "",
    sql: "",
  });
  queryStore.openSavedSql(file);
}

// Batch selection state
const selectedFileIds = ref<Set<string>>(new Set());
const selectedFolderIds = ref<Set<string>>(new Set());
const lastClickedItemIndex = ref<number | null>(null); // Unified index for both folders and files

// Active item state (single selection highlight, like left sidebar)
const activeItemId = ref<string | null>(null);
const activeItemType = ref<"file" | "folder" | null>(null);

// Unified item list for selection, matching the currently rendered order.
const allSelectableItems = computed(() => {
  if (sortMode.value === "date") {
    return itemsByDate.value.map((item) => ({
      type: item.type,
      id: item.item.id,
    }));
  }

  const treeItems = visibleFolderRows.value.map((row) => (row.type === "folder" ? { type: "folder" as const, id: row.folder.id } : { type: "file" as const, id: row.file.id }));
  const rootFiles = visibleFiles.value.map((file) => ({ type: "file" as const, id: file.id }));
  return [...treeItems, ...rootFiles];
});

const hasSelection = computed(() => selectedFileIds.value.size > 0 || selectedFolderIds.value.size > 0);
const selectedCount = computed(() => selectedFileIds.value.size + selectedFolderIds.value.size);

function clearSelection() {
  selectedFileIds.value = new Set();
  selectedFolderIds.value = new Set();
  lastClickedItemIndex.value = null;
}

function setActiveItem(id: string, type: "file" | "folder") {
  activeItemId.value = id;
  activeItemType.value = type;
}

function isFileSelected(fileId: string): boolean {
  return selectedFileIds.value.has(fileId);
}

function isFolderSelected(folderId: string): boolean {
  return selectedFolderIds.value.has(folderId);
}

function isFileActive(fileId: string): boolean {
  return activeItemType.value === "file" && activeItemId.value === fileId;
}

function isFolderActive(folderId: string): boolean {
  return activeItemType.value === "folder" && activeItemId.value === folderId;
}

const renamingTarget = ref<{ type: "folder" | "file"; id: string } | null>(null);
const renameValue = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);
function setRenameInputRef(el: unknown) {
  renameInputRef.value = (el as HTMLInputElement) ?? null;
}

function startRenameFolder(folder: SavedSqlFolder) {
  renamingTarget.value = { type: "folder", id: folder.id };
  renameValue.value = folder.name;
  nextTick(() => {
    focusSidebarRenameInput(() => renameInputRef.value ?? undefined);
  });
}

function startRenameFile(file: SavedSqlFile) {
  renamingTarget.value = { type: "file", id: file.id };
  renameValue.value = file.name.replace(/\.sql$/i, "");
  nextTick(() => {
    focusSidebarRenameInput(() => renameInputRef.value ?? undefined);
  });
}

async function confirmRename() {
  if (!renamingTarget.value) return;
  const { type, id } = renamingTarget.value;
  const name = renameValue.value.trim();
  renamingTarget.value = null;
  renameValue.value = "";
  if (!name) return;
  if (type === "folder") {
    await savedSqlStore.renameFolder(id, name);
  } else {
    await savedSqlStore.renameFile(id, name.endsWith(".sql") ? name : `${name}.sql`);
  }
}

function cancelRename() {
  renamingTarget.value = null;
  renameValue.value = "";
}

const deleteTarget = ref<{ type: "folder" | "file"; id: string; name: string } | null>(null);
const showDeleteConfirm = ref(false);
const showBatchDeleteConfirm = ref(false);

function confirmDeleteFolder(folder: SavedSqlFolder) {
  deleteTarget.value = { type: "folder", id: folder.id, name: folder.name };
  showDeleteConfirm.value = true;
}

function confirmDeleteFile(file: SavedSqlFile) {
  deleteTarget.value = { type: "file", id: file.id, name: file.name };
  showDeleteConfirm.value = true;
}

function confirmBatchDelete() {
  if (!hasSelection.value) return;
  showBatchDeleteConfirm.value = true;
}

async function executeDelete() {
  if (!deleteTarget.value) return;
  const { type, id } = deleteTarget.value;
  if (type === "folder") await savedSqlStore.deleteFolder(id);
  else await savedSqlStore.deleteFile(id);
  showDeleteConfirm.value = false;
  deleteTarget.value = null;
}

async function executeBatchDelete() {
  const fileIds = Array.from(selectedFileIds.value);
  const folderIds = Array.from(selectedFolderIds.value);

  // Delete files first, then folders
  for (const fileId of fileIds) {
    await savedSqlStore.deleteFile(fileId);
  }
  for (const folderId of folderIds) {
    await savedSqlStore.deleteFolder(folderId);
  }

  showBatchDeleteConfirm.value = false;
  clearSelection();
  toast(t("sqlLibrary.batchDeleteSuccess", { count: fileIds.length + folderIds.length }), 2000);
}

function openFile(file: SavedSqlFile) {
  if (suppressNextRowClick.value) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
}

function handleFileClick(file: SavedSqlFile, event: MouseEvent) {
  if (suppressNextRowClick.value) return;

  const isMeta = event.metaKey || event.ctrlKey;
  const isShift = event.shiftKey;

  // Find current file index in unified list
  const currentIndex = allSelectableItems.value.findIndex((item) => item.type === "file" && item.id === file.id);
  if (currentIndex < 0) return;

  if (isMeta) {
    // Toggle selection
    event.preventDefault();
    event.stopPropagation();
    const next = new Set(selectedFileIds.value);
    if (next.has(file.id)) {
      next.delete(file.id);
    } else {
      next.add(file.id);
    }
    selectedFileIds.value = next;
    lastClickedItemIndex.value = currentIndex;
  } else if (isShift) {
    // Range selection - additive mode (add to existing selection)
    event.preventDefault();
    event.stopPropagation();

    const startIndex = lastClickedItemIndex.value ?? 0;
    const start = Math.min(startIndex, currentIndex);
    const end = Math.max(startIndex, currentIndex);

    // Add to existing selection (additive mode)
    const nextFiles = new Set(selectedFileIds.value);
    const nextFolders = new Set(selectedFolderIds.value);
    for (let i = start; i <= end; i++) {
      const item = allSelectableItems.value[i];
      if (item) {
        if (item.type === "file") {
          nextFiles.add(item.id);
        } else {
          nextFolders.add(item.id);
        }
      }
    }
    selectedFileIds.value = nextFiles;
    selectedFolderIds.value = nextFolders;
    lastClickedItemIndex.value = currentIndex;
  } else {
    // Normal click - open file, clear selection but keep anchor, and set active
    const hadSelection = hasSelection.value;
    clearSelection();
    setActiveItem(file.id, "file");
    openFile(file);
    // Set anchor for future shift-click even when not selecting
    if (!hadSelection) {
      lastClickedItemIndex.value = currentIndex;
    }
  }
}

function handleFolderClick(folder: SavedSqlFolder, event: MouseEvent) {
  if (suppressNextRowClick.value) return;

  const isMeta = event.metaKey || event.ctrlKey;
  const isShift = event.shiftKey;

  // Find current folder index in unified list
  const currentIndex = allSelectableItems.value.findIndex((item) => item.type === "folder" && item.id === folder.id);
  if (currentIndex < 0) return;

  if (isMeta) {
    // Toggle selection
    event.preventDefault();
    event.stopPropagation();
    const next = new Set(selectedFolderIds.value);
    if (next.has(folder.id)) {
      next.delete(folder.id);
    } else {
      next.add(folder.id);
    }
    selectedFolderIds.value = next;
    lastClickedItemIndex.value = currentIndex;
  } else if (isShift) {
    // Range selection - additive mode (add to existing selection)
    event.preventDefault();
    event.stopPropagation();

    const startIndex = lastClickedItemIndex.value ?? 0;
    const start = Math.min(startIndex, currentIndex);
    const end = Math.max(startIndex, currentIndex);

    // Add to existing selection (additive mode)
    const nextFiles = new Set(selectedFileIds.value);
    const nextFolders = new Set(selectedFolderIds.value);
    for (let i = start; i <= end; i++) {
      const item = allSelectableItems.value[i];
      if (item) {
        if (item.type === "file") {
          nextFiles.add(item.id);
        } else {
          nextFolders.add(item.id);
        }
      }
    }
    selectedFileIds.value = nextFiles;
    selectedFolderIds.value = nextFolders;
    lastClickedItemIndex.value = currentIndex;
  } else {
    // Normal click - toggle folder expansion, clear selection but keep anchor, and set active
    const hadSelection = hasSelection.value;
    clearSelection();
    setActiveItem(folder.id, "folder");
    toggleFolder(folder.id);
    // Set anchor for future shift-click even when not selecting
    if (!hadSelection) {
      lastClickedItemIndex.value = currentIndex;
    }
  }
}

const contextTarget = ref<SavedSqlFolder | SavedSqlFile | "panel" | null>(null);

const contextMenuItems = computed<CtxMenuItem[]>(() => {
  const target = contextTarget.value;
  if (!target) return [];

  // If there's selection, show batch delete option
  if (hasSelection.value) {
    return [
      {
        label: t("sqlLibrary.batchDelete", { count: selectedCount.value }),
        action: confirmBatchDelete,
        icon: Trash2,
        variant: "destructive",
      },
      { label: "", separator: true },
      { label: t("sqlLibrary.clearSelection"), action: clearSelection, icon: X },
    ];
  }

  if (target === "panel") {
    return [
      { label: t("savedSql.newFolder"), action: openNewFolderInput, icon: FolderPlus },
      { label: t("savedSql.newQuery"), action: () => openNewQueryInFolder(), icon: FilePlus },
      { label: t("sqlLibrary.importDirectory"), action: () => importDirectoryIntoLibrary(), icon: Upload },
      { label: t("sqlLibrary.exportLibrary"), action: () => exportFolderContents(), icon: Download },
      { label: "", separator: true },
      { label: t("sqlLibrary.openStorageDirectory"), action: openSqlStorageDirectory, icon: LocateFixed },
      { label: t("sqlLibrary.chooseSyncDirectory"), action: chooseSyncDirectory, icon: FolderCog },
      {
        label: t("sqlLibrary.disableSyncDirectory"),
        action: disableSyncDirectory,
        icon: X,
        visible: !!settingsStore.desktopSettings.saved_sql_sync_dir,
      },
    ];
  }
  if ("sql" in target) {
    return [
      { label: t("savedSql.open"), action: () => openFile(target), icon: FileText },
      { label: t("sqlLibrary.exportFile"), action: () => exportSingleFile(target), icon: FileInput },
      { label: "", separator: true },
      { label: t("savedSql.renameFile"), action: () => startRenameFile(target), icon: Pencil },
      { label: "", separator: true },
      {
        label: t("savedSql.deleteFile"),
        action: () => confirmDeleteFile(target),
        icon: Trash2,
        variant: "destructive",
      },
    ];
  }
  return [
    { label: t("savedSql.newFolder"), action: () => openNewFolderInput(target.id), icon: FolderPlus },
    { label: t("savedSql.newQuery"), action: () => openNewQueryInFolder(target), icon: FilePlus },
    { label: t("sqlLibrary.importIntoFolder"), action: () => importDirectoryIntoLibrary(target), icon: Upload },
    { label: t("sqlLibrary.exportFolder"), action: () => exportFolderContents(target), icon: Download },
    { label: "", separator: true },
    { label: t("savedSql.renameFolder"), action: () => startRenameFolder(target), icon: Pencil },
    { label: "", separator: true },
    {
      label: t("savedSql.deleteFolder"),
      action: () => confirmDeleteFolder(target),
      icon: Trash2,
      variant: "destructive",
    },
  ];
});

function clearContextTarget() {
  contextTarget.value = null;
}

const dragState = reactive<{
  active: boolean;
  draggedId: string | null;
  draggedType: DragItemType | null;
  targetId: string | null;
  targetType: DragItemType | null;
  dropPosition: DropPosition | null;
}>({
  active: false,
  draggedId: null,
  draggedType: null,
  targetId: null,
  targetType: null,
  dropPosition: null,
});

let pendingDrag: {
  id: string;
  type: DragItemType;
  startX: number;
  startY: number;
  sourceEl: HTMLElement | null;
} | null = null;
let dragGhostEl: HTMLElement | null = null;
let clearSuppressTimer: number | undefined;
const suppressNextRowClick = ref(false);

function markSuppressedClick() {
  suppressNextRowClick.value = true;
  window.clearTimeout(clearSuppressTimer);
  clearSuppressTimer = window.setTimeout(() => {
    suppressNextRowClick.value = false;
  }, 0);
}

function resetDragState() {
  dragState.active = false;
  dragState.draggedId = null;
  dragState.draggedType = null;
  dragState.targetId = null;
  dragState.targetType = null;
  dragState.dropPosition = null;
  pendingDrag = null;
  if (dragGhostEl) {
    dragGhostEl.remove();
    dragGhostEl = null;
  }
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function createDragGhost(sourceEl: HTMLElement, x: number, y: number) {
  const ghost = document.createElement("div");
  const textNode = sourceEl.querySelector(".dbx-sql-library-drag-label");
  ghost.textContent = textNode?.textContent || "";
  ghost.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    opacity: 0.9;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    border-radius: 4px;
    background: var(--background, #fff);
    border: 1px solid var(--border, #e5e7eb);
    max-width: 220px;
    height: 24px;
    padding: 0 8px;
    font-size: 13px;
    line-height: 24px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    left: ${x + 8}px;
    top: ${y - 12}px;
  `;
  document.body.appendChild(ghost);
  return ghost;
}

function moveDragGhost(x: number, y: number) {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = `${x + 8}px`;
  dragGhostEl.style.top = `${y - 12}px`;
}

function onDocumentMouseMove(event: MouseEvent) {
  if (!pendingDrag && !dragState.active) return;

  if (pendingDrag && !dragState.active) {
    const dx = event.clientX - pendingDrag.startX;
    const dy = event.clientY - pendingDrag.startY;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

    dragState.active = true;
    dragState.draggedId = pendingDrag.id;
    dragState.draggedType = pendingDrag.type;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    if (pendingDrag.sourceEl) {
      dragGhostEl = createDragGhost(pendingDrag.sourceEl, event.clientX, event.clientY);
    }
    pendingDrag = null;
  }

  if (dragState.active) {
    moveDragGhost(event.clientX, event.clientY);
  }
}

async function performDrop() {
  const draggedId = dragState.draggedId;
  const draggedType = dragState.draggedType;
  const targetId = dragState.targetId;
  const targetType = dragState.targetType;
  const dropPosition = dragState.dropPosition;
  if (!draggedId || !draggedType || !targetId || !targetType || !dropPosition) return;

  if (draggedType === "folder" && targetType === "folder" && dropPosition !== "inside") {
    await savedSqlStore.reorderFolders(draggedId, targetId, dropPosition);
    return;
  }

  if (draggedType === "folder" && targetType === "folder" && dropPosition === "inside") {
    await savedSqlStore.moveFolderToFolder(draggedId, targetId);
    return;
  }

  if (draggedType !== "file") return;

  if (targetType === "folder") {
    await savedSqlStore.moveFileToFolder(draggedId, targetId);
    return;
  }

  if (targetType === "unfiled") {
    await savedSqlStore.moveFileToFolder(draggedId, undefined);
    return;
  }

  if (targetType === "file" && dropPosition !== "inside") {
    await savedSqlStore.reorderFiles(draggedId, targetId, dropPosition);
  }
}

function onDocumentMouseUp() {
  const hadActiveDrag = dragState.active;
  const dropPromise = hadActiveDrag ? performDrop() : Promise.resolve();
  if (hadActiveDrag) markSuppressedClick();
  resetDragState();
  void dropPromise;
}

document.addEventListener("mousemove", onDocumentMouseMove, true);
document.addEventListener("mouseup", onDocumentMouseUp, true);

onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDocumentMouseMove, true);
  document.removeEventListener("mouseup", onDocumentMouseUp, true);
  window.clearTimeout(clearSuppressTimer);
  resetDragState();
});

function handleDragMouseDown(event: MouseEvent, id: string, type: Extract<DragItemType, "folder" | "file">) {
  if (event.button !== 0) return;
  // Skip drag when modifier keys are pressed (for selection)
  if (event.shiftKey || event.metaKey || event.ctrlKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("[data-no-drag='true']")) return;
  pendingDrag = {
    id,
    type,
    startX: event.clientX,
    startY: event.clientY,
    sourceEl: event.currentTarget as HTMLElement,
  };
}

function updateDropTarget(event: MouseEvent, targetId: string, targetType: DragItemType) {
  if (!dragState.active || !dragState.draggedId || !dragState.draggedType) return;
  if (dragState.draggedId === targetId) {
    clearDropTarget(targetId);
    return;
  }

  let nextPosition: DropPosition | null = null;
  if (dragState.draggedType === "folder" && targetType === "folder") {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = event.clientY - rect.top;
    const third = rect.height / 3;
    nextPosition = y > third && y < rect.height - third ? "inside" : y < rect.height / 2 ? "before" : "after";
  } else if (dragState.draggedType === "file" && targetType === "file") {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    nextPosition = event.clientY - rect.top < rect.height / 2 ? "before" : "after";
  } else if (dragState.draggedType === "file" && (targetType === "folder" || targetType === "unfiled")) {
    nextPosition = "inside";
  }

  dragState.targetId = nextPosition ? targetId : null;
  dragState.targetType = nextPosition ? targetType : null;
  dragState.dropPosition = nextPosition;
}

function clearDropTarget(targetId: string) {
  if (dragState.targetId !== targetId) return;
  dragState.targetId = null;
  dragState.targetType = null;
  dragState.dropPosition = null;
}

function isDraggingItem(id: string) {
  return dragState.active && dragState.draggedId === id;
}

function showDropBefore(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "before";
}

function showDropAfter(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "after";
}

function showDropInside(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "inside";
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden border-l bg-background select-none">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("sqlLibrary.title") }}</span>
      <span v-if="hasSelection" class="text-[12px] text-muted-foreground ml-1">({{ selectedCount }})</span>
      <span class="flex-1" />
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="sortMode === 'folder' ? t('sqlLibrary.sortByDate') : t('sqlLibrary.sortByFolder')" @click="sortMode = sortMode === 'folder' ? 'date' : 'folder'">
        <ArrowDownWideNarrow :class="['h-3 w-3', sortMode === 'date' ? 'text-primary' : '']" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('savedSql.newFolder')" @click="openNewFolderInput">
        <FolderPlus class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('sqlLibrary.importDirectory')" @click="importDirectoryIntoLibrary()">
        <Upload class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('sqlLibrary.exportLibrary')" @click="exportFolderContents()">
        <Download class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
        <X class="h-3 w-3" />
      </Button>
    </div>

    <div class="border-b shrink-0 px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input v-model="searchText" autocapitalize="off" autocorrect="off" spellcheck="false" class="w-full h-6 pl-7 pr-6 text-[13px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" :placeholder="t('grid.search')" />
        <button v-if="searchText" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchText = ''">
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-1">
      <CustomContextMenu :items="contextMenuItems" @close="clearContextTarget">
        <template #default="{ onContextMenu }">
          <div
            class="h-full"
            @contextmenu.capture="contextTarget = 'panel'"
            @contextmenu.prevent="
              contextTarget = 'panel';
              onContextMenu($event);
            "
          >
            <!-- Flat list sorted by date -->
            <div v-if="sortMode === 'date'" class="space-y-0">
              <div v-for="item in itemsByDate" :key="item.type + '-' + item.item.id">
                <div
                  v-if="item.type === 'folder'"
                  class="relative flex items-center gap-1 rounded px-2 py-1.5 text-[13px] cursor-pointer group"
                  :class="[isFolderSelected(item.item.id) ? 'bg-primary/10' : isFolderActive(item.item.id) ? 'bg-accent' : 'hover:bg-accent', isDraggingItem(item.item.id) ? 'opacity-50' : '']"
                  @mousedown="handleDragMouseDown($event, item.item.id, 'folder')"
                  @click="handleFolderClick(item.item, $event)"
                  @contextmenu.capture="contextTarget = item.item"
                  @contextmenu.prevent="
                    contextTarget = item.item;
                    onContextMenu($event);
                  "
                >
                  <FolderClosed class="h-4 w-4 text-amber-500 shrink-0" />
                  <span class="dbx-sql-library-drag-label min-w-0 flex-1 truncate">
                    {{ item.item.name }}
                    <span class="ml-1 text-muted-foreground">({{ folderFileCount(item.item.id) }})</span>
                  </span>
                </div>

                <div
                  v-else
                  class="relative flex items-center gap-1 rounded px-2 py-1.5 text-[13px] cursor-pointer group"
                  :class="[isDraggingItem(item.item.id) ? 'opacity-50' : isFileSelected(item.item.id) ? 'bg-primary/10' : isFileActive(item.item.id) ? 'bg-accent' : 'hover:bg-accent']"
                  @mousedown="handleDragMouseDown($event, item.item.id, 'file')"
                  @click="handleFileClick(item.item, $event)"
                  @contextmenu.capture="contextTarget = item.item"
                  @contextmenu.prevent="
                    contextTarget = item.item;
                    onContextMenu($event);
                  "
                >
                  <FileText class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                  <span class="dbx-sql-library-drag-label min-w-0 flex-1 truncate">{{ item.item.name }}</span>
                  <span class="shrink-0 text-[13px] text-muted-foreground"> [{{ getConnectionLabel(item.item.connectionId) }}] </span>
                </div>
              </div>
            </div>

            <!-- Tree structure sorted by folder -->
            <div v-else>
              <div v-for="row in visibleFolderRows" :key="row.type === 'folder' ? row.folder.id : row.file.id">
                <div
                  v-if="row.type === 'folder'"
                  class="relative flex items-center gap-1 rounded py-1.5 pr-2 text-[13px] cursor-pointer group"
                  :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
                  :class="[showDropInside(row.folder.id) ? 'ring-1 ring-primary/50 bg-primary/5' : isFolderSelected(row.folder.id) ? 'bg-primary/10' : isFolderActive(row.folder.id) ? 'bg-accent' : 'hover:bg-accent', isDraggingItem(row.folder.id) ? 'opacity-50' : '']"
                  @mousedown="handleDragMouseDown($event, row.folder.id, 'folder')"
                  @mousemove="updateDropTarget($event, row.folder.id, 'folder')"
                  @mouseleave="clearDropTarget(row.folder.id)"
                  @click="handleFolderClick(row.folder, $event)"
                  @contextmenu.capture="contextTarget = row.folder"
                  @contextmenu.prevent="
                    contextTarget = row.folder;
                    onContextMenu($event);
                  "
                >
                  <div v-if="showDropBefore(row.folder.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                  <div v-if="showDropAfter(row.folder.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                  <component :is="isFolderExpanded(row.folder.id) ? FolderOpen : FolderClosed" class="h-4 w-4 text-amber-500 shrink-0" />
                  <template v-if="renamingTarget?.type === 'folder' && renamingTarget.id === row.folder.id">
                    <input
                      :ref="setRenameInputRef"
                      v-model="renameValue"
                      data-no-drag="true"
                      class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.escape.prevent="cancelRename"
                      @blur="confirmRename"
                      @click.stop
                    />
                  </template>
                  <span v-else class="dbx-sql-library-drag-label min-w-0 flex-1 truncate">
                    {{ row.folder.name }}
                    <span class="ml-1 text-muted-foreground">({{ folderFileCount(row.folder.id) }})</span>
                  </span>
                </div>

                <div
                  v-else
                  class="relative flex items-center gap-1 rounded py-1.5 pr-2 text-[13px] cursor-pointer group"
                  :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
                  :class="[isDraggingItem(row.file.id) ? 'opacity-50' : isFileSelected(row.file.id) ? 'bg-primary/10' : isFileActive(row.file.id) ? 'bg-accent' : 'hover:bg-accent']"
                  @mousedown="handleDragMouseDown($event, row.file.id, 'file')"
                  @mousemove="updateDropTarget($event, row.file.id, 'file')"
                  @mouseleave="clearDropTarget(row.file.id)"
                  @click="handleFileClick(row.file, $event)"
                  @contextmenu.capture="contextTarget = row.file"
                  @contextmenu.prevent="
                    contextTarget = row.file;
                    onContextMenu($event);
                  "
                >
                  <div v-if="showDropBefore(row.file.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                  <div v-if="showDropAfter(row.file.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                  <FileText class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                  <template v-if="renamingTarget?.type === 'file' && renamingTarget.id === row.file.id">
                    <input
                      :ref="setRenameInputRef"
                      v-model="renameValue"
                      data-no-drag="true"
                      class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.escape.prevent="cancelRename"
                      @blur="confirmRename"
                      @click.stop
                    />
                  </template>
                  <span v-else class="dbx-sql-library-drag-label min-w-0 flex-1 truncate">{{ row.file.name }}</span>
                  <span class="shrink-0 text-[13px] text-muted-foreground"> [{{ getConnectionLabel(row.file.connectionId) }}] </span>
                </div>
              </div>

              <div v-if="visibleFiles.length > 0 || dragState.draggedType === 'file'">
                <div
                  v-if="dragState.draggedType === 'file'"
                  class="relative rounded px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground"
                  :class="showDropInside(UNFILED_DROP_TARGET_ID) ? 'ring-1 ring-primary/50 bg-primary/5' : ''"
                  @mousemove="updateDropTarget($event, UNFILED_DROP_TARGET_ID, 'unfiled')"
                  @mouseleave="clearDropTarget(UNFILED_DROP_TARGET_ID)"
                >
                  {{ t("sqlLibrary.unfiled") }}
                </div>
                <div
                  v-for="file in visibleFiles"
                  :key="file.id"
                  class="relative flex items-center gap-1 rounded px-2 py-1.5 text-[13px] cursor-pointer group"
                  :class="[isDraggingItem(file.id) ? 'opacity-50' : isFileSelected(file.id) ? 'bg-primary/10' : 'hover:bg-accent']"
                  @mousedown="handleDragMouseDown($event, file.id, 'file')"
                  @mousemove="updateDropTarget($event, file.id, 'file')"
                  @mouseleave="clearDropTarget(file.id)"
                  @click="handleFileClick(file, $event)"
                  @contextmenu.capture="contextTarget = file"
                  @contextmenu.prevent="
                    contextTarget = file;
                    onContextMenu($event);
                  "
                >
                  <div v-if="showDropBefore(file.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                  <div v-if="showDropAfter(file.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                  <FileText class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                  <template v-if="renamingTarget?.type === 'file' && renamingTarget.id === file.id">
                    <input
                      :ref="setRenameInputRef"
                      v-model="renameValue"
                      data-no-drag="true"
                      class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.escape.prevent="cancelRename"
                      @blur="confirmRename"
                      @click.stop
                    />
                  </template>
                  <span v-else class="dbx-sql-library-drag-label min-w-0 flex-1 truncate">{{ file.name }}</span>
                  <span class="shrink-0 text-[13px] text-muted-foreground"> [{{ getConnectionLabel(file.connectionId) }}] </span>
                </div>
              </div>
            </div>
            <!-- End tree structure -->

            <div v-if="!hasAnyVisibleItem" class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Library class="h-8 w-8 opacity-30" />
              <p class="text-[13px]">{{ t("sqlLibrary.empty") }}</p>
            </div>
          </div>
        </template>
      </CustomContextMenu>
    </div>

    <Dialog v-model:open="showDeleteConfirm">
      <DialogContent class="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle v-if="deleteTarget?.type === 'folder'">{{ t("savedSql.deleteFolder") }}</DialogTitle>
          <DialogTitle v-else>{{ t("savedSql.deleteFile") }}</DialogTitle>
          <DialogDescription v-if="deleteTarget?.type === 'folder'">
            {{ t("savedSql.deleteFolderConfirm", { name: deleteTarget?.name || "" }) }}
          </DialogDescription>
          <DialogDescription v-else>
            {{ t("savedSql.deleteFileConfirm", { name: deleteTarget?.name || "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" size="sm" @click="executeDelete">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Batch Delete Confirmation Dialog -->
    <Dialog :open="showBatchDeleteConfirm" @update:open="(open) => (showBatchDeleteConfirm = open)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ t("sqlLibrary.batchDelete") }}</DialogTitle>
          <DialogDescription>
            {{ t("sqlLibrary.batchDeleteConfirm", { count: selectedCount }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="showBatchDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" size="sm" @click="executeBatchDelete">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
