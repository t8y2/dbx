import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import type { TransferTask, TransferTaskConfig, TransferTaskFolder, TransferTaskLibrary } from "@/types/database";

export class TransferTaskNameConflictError extends Error {
  readonly code = "TRANSFER_TASK_NAME_CONFLICT";

  constructor(readonly entryName: string) {
    super(`"${entryName}" already exists in this location.`);
    this.name = "TransferTaskNameConflictError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sortFoldersByOrder(items: TransferTaskFolder[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function sortTasksByOrder(items: TransferTask[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function reindexFolders(items: TransferTaskFolder[]) {
  return items.map((folder, index) => ({ ...folder, orderIndex: index }));
}

function reindexTasks(items: TransferTask[], folderId?: string) {
  return items.map((task, index) => ({ ...task, folderId, orderIndex: index }));
}

function maxOrderIndex(values: Array<{ orderIndex?: number }>) {
  return values.reduce((max, item) => Math.max(max, item.orderIndex ?? -1), -1);
}

function normalizeFolder(raw: unknown): TransferTaskFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TransferTaskFolder>;
  if (!candidate.id || !candidate.name) return null;
  return {
    id: String(candidate.id),
    parentFolderId: candidate.parentFolderId || undefined,
    name: String(candidate.name),
    orderIndex: typeof candidate.orderIndex === "number" ? candidate.orderIndex : 0,
    createdAt: candidate.createdAt || nowIso(),
    updatedAt: candidate.updatedAt || nowIso(),
  };
}

function normalizeTask(raw: unknown): TransferTask | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TransferTask>;
  const config = candidate.config;
  if (!candidate.id || !candidate.name || !config || typeof config !== "object") return null;
  if (!config.sourceConnectionId || !config.sourceDatabase || !config.targetConnectionId || !config.targetDatabase) return null;
  const objects: TransferTaskConfig["objects"] = {};
  if (config.objects && typeof config.objects === "object") {
    for (const [kind, names] of Object.entries(config.objects)) {
      if (Array.isArray(names)) objects[kind as keyof typeof objects] = names.filter((name): name is string => typeof name === "string");
    }
  }
  return {
    id: String(candidate.id),
    folderId: candidate.folderId || undefined,
    name: String(candidate.name),
    orderIndex: typeof candidate.orderIndex === "number" ? candidate.orderIndex : 0,
    config: {
      sourceConnectionId: String(config.sourceConnectionId),
      sourceCatalog: config.sourceCatalog || undefined,
      sourceDatabase: String(config.sourceDatabase),
      sourceSchema: config.sourceSchema || undefined,
      targetConnectionId: String(config.targetConnectionId),
      targetCatalog: config.targetCatalog || undefined,
      targetDatabase: String(config.targetDatabase),
      targetSchema: config.targetSchema || undefined,
      objects,
      content: config.content ?? "structureAndData",
      mode: config.mode ?? "append",
      targetTableNameCase: config.targetTableNameCase ?? "preserve",
      quoteTargetColumnNames: config.quoteTargetColumnNames ?? true,
      batchSize: typeof config.batchSize === "number" && config.batchSize > 0 ? config.batchSize : 1000,
    },
    createdAt: candidate.createdAt || nowIso(),
    updatedAt: candidate.updatedAt || nowIso(),
  };
}

