import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { nextTransferTaskCopyName, TransferTaskNameConflictError, useTransferTaskStore } from "@/stores/transferTaskStore";
import type { TransferTask, TransferTaskConfig, TransferTaskLibrary } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({
  loadTransferTaskLibrary: vi.fn(),
  saveTransferTaskLibrary: vi.fn(),
}));

function makeConfig(overrides: Partial<TransferTaskConfig> = {}): TransferTaskConfig {
  return {
    sourceConnectionId: "conn-a",
    sourceDatabase: "app_db",
    sourceSchema: "public",
    targetConnectionId: "conn-b",
    targetDatabase: "warehouse",
    targetSchema: "public",
    objects: { TABLE: ["users", "orders"] },
    content: "structureAndData",
    mode: "append",
    targetTableNameCase: "preserve",
    batchSize: 1000,
    ...overrides,
  };
}

async function createTask(store: ReturnType<typeof useTransferTaskStore>, name: string, folderId?: string): Promise<TransferTask> {
  const input: { name: string; folderId?: string; config: TransferTaskConfig } = { name, config: makeConfig() };
  if (folderId !== undefined) input.folderId = folderId;
  return store.saveTask(input);
}

describe("transferTaskStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.loadTransferTaskLibrary).mockResolvedValue(null);
    vi.mocked(api.saveTransferTaskLibrary).mockResolvedValue(undefined);
  });

  it("loads and normalizes the persisted library", async () => {
    const library: TransferTaskLibrary = {
      folders: [{ id: "folder-1", name: "ETL", orderIndex: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      tasks: [{ id: "task-1", folderId: "folder-1", name: "daily sync", orderIndex: 0, config: makeConfig(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    };
    vi.mocked(api.loadTransferTaskLibrary).mockResolvedValue(library);
    const store = useTransferTaskStore();
    await store.initFromStorage();

    expect(store.isLoaded).toBe(true);
    expect(store.folders).toHaveLength(1);
    expect(store.tasks).toHaveLength(1);
    expect(store.listTasks("folder-1").map((task) => task.id)).toEqual(["task-1"]);
  });

  it("drops invalid entries when normalizing the persisted library", async () => {
    vi.mocked(api.loadTransferTaskLibrary).mockResolvedValue({
      folders: [{ id: "folder-1", name: "ETL" }, { name: "missing id" }],
      tasks: [
        { id: "task-1", name: "ok", config: makeConfig() },
        { id: "task-2", name: "no config" },
        { id: "task-3", name: "no target", config: makeConfig({ targetDatabase: "" }) },
      ],
    });
    const store = useTransferTaskStore();
    await store.initFromStorage();

    expect(store.folders.map((folder) => folder.id)).toEqual(["folder-1"]);
    expect(store.tasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("creates folders and rejects duplicate names within the same parent", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();

    await store.createFolder("ETL");
    await expect(store.createFolder("etl")).rejects.toBeInstanceOf(TransferTaskNameConflictError);

    const child = await store.createFolder("etl", store.folders[0]?.id);
    expect(child.parentFolderId).toBe(store.folders[0]?.id);
    expect(api.saveTransferTaskLibrary).toHaveBeenCalled();
  });

  it("creates and updates tasks, keeping the folder on config-only updates", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const folder = await store.createFolder("ETL");
    const task = await store.saveTask({ name: "sync", folderId: folder.id, config: makeConfig() });

    const updated = await store.saveTask({ id: task.id, name: "sync", config: makeConfig({ mode: "overwrite" }) });
    expect(updated.folderId).toBe(folder.id);
    expect(updated.config.mode).toBe("overwrite");
    expect(store.tasks).toHaveLength(1);
  });

  it("rejects duplicate task names within the same folder", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    await createTask(store, "sync");
    await expect(createTask(store, "SYNC")).rejects.toBeInstanceOf(TransferTaskNameConflictError);

    const folder = await store.createFolder("ETL");
    await expect(createTask(store, "sync", folder.id)).resolves.toBeTruthy();
  });

  it("duplicates a task with an incrementing copy name", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const task = await createTask(store, "sync");

    const first = await store.duplicateTask(task.id);
    const second = await store.duplicateTask(task.id);

    expect(first?.name).toBe("sync_copy1");
    expect(second?.name).toBe("sync_copy2");
    expect(first?.config).toEqual(task.config);
    expect(first?.id).not.toBe(task.id);
  });

  it("cascades folder deletion to descendant folders and tasks", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const parent = await store.createFolder("parent");
    const child = await store.createFolder("child", parent.id);
    await createTask(store, "in-parent", parent.id);
    await createTask(store, "in-child", child.id);
    await createTask(store, "root-task");

    await store.deleteFolder(parent.id);

    expect(store.folders).toHaveLength(0);
    expect(store.tasks.map((task) => task.name)).toEqual(["root-task"]);
  });

  it("moves a task into a folder and reindexes both groups", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const folder = await store.createFolder("ETL");
    const first = await createTask(store, "first");
    const second = await createTask(store, "second");

    await store.moveTaskToFolder(first.id, folder.id);

    expect(store.getTask(first.id)?.folderId).toBe(folder.id);
    expect(store.listTasks(undefined).map((task) => task.name)).toEqual(["second"]);
    expect(store.listTasks(folder.id).map((task) => task.name)).toEqual(["first"]);
    expect(store.listTasks(undefined)[0]?.orderIndex).toBe(0);
    expect(second.folderId).toBeUndefined();
  });

  it("reorders tasks within a folder", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const first = await createTask(store, "first");
    await createTask(store, "second");
    const third = await createTask(store, "third");

    await store.reorderTasks(third.id, first.id, "before");

    expect(store.listTasks(undefined).map((task) => task.name)).toEqual(["third", "first", "second"]);
    expect(store.listTasks(undefined).map((task) => task.orderIndex)).toEqual([0, 1, 2]);
  });

  it("moves a folder into another folder and prevents cycles", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    const parent = await store.createFolder("parent");
    const child = await store.createFolder("child", parent.id);

    // Moving a folder into its own descendant must be rejected (cycle).
    await store.moveFolderToFolder(parent.id, child.id);
    expect(store.folders.find((folder) => folder.id === parent.id)?.parentFolderId).toBeUndefined();

    await store.moveFolderToFolder(child.id, undefined);
    expect(store.folders.find((folder) => folder.id === child.id)?.parentFolderId).toBeUndefined();
  });

  it("rolls back state when persistence fails", async () => {
    const store = useTransferTaskStore();
    await store.initFromStorage();
    await store.createFolder("ETL");

    vi.mocked(api.saveTransferTaskLibrary).mockRejectedValueOnce(new Error("disk full"));
    await expect(store.createFolder("fail")).rejects.toThrow("disk full");

    expect(store.folders.map((folder) => folder.name)).toEqual(["ETL"]);
  });
});

describe("nextTransferTaskCopyName", () => {
  it("increments the copy suffix and reuses a stripped copy base", () => {
    expect(nextTransferTaskCopyName("sync", new Set())).toBe("sync_copy1");
    expect(nextTransferTaskCopyName("sync", new Set(["sync_copy1"]))).toBe("sync_copy2");
    expect(nextTransferTaskCopyName("sync_copy1", new Set(["sync_copy1"]))).toBe("sync_copy2");
  });
});
