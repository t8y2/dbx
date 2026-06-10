import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { uuid } from "@/lib/utils";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "@/types/database";

const LEGACY_STORAGE_KEY = "dbx-saved-sql-library";

interface SavedSqlState {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}

function nowIso() {
  return new Date().toISOString();
}

function sortFoldersByOrder(items: SavedSqlFolder[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function sortFilesByOrder(items: SavedSqlFile[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function reindexFolders(items: SavedSqlFolder[]) {
  return items.map((folder, index) => ({ ...folder, orderIndex: index }));
}

function reindexFiles(items: SavedSqlFile[], folderId?: string) {
  return items.map((file, index) => ({
    ...file,
    folderId,
    orderIndex: index,
  }));
}

function maxOrderIndex(values: Array<{ orderIndex?: number }>) {
  return values.reduce((max, item) => Math.max(max, item.orderIndex ?? -1), -1);
}

function loadLegacyState(): SavedSqlState {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return { folders: [], files: [] };
    const parsed = JSON.parse(raw) as Partial<SavedSqlState>;
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter((item) => item?.id && item?.connectionId) : [],
      files: Array.isArray(parsed.files) ? parsed.files.filter((item) => item?.id && item?.connectionId) : [],
    };
  } catch {
    return { folders: [], files: [] };
  }
}

export const useSavedSqlStore = defineStore("savedSql", () => {
  const folders = ref<SavedSqlFolder[]>([]);
  const files = ref<SavedSqlFile[]>([]);
  const isLoaded = ref(false);
  let pendingSync: Promise<void> | null = null;

  const version = ref(0);
  function bumpVersion() {
    version.value++;
  }

  function applyLibrary(library: SavedSqlLibrary) {
    folders.value = library.folders;
    files.value = library.files;
    bumpVersion();
  }

  async function migrateLegacyLocalStorage() {
    const legacy = loadLegacyState();
    if (legacy.folders.length === 0 && legacy.files.length === 0) return;

    for (const folder of legacy.folders) {
      await api.saveSavedSqlFolder(folder);
    }
    for (const file of legacy.files) {
      await api.saveSavedSqlFile(file);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  async function initFromStorage() {
    await migrateLegacyLocalStorage();
    applyLibrary(await api.loadSavedSqlLibrary());
    isLoaded.value = true;
    await syncToLocalDirectory();
  }

  function listFolders(connectionId: string) {
    return sortFoldersByOrder(folders.value.filter((folder) => folder.connectionId === connectionId));
  }

  function listFiles(connectionId: string, folderId?: string) {
    return sortFilesByOrder(files.value.filter((file) => file.connectionId === connectionId && (file.folderId || "") === (folderId || "")));
  }

  function getFile(id: string) {
    return files.value.find((file) => file.id === id);
  }

  async function createFolder(connectionId: string, name: string) {
    const timestamp = nowIso();
    const folder: SavedSqlFolder = {
      id: uuid(),
      connectionId,
      name,
      orderIndex: maxOrderIndex(folders.value) + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await api.saveSavedSqlFolder(folder);
    folders.value = [...folders.value.filter((item) => item.id !== saved.id), saved];
    bumpVersion();
    await syncToLocalDirectory();
    return saved;
  }

  async function renameFolder(id: string, name: string) {
    const existing = folders.value.find((folder) => folder.id === id);
    if (!existing) return;
    const saved = await api.saveSavedSqlFolder({ ...existing, name, updatedAt: nowIso() });
    folders.value = folders.value.map((folder) => (folder.id === id ? saved : folder));
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function deleteFolder(id: string) {
    await api.deleteSavedSqlFolder(id);
    folders.value = folders.value.filter((folder) => folder.id !== id);
    files.value = files.value.filter((file) => file.folderId !== id);
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function saveFile(input: { id?: string; connectionId: string; folderId?: string; name: string; database: string; schema?: string; sql: string }) {
    const timestamp = nowIso();
    const existing = input.id ? getFile(input.id) : undefined;
    const file: SavedSqlFile = existing
      ? {
          ...existing,
          folderId: input.folderId || undefined,
          name: input.name,
          database: input.database,
          schema: input.schema,
          sql: input.sql,
          updatedAt: timestamp,
        }
      : {
          id: uuid(),
          connectionId: input.connectionId,
          folderId: input.folderId || undefined,
          name: input.name,
          database: input.database,
          schema: input.schema,
          sql: input.sql,
          orderIndex: maxOrderIndex(files.value.filter((file) => file.connectionId === input.connectionId && (file.folderId || "") === (input.folderId || undefined || ""))) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const saved = await api.saveSavedSqlFile(file);
    files.value = [...files.value.filter((item) => item.id !== saved.id), saved];
    bumpVersion();
    await syncToLocalDirectory();
    return saved;
  }

  async function renameFile(id: string, name: string) {
    const existing = getFile(id);
    if (!existing) return;
    const saved = await api.saveSavedSqlFile({ ...existing, name, updatedAt: nowIso() });
    files.value = files.value.map((file) => (file.id === id ? saved : file));
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function deleteFile(id: string) {
    await api.deleteSavedSqlFile(id);
    files.value = files.value.filter((file) => file.id !== id);
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function persistFolders(nextFolders: SavedSqlFolder[]) {
    const reindexed = reindexFolders(nextFolders).map((folder) => ({ ...folder, updatedAt: nowIso() }));
    await Promise.all(reindexed.map((folder) => api.saveSavedSqlFolder(folder)));
    folders.value = reindexed;
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function persistFiles(nextFiles: SavedSqlFile[]) {
    await Promise.all(nextFiles.map((file) => api.saveSavedSqlFile(file)));
    files.value = nextFiles;
    bumpVersion();
    await syncToLocalDirectory();
  }

  function syncEntries() {
    const folderById = new Map(folders.value.map((folder) => [folder.id, folder]));
    return sortFilesByOrder(files.value).map((file) => ({
      folderName: file.folderId ? folderById.get(file.folderId)?.name : undefined,
      fileName: file.name,
      sql: file.sql,
    }));
  }

  async function syncToLocalDirectory() {
    if (!isTauriRuntime()) return;
    const settingsStore = useSettingsStore();
    const targetDir = settingsStore.desktopSettings.saved_sql_sync_dir?.trim();
    if (!targetDir) return;

    const syncPromise = pendingSync?.catch(() => {}).then(() => api.syncSavedSqlDirectory({ targetDir, entries: syncEntries() })) ?? api.syncSavedSqlDirectory({ targetDir, entries: syncEntries() });
    pendingSync = syncPromise;
    try {
      await syncPromise;
    } catch (error) {
      console.warn("[DBX][saved-sql:sync:error]", error);
    } finally {
      if (pendingSync === syncPromise) {
        pendingSync = null;
      }
    }
  }

  async function reorderFolders(draggedId: string, targetId: string, position: "before" | "after") {
    const ordered = sortFoldersByOrder(folders.value);
    const dragged = ordered.find((folder) => folder.id === draggedId);
    const target = ordered.find((folder) => folder.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;

    const remaining = ordered.filter((folder) => folder.id !== draggedId);
    const targetIndex = remaining.findIndex((folder) => folder.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remaining.splice(insertIndex, 0, dragged);
    await persistFolders(remaining);
  }

  async function moveFileToFolder(fileId: string, folderId?: string) {
    const target = files.value.find((file) => file.id === fileId);
    if (!target) return;
    const targetFolderId = folderId || undefined;
    if ((target.folderId || undefined) === targetFolderId) return;

    const timestamp = nowIso();
    const sourceGroup = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === (target.folderId || ""))).filter((file) => file.id !== fileId);
    const destinationGroup = sortFilesByOrder(files.value.filter((file) => file.id !== fileId && (file.folderId || "") === (targetFolderId || "")));

    const movedFile: SavedSqlFile = {
      ...target,
      folderId: targetFolderId,
      updatedAt: timestamp,
    };

    const nextSource = reindexFiles(sourceGroup, target.folderId || undefined).map((file) => ({
      ...file,
      updatedAt: timestamp,
    }));
    const nextDestination = reindexFiles([...destinationGroup, movedFile], targetFolderId).map((file) => ({
      ...file,
      updatedAt: timestamp,
    }));

    const untouched = files.value.filter((file) => file.id !== fileId && (file.folderId || "") !== (target.folderId || "") && (file.folderId || "") !== (targetFolderId || ""));

    await persistFiles([...untouched, ...nextSource, ...nextDestination]);
  }

  async function reorderFiles(draggedId: string, targetId: string, position: "before" | "after") {
    const dragged = files.value.find((file) => file.id === draggedId);
    const target = files.value.find((file) => file.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;

    const targetFolderId = target.folderId || undefined;
    const groupFiles = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === (targetFolderId || "")));
    const remainingGroup = groupFiles.filter((file) => file.id !== draggedId);
    const draggedNext: SavedSqlFile = {
      ...dragged,
      folderId: targetFolderId,
      updatedAt: nowIso(),
    };
    const targetIndex = remainingGroup.findIndex((file) => file.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remainingGroup.splice(insertIndex, 0, draggedNext);

    const updatedGroup = reindexFiles(remainingGroup, targetFolderId).map((file) => ({
      ...file,
      updatedAt: draggedNext.updatedAt,
    }));

    const previousGroupId = dragged.folderId || undefined;
    const sourceGroup = previousGroupId === targetFolderId ? [] : reindexFiles(sortFilesByOrder(files.value.filter((file) => file.id !== draggedId && (file.folderId || "") === (previousGroupId || ""))), previousGroupId).map((file) => ({ ...file, updatedAt: draggedNext.updatedAt }));

    const untouched = files.value.filter((file) => file.id !== draggedId && (file.folderId || "") !== (targetFolderId || "") && (file.folderId || "") !== (previousGroupId || ""));

    await persistFiles([...untouched, ...sourceGroup, ...updatedGroup]);
  }

  const allFolders = computed(() => sortFoldersByOrder(folders.value));

  const allFiles = computed(() => sortFilesByOrder(files.value));

  function filesInFolder(folderId: string) {
    return allFiles.value.filter((f) => f.folderId === folderId);
  }

  function filesWithoutFolder() {
    return allFiles.value.filter((f) => !f.folderId);
  }

  function orphanedFileIds(activeConnectionIds: Set<string>) {
    return new Set(files.value.filter((f) => !activeConnectionIds.has(f.connectionId)).map((f) => f.id));
  }

  return {
    folders,
    files,
    isLoaded,
    version,
    initFromStorage,
    listFolders,
    listFiles,
    getFile,
    createFolder,
    renameFolder,
    deleteFolder,
    saveFile,
    renameFile,
    deleteFile,
    reorderFolders,
    reorderFiles,
    moveFileToFolder,
    syncToLocalDirectory,
    allFolders,
    allFiles,
    filesInFolder,
    filesWithoutFolder,
    orphanedFileIds,
  };
});
