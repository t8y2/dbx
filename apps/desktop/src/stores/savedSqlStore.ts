import { defineStore } from "pinia";
import { ref } from "vue";
import { uuid } from "@/lib/utils";
import * as api from "@/lib/api";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "@/types/database";

const LEGACY_STORAGE_KEY = "dbx-saved-sql-library";

interface SavedSqlState {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}

function nowIso() {
  return new Date().toISOString();
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
  }

  function listFolders(connectionId: string) {
    return folders.value
      .filter((folder) => folder.connectionId === connectionId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }

  function listFiles(connectionId: string, folderId?: string) {
    return files.value
      .filter((file) => file.connectionId === connectionId && (file.folderId || "") === (folderId || ""))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await api.saveSavedSqlFolder(folder);
    folders.value = [...folders.value.filter((item) => item.id !== saved.id), saved];
    bumpVersion();
    return saved;
  }

  async function renameFolder(id: string, name: string) {
    const existing = folders.value.find((folder) => folder.id === id);
    if (!existing) return;
    const saved = await api.saveSavedSqlFolder({ ...existing, name, updatedAt: nowIso() });
    folders.value = folders.value.map((folder) => (folder.id === id ? saved : folder));
    bumpVersion();
  }

  async function deleteFolder(id: string) {
    await api.deleteSavedSqlFolder(id);
    folders.value = folders.value.filter((folder) => folder.id !== id);
    files.value = files.value.filter((file) => file.folderId !== id);
    bumpVersion();
  }

  async function saveFile(input: {
    id?: string;
    connectionId: string;
    folderId?: string;
    name: string;
    database: string;
    schema?: string;
    sql: string;
  }) {
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
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const saved = await api.saveSavedSqlFile(file);
    files.value = [...files.value.filter((item) => item.id !== saved.id), saved];
    bumpVersion();
    return saved;
  }

  async function renameFile(id: string, name: string) {
    const existing = getFile(id);
    if (!existing) return;
    const saved = await api.saveSavedSqlFile({ ...existing, name, updatedAt: nowIso() });
    files.value = files.value.map((file) => (file.id === id ? saved : file));
    bumpVersion();
  }

  async function deleteFile(id: string) {
    await api.deleteSavedSqlFile(id);
    files.value = files.value.filter((file) => file.id !== id);
    bumpVersion();
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
  };
});