function normalizeLibrary(raw: unknown): TransferTaskLibrary {
  if (raw === null || raw === undefined) return { version: 1, folders: [], tasks: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid transfer task library");

  const candidate = raw as { version?: unknown; folders?: unknown; tasks?: unknown };
  if (candidate.version !== undefined && candidate.version !== 1) {
    throw new Error(`Unsupported transfer task library version: ${String(candidate.version)}`);
  }
  if (!Array.isArray(candidate.folders) || !Array.isArray(candidate.tasks)) {
    throw new Error("Invalid transfer task library");
  }

  const normalizedFolders = candidate.folders.map(normalizeFolder);
  const normalizedTasks = candidate.tasks.map(normalizeTask);
  if (normalizedFolders.some((folder) => !folder) || normalizedTasks.some((task) => !task)) {
    throw new Error("Invalid transfer task library entry");
  }

  return {
    version: 1,
    folders: normalizedFolders as TransferTaskFolder[],
    tasks: normalizedTasks as TransferTask[],
  };
}

/** Copy name for duplicated tasks: "name_copy1", "name_copy2", ... */
export function nextTransferTaskCopyName(sourceName: string, takenNames: ReadonlySet<string>): string {
  const copyBase = sourceName.replace(/_copy\d+$/i, "") || sourceName;
  const normalizedTaken = new Set([...takenNames].map((name) => name.toLocaleLowerCase()));
  let index = 1;
  while (normalizedTaken.has(`${copyBase}_copy${index}`.toLocaleLowerCase())) index++;
  return `${copyBase}_copy${index}`;
}

export const useTransferTaskStore = defineStore("transferTasks", () => {
  const folders = ref<TransferTaskFolder[]>([]);
  const tasks = ref<TransferTask[]>([]);
  const isLoaded = ref(false);
  let initPromise: Promise<void> | null = null;
  let initError: unknown = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  async function initFromStorage() {
    if (isLoaded.value) return;
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const library = normalizeLibrary(await api.loadTransferTaskLibrary());
          folders.value = library.folders;
          tasks.value = library.tasks;
          initError = null;
          isLoaded.value = true;
        } catch (error) {
          initError = error;
          // Backend unavailable or persisted data is invalid: keep empty state and retry on next init.
        }
      })().finally(() => {
        initPromise = null;
      });
    }
    await initPromise;
  }

  async function ensureInitialized() {
    await initFromStorage();
    if (!isLoaded.value) {
      throw initError instanceof Error ? initError : new Error("Failed to load transfer task library");
    }
  }

  function queueMutation<Args extends unknown[], Result>(mutation: (...args: Args) => Promise<Result>) {
    return (...args: Args): Promise<Result> => {
      const result = mutationQueue.then(async () => {
        await ensureInitialized();
        return mutation(...args);
      });
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
  }

  /** Whole-library persistence with rollback; public mutations run serially. */
  async function persist(nextFolders: TransferTaskFolder[], nextTasks: TransferTask[]) {
    const previousFolders = folders.value;
    const previousTasks = tasks.value;
    folders.value = nextFolders;
    tasks.value = nextTasks;
    try {
      const library: TransferTaskLibrary = { version: 1, folders: nextFolders, tasks: nextTasks };
      await api.saveTransferTaskLibrary(JSON.parse(JSON.stringify(library)));
    } catch (error) {
      folders.value = previousFolders;
      tasks.value = previousTasks;
      throw error;
    }
  }

  function listChildFolders(parentFolderId?: string) {
    return sortFoldersByOrder(folders.value.filter((folder) => (folder.parentFolderId || "") === (parentFolderId || "")));
  }

  function listTasks(folderId?: string) {
    return sortTasksByOrder(tasks.value.filter((task) => (task.folderId || "") === (folderId || "")));
  }

  function getTask(id: string) {
    return tasks.value.find((task) => task.id === id);
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

  function ensureFolderNameAvailable(name: string, parentFolderId: string | undefined, excludeId?: string) {
    const key = name.trim().toLocaleLowerCase();
    const conflict = folders.value.some((folder) => folder.id !== excludeId && (folder.parentFolderId || "") === (parentFolderId || "") && folder.name.trim().toLocaleLowerCase() === key);
    if (conflict) throw new TransferTaskNameConflictError(name);
  }

  function ensureTaskNameAvailable(name: string, folderId: string | undefined, excludeId?: string) {
    const key = name.trim().toLocaleLowerCase();
    const conflict = tasks.value.some((task) => task.id !== excludeId && (task.folderId || "") === (folderId || "") && task.name.trim().toLocaleLowerCase() === key);
    if (conflict) throw new TransferTaskNameConflictError(name);
  }

  async function createFolder(name: string, parentFolderId?: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new TransferTaskNameConflictError(name);
    ensureFolderNameAvailable(trimmed, parentFolderId);
    const timestamp = nowIso();
    const folder: TransferTaskFolder = {
      id: uuid(),
      parentFolderId: parentFolderId || undefined,
      name: trimmed,
      orderIndex: maxOrderIndex(folders.value.filter((item) => (item.parentFolderId || "") === (parentFolderId || ""))) + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persist([...folders.value, folder], tasks.value);
    return folder;
  }

  async function renameFolder(id: string, name: string) {
    const existing = folders.value.find((folder) => folder.id === id);
    if (!existing) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === existing.name) return;
    ensureFolderNameAvailable(trimmed, existing.parentFolderId, id);
    await persist(
      folders.value.map((folder) => (folder.id === id ? { ...folder, name: trimmed, updatedAt: nowIso() } : folder)),
      tasks.value,
    );
  }

  /** Deletes the folder, its descendant folders and all contained tasks. */
  async function deleteFolder(id: string) {
    const removedIds = descendantFolderIds(id);
    await persist(
      folders.value.filter((folder) => !removedIds.has(folder.id)),
      tasks.value.filter((task) => !task.folderId || !removedIds.has(task.folderId)),
    );
  }

  async function saveTask(input: { id?: string; folderId?: string; name: string; config: TransferTaskConfig }) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new TransferTaskNameConflictError(input.name);
    const existing = input.id ? getTask(input.id) : undefined;
    const folderId = Object.prototype.hasOwnProperty.call(input, "folderId") ? input.folderId || undefined : existing?.folderId;
    ensureTaskNameAvailable(trimmed, folderId, input.id);
    const timestamp = nowIso();
    const task: TransferTask = existing
      ? { ...existing, folderId, name: trimmed, config: input.config, updatedAt: timestamp }
      : {
          id: uuid(),
          folderId,
          name: trimmed,
          orderIndex: maxOrderIndex(tasks.value.filter((item) => (item.folderId || "") === (folderId || ""))) + 1,
          config: input.config,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    await persist(folders.value, [...tasks.value.filter((item) => item.id !== task.id), task]);
    return task;
  }

  async function renameTask(id: string, name: string) {
    const existing = getTask(id);
    if (!existing) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === existing.name) return;
    ensureTaskNameAvailable(trimmed, existing.folderId, id);
    await persist(
      folders.value,
      tasks.value.map((task) => (task.id === id ? { ...task, name: trimmed, updatedAt: nowIso() } : task)),
    );
  }

  async function duplicateTask(id: string) {
    const source = getTask(id);
    if (!source) return undefined;
    const takenNames = new Set(tasks.value.filter((task) => (task.folderId || "") === (source.folderId || "")).map((task) => task.name));
    const timestamp = nowIso();
    const copy: TransferTask = {
      ...JSON.parse(JSON.stringify(source)),
      id: uuid(),
      name: nextTransferTaskCopyName(source.name, takenNames),
      orderIndex: maxOrderIndex(tasks.value.filter((item) => (item.folderId || "") === (source.folderId || ""))) + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persist(folders.value, [...tasks.value, copy]);
    return copy;
  }

  async function deleteTask(id: string) {
    await persist(
      folders.value,
      tasks.value.filter((task) => task.id !== id),
    );
  }

  async function moveTaskToFolder(taskId: string, folderId?: string) {
    const target = getTask(taskId);
    if (!target) return;
    const targetFolderId = folderId || undefined;
    if ((target.folderId || undefined) === targetFolderId) return;

    const timestamp = nowIso();
    const sourceGroup = sortTasksByOrder(tasks.value.filter((task) => (task.folderId || "") === (target.folderId || "") && task.id !== taskId));
    const destinationGroup = sortTasksByOrder(tasks.value.filter((task) => task.id !== taskId && (task.folderId || "") === (targetFolderId || "")));
    const movedTask: TransferTask = { ...target, folderId: targetFolderId, updatedAt: timestamp };

    const nextSource = reindexTasks(sourceGroup, target.folderId || undefined).map((task) => ({ ...task, updatedAt: timestamp }));
    const nextDestination = reindexTasks([...destinationGroup, movedTask], targetFolderId).map((task) => ({ ...task, updatedAt: timestamp }));
    const untouched = tasks.value.filter((task) => task.id !== taskId && (task.folderId || "") !== (target.folderId || "") && (task.folderId || "") !== (targetFolderId || ""));
    await persist(folders.value, [...untouched, ...nextSource, ...nextDestination]);
  }

  async function moveFolderToFolder(folderId: string, parentFolderId?: string) {
    const target = folders.value.find((folder) => folder.id === folderId);
    if (!target) return;
    const nextParentFolderId = parentFolderId || undefined;
    if ((target.parentFolderId || undefined) === nextParentFolderId) return;
    if (nextParentFolderId && descendantFolderIds(folderId).has(nextParentFolderId)) return;

    const timestamp = nowIso();
    const previousParentFolderId = target.parentFolderId || undefined;
    const sourceGroup = reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({
      ...folder,
      updatedAt: timestamp,
    }));
    const destinationGroup = reindexFolders([...sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (nextParentFolderId || ""))), { ...target, parentFolderId: nextParentFolderId, updatedAt: timestamp }]).map((folder) => ({
      ...folder,
      parentFolderId: nextParentFolderId,
      updatedAt: timestamp,
    }));
    const untouched = folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") !== (previousParentFolderId || "") && (folder.parentFolderId || "") !== (nextParentFolderId || ""));
    await persist([...untouched, ...sourceGroup, ...destinationGroup], tasks.value);
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

    const updatedTargetGroup = reindexFolders(remaining).map((folder) => ({ ...folder, parentFolderId: targetParentFolderId, updatedAt: timestamp }));
    const updatedSourceGroup =
      previousParentFolderId === targetParentFolderId
        ? []
        : reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({
            ...folder,
            updatedAt: timestamp,
          }));
    const untouched = folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") !== (targetParentFolderId || "") && (folder.parentFolderId || "") !== (previousParentFolderId || ""));
    await persist([...untouched, ...updatedSourceGroup, ...updatedTargetGroup], tasks.value);
  }

  async function reorderTasks(draggedId: string, targetId: string, position: "before" | "after") {
    const dragged = getTask(draggedId);
    const target = getTask(targetId);
    if (!dragged || !target || dragged.id === target.id) return;

    const targetFolderId = target.folderId || undefined;
    const groupTasks = sortTasksByOrder(tasks.value.filter((task) => (task.folderId || "") === (targetFolderId || "")));
    const remainingGroup = groupTasks.filter((task) => task.id !== draggedId);
    const draggedNext: TransferTask = { ...dragged, folderId: targetFolderId, updatedAt: nowIso() };
    const targetIndex = remainingGroup.findIndex((task) => task.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remainingGroup.splice(insertIndex, 0, draggedNext);

    const updatedGroup = reindexTasks(remainingGroup, targetFolderId).map((task) => ({ ...task, updatedAt: draggedNext.updatedAt }));

    const previousGroupId = dragged.folderId || undefined;
    const sourceGroup = previousGroupId === targetFolderId ? [] : reindexTasks(sortTasksByOrder(tasks.value.filter((task) => task.id !== draggedId && (task.folderId || "") === (previousGroupId || ""))), previousGroupId).map((task) => ({ ...task, updatedAt: draggedNext.updatedAt }));

    const untouched = tasks.value.filter((task) => task.id !== draggedId && (task.folderId || "") !== (targetFolderId || "") && (task.folderId || "") !== (previousGroupId || ""));
    await persist(folders.value, [...untouched, ...sourceGroup, ...updatedGroup]);
  }

  const allFolders = computed(() => sortFoldersByOrder(folders.value));
  const allTasks = computed(() => sortTasksByOrder(tasks.value));

  return {
    folders,
    tasks,
    isLoaded,
    initFromStorage,
    listChildFolders,
    listTasks,
    getTask,
    createFolder: queueMutation(createFolder),
    renameFolder: queueMutation(renameFolder),
    deleteFolder: queueMutation(deleteFolder),
    saveTask: queueMutation(saveTask),
    renameTask: queueMutation(renameTask),
    duplicateTask: queueMutation(duplicateTask),
    deleteTask: queueMutation(deleteTask),
    moveTaskToFolder: queueMutation(moveTaskToFolder),
    moveFolderToFolder: queueMutation(moveFolderToFolder),
    reorderFolders: queueMutation(reorderFolders),
    reorderTasks: queueMutation(reorderTasks),
    allFolders,
    allTasks,
  };
});
