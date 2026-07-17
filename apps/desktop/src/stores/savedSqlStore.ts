import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { forgetSavedSqlEditorPosition } from "@/lib/app/savedSqlEditorPosition";
import { ensureSqlExtension } from "@/lib/savedSql/savedSqlFileName";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "@/types/database";

const LEGACY_STORAGE_KEY = "dbx-saved-sql-library";

interface SavedSqlState {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}

interface SaveFileInput {
  id?: string;
  connectionId: string;
  folderId?: string;
  name: string;
  database: string;
  schema?: string;
  sql: string;
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

function folderDepth(items: SavedSqlFolder[], folderId: string) {
  const byId = new Map(items.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byId.get(folderId);
  while (current?.parentFolderId && !seen.has(current.parentFolderId)) {
    seen.add(current.parentFolderId);
    depth++;
    current = byId.get(current.parentFolderId);
  }
  return depth;
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
  let initFromStoragePromise: Promise<void> | null = null;
  const pendingFolderCreates = new Map<string, Promise<SavedSqlFolder>>();

  const version = ref(0);
  function bumpVersion() {
    version.value++;
  }

  function applyLibrary(library: SavedSqlLibrary) {
    folders.value = library.folders;
    files.value = library.files.map((file) => ({ ...file, sqlLoaded: file.sqlLoaded ?? Boolean(file.sql) }));
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
    if (isLoaded.value) return;
    if (!initFromStoragePromise) {
      initFromStoragePromise = (async () => {
        await migrateLegacyLocalStorage();
        applyLibrary(await api.loadSavedSqlLibrary());
        isLoaded.value = true;
      })().finally(() => {
        initFromStoragePromise = null;
      });
    }
    await initFromStoragePromise;
  }

  function listFolders(connectionId: string) {
    return listChildFolders(connectionId);
  }

  function listChildFolders(connectionId: string, parentFolderId?: string) {
    return sortFoldersByOrder(folders.value.filter((folder) => folder.connectionId === connectionId && (folder.parentFolderId || "") === (parentFolderId || "")));
  }

  function listFiles(connectionId: string, folderId?: string) {
    return sortFilesByOrder(files.value.filter((file) => file.connectionId === connectionId && (file.folderId || "") === (folderId || "")));
  }

  function folderCreateKey(connectionId: string, name: string, parentFolderId?: string) {
    return JSON.stringify([connectionId, parentFolderId || "", name]);
  }

  function getFile(id: string) {
    return files.value.find((file) => file.id === id);
  }

  async function ensureFileContent(id: string) {
    const existing = getFile(id);
    if (!existing) return undefined;
    if (existing.sqlLoaded !== false) return existing;

    const loaded = await api.loadSavedSqlFile(id);
    if (!loaded) return existing;
    const hydrated = { ...loaded, sqlLoaded: true };
    files.value = files.value.map((file) => (file.id === id ? hydrated : file));
    bumpVersion();
    return hydrated;
  }

  async function createFolder(connectionId: string, name: string, parentFolderId?: string) {
    const key = folderCreateKey(connectionId, name, parentFolderId);
    const pending = pendingFolderCreates.get(key);
    if (pending) return pending;

    const createPromise = (async () => {
      const timestamp = nowIso();
      const folder: SavedSqlFolder = {
        id: uuid(),
        connectionId,
        parentFolderId: parentFolderId || undefined,
        name,
        orderIndex: maxOrderIndex(folders.value.filter((item) => item.connectionId === connectionId && (item.parentFolderId || "") === (parentFolderId || ""))) + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const saved = await api.saveSavedSqlFolder(folder);
      folders.value = [...folders.value.filter((item) => item.id !== saved.id), saved];
      bumpVersion();
      await syncToLocalDirectory();
      return saved;
    })();

    pendingFolderCreates.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      if (pendingFolderCreates.get(key) === createPromise) {
        pendingFolderCreates.delete(key);
      }
    }
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
    const removedIds = descendantFolderIds(id);
    await api.deleteSavedSqlFolder(id);
    folders.value = folders.value.filter((folder) => !removedIds.has(folder.id));
    files.value = files.value.filter((file) => !file.folderId || !removedIds.has(file.folderId));
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function saveFile(input: SaveFileInput) {
    const timestamp = nowIso();
    const existing = input.id ? getFile(input.id) : undefined;
    const hasFolderIdInput = Object.prototype.hasOwnProperty.call(input, "folderId");
    const file: SavedSqlFile = existing
      ? {
          ...existing,
          // Partial metadata updates should not move files out of their folder.
          // Callers that intentionally move to root pass `folderId: undefined`.
          folderId: hasFolderIdInput ? input.folderId || undefined : existing.folderId,
          name: input.name,
          database: input.database,
          schema: input.schema,
          sql: input.sql,
          sqlLoaded: true,
          connectionId: input.connectionId,
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
          sqlLoaded: true,
          orderIndex: maxOrderIndex(files.value.filter((file) => file.connectionId === input.connectionId && (file.folderId || "") === (input.folderId || undefined || ""))) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const saved = await api.saveSavedSqlFile(file);
    files.value = [...files.value.filter((item) => item.id !== saved.id), { ...saved, sqlLoaded: true }];
    bumpVersion();
    await syncToLocalDirectory();
    return saved;
  }

  async function renameFile(id: string, name: string) {
    const existing = getFile(id);
    if (!existing) return;
    const normalizedName = ensureSqlExtension(name);
    const saved = await api.saveSavedSqlFile({ ...existing, name: normalizedName, updatedAt: nowIso() });
    files.value = files.value.map((file) => (file.id === id ? { ...saved, sql: file.sql, sqlLoaded: file.sqlLoaded } : file));
    bumpVersion();

    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    for (const tab of queryStore.tabs) {
      if (tab.savedSqlId === id) {
        tab.title = saved.name;
        tab.customTitle = true;
      }
    }

    await syncToLocalDirectory();
  }

  async function recordFileUsage(id: string) {
    const existing = getFile(id);
    if (!existing) return;
    try {
      const saved = await api.saveSavedSqlFile({
        ...existing,
        openCount: (existing.openCount ?? 0) + 1,
        openedAt: nowIso(),
      });
      files.value = files.value.map((file) => (file.id === id ? { ...saved, sql: file.sql, sqlLoaded: file.sqlLoaded } : file));
      bumpVersion();
      return saved;
    } catch (error) {
      console.warn("[DBX][saved-sql:usage:error]", error);
      return existing;
    }
  }

  async function deleteFile(id: string) {
    await api.deleteSavedSqlFile(id);
    files.value = files.value.filter((file) => file.id !== id);
    bumpVersion();
    await syncToLocalDirectory();

    // Close all tabs that reference this saved SQL file
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabsToClose = queryStore.tabs.filter((tab) => tab.savedSqlId === id);
    for (const tab of tabsToClose) {
      queryStore.closeTab(tab.id, { force: true });
    }
    forgetSavedSqlEditorPosition(id);
  }

  async function persistFolders(nextFolders: SavedSqlFolder[]) {
    const reindexed = nextFolders.map((folder) => ({ ...folder, updatedAt: folder.updatedAt || nowIso() }));
    await Promise.all(reindexed.map((folder) => api.saveSavedSqlFolder(folder)));
    folders.value = reindexed;
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function persistFiles(nextFiles: SavedSqlFile[]) {
    const savedFiles = await Promise.all(nextFiles.map((file) => api.saveSavedSqlFile(file)));
    files.value = savedFiles.map((saved) => {
      const existing = files.value.find((file) => file.id === saved.id);
      return { ...saved, sql: existing?.sql ?? saved.sql, sqlLoaded: existing?.sqlLoaded ?? saved.sqlLoaded };
    });
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function syncEntries() {
    const folderById = new Map(folders.value.map((folder) => [folder.id, folder]));
    const folderPath = (folderId?: string): string | undefined => {
      if (!folderId) return undefined;
      const parts: string[] = [];
      const seen = new Set<string>();
      let current = folderById.get(folderId);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        parts.unshift(current.name);
        current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
      }
      return parts.join("/");
    };
    const loadedFiles = await Promise.all(sortFilesByOrder(files.value).map((file) => ensureFileContent(file.id)));
    return loadedFiles
      .filter((file): file is SavedSqlFile => Boolean(file))
      .map((file) => ({
        folderName: folderPath(file.folderId),
        fileName: file.name,
        sql: file.sql,
      }));
  }

  async function syncToLocalDirectory() {
    if (!isTauriRuntime()) return;
    const settingsStore = useSettingsStore();
    const targetDir = settingsStore.desktopSettings.saved_sql_sync_dir?.trim();
    if (!targetDir) return;

    const entries = await syncEntries();
    const syncPromise = pendingSync?.catch(() => {}).then(() => api.syncSavedSqlDirectory({ targetDir, entries })) ?? api.syncSavedSqlDirectory({ targetDir, entries });
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
    const dragged = folders.value.find((folder) => folder.id === draggedId);
    const target = folders.value.find((folder) => folder.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;
    if (descendantFolderIds(draggedId).has(targetId)) return;

    const timestamp = nowIso();
    const targetParentFolderId = target.parentFolderId || undefined;
    const previousParentFolderId = dragged.parentFolderId || undefined;
    const ordered = sortFoldersByOrder(folders.value.filter((folder) => (folder.parentFolderId || "") === (targetParentFolderId || "")));
    const remaining = ordered.filter((folder) => folder.id !== draggedId);
    const targetIndex = remaining.findIndex((folder) => folder.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remaining.splice(insertIndex, 0, { ...dragged, parentFolderId: targetParentFolderId, updatedAt: timestamp });

    const updatedTargetGroup = reindexFolders(remaining).map((folder) => ({
      ...folder,
      parentFolderId: targetParentFolderId,
      updatedAt: timestamp,
    }));
    const updatedSourceGroup =
      previousParentFolderId === targetParentFolderId
        ? []
        : reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({
            ...folder,
            updatedAt: timestamp,
          }));
    const untouched = folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") !== (targetParentFolderId || "") && (folder.parentFolderId || "") !== (previousParentFolderId || ""));
    await persistFolders([...untouched, ...updatedSourceGroup, ...updatedTargetGroup]);
  }

  function descendantFolderIds(folderId: string) {
    const ids = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders.value) {
        if (folder.parentFolderId && ids.has(folder.parentFolderId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  async function moveFolderToFolder(folderId: string, parentFolderId?: string) {
    const target = folders.value.find((folder) => folder.id === folderId);
    if (!target) return;
    const nextParentFolderId = parentFolderId || undefined;
    if ((target.parentFolderId || undefined) === nextParentFolderId) return;
    if (nextParentFolderId && descendantFolderIds(folderId).has(nextParentFolderId)) return;

    const timestamp = nowIso();
    const previousParentFolderId = target.parentFolderId || undefined;
    const sourceGroup = reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({ ...folder, updatedAt: timestamp }));
    const destinationGroup = reindexFolders([...sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (nextParentFolderId || ""))), { ...target, parentFolderId: nextParentFolderId, updatedAt: timestamp }]).map((folder) => ({
      ...folder,
      parentFolderId: nextParentFolderId,
      updatedAt: timestamp,
    }));
    const untouched = folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") !== (previousParentFolderId || "") && (folder.parentFolderId || "") !== (nextParentFolderId || ""));
    await persistFolders([...untouched, ...sourceGroup, ...destinationGroup]);
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

  async function moveFilesToFolder(fileIds: string[], folderId?: string) {
    const uniqueIds = [...new Set(fileIds)];
    if (uniqueIds.length === 0) return;

    const targetFolderId = folderId || undefined;
    const movingFiles = uniqueIds.map((id) => files.value.find((file) => file.id === id)).filter((file): file is SavedSqlFile => Boolean(file));
    const filesToMove = movingFiles.filter((file) => (file.folderId || undefined) !== targetFolderId);
    if (filesToMove.length === 0) return;
    const moveIdSet = new Set(filesToMove.map((file) => file.id));

    const timestamp = nowIso();
    const affectedFolderIds = new Set<string>(filesToMove.map((file) => file.folderId || ""));
    affectedFolderIds.add(targetFolderId || "");

    const movedFiles = filesToMove.map((file) => ({
      ...file,
      folderId: targetFolderId,
      updatedAt: timestamp,
    }));

    // Reindex each touched folder separately so moving a batch out of one
    // folder never rewrites unrelated siblings into the destination folder.
    const nextAffectedFiles = Array.from(affectedFolderIds).flatMap((groupId) => {
      const normalizedGroupId = groupId || undefined;
      const remaining = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === groupId && !moveIdSet.has(file.id)));
      const group = groupId === (targetFolderId || "") ? [...remaining, ...movedFiles] : remaining;
      return reindexFiles(group, normalizedGroupId).map((file) => ({
        ...file,
        updatedAt: timestamp,
      }));
    });
    const untouched = files.value.filter((file) => !affectedFolderIds.has(file.folderId || "") && !moveIdSet.has(file.id));

    await persistFiles([...untouched, ...nextAffectedFiles]);
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

  const allFoldersTreeOrder = computed(() =>
    [...folders.value].sort((a, b) => {
      const depthDiff = folderDepth(folders.value, a.id) - folderDepth(folders.value, b.id);
      if (depthDiff !== 0) return depthDiff;
      const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }),
  );

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
    listChildFolders,
    listFiles,
    getFile,
    ensureFileContent,
    createFolder,
    renameFolder,
    deleteFolder,
    saveFile,
    renameFile,
    recordFileUsage,
    deleteFile,
    reorderFolders,
    moveFolderToFolder,
    reorderFiles,
    moveFileToFolder,
    moveFilesToFolder,
    syncToLocalDirectory,
    allFolders,
    allFoldersTreeOrder,
    allFiles,
    filesInFolder,
    filesWithoutFolder,
    orphanedFileIds,
  };
});
