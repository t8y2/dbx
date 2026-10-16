import { reactive } from "vue";
import { uuid } from "@/lib/common/utils";
import type { MongoDatabaseDumpProgress, MongoImportProgress } from "@/lib/backend/api";

/**
 * Externalizes Mongo import/dump/restore progress so the work (and its progress
 * face) outlives a panel unmount: the dialogs' awaits keep running after the
 * component is gone, and a remounted panel re-attaches to the same record.
 */
export type MongoTaskKind = "import" | "dump" | "restore";

export interface MongoTaskRecord {
  id: string;
  kind: MongoTaskKind;
  connectionId: string;
  database: string;
  /** Import only: the target collection. */
  collection?: string;
  status: "running" | "done" | "failed" | "cancelled";
  importProgress: MongoImportProgress | null;
  dumpProgress: MongoDatabaseDumpProgress | null;
  error: string;
  startedAt: number;
  finishedAt?: number;
}

const tasks = reactive(new Map<string, MongoTaskRecord>());

export function beginMongoTask(kind: MongoTaskKind, target: { connectionId: string; database: string; collection?: string }): MongoTaskRecord {
  const record: MongoTaskRecord = {
    id: uuid(),
    kind,
    connectionId: target.connectionId,
    database: target.database,
    collection: target.collection,
    status: "running",
    importProgress: null,
    dumpProgress: null,
    error: "",
    startedAt: Date.now(),
  };
  tasks.set(record.id, record);
  return tasks.get(record.id)!;
}

export function getMongoTask(id: string | null | undefined): MongoTaskRecord | undefined {
  return id ? tasks.get(id) : undefined;
}

/** Finds the most recent task for a target so a remounted panel can re-attach. */
export function findMongoTask(kind: MongoTaskKind, target: { connectionId: string; database: string; collection?: string }): MongoTaskRecord | undefined {
  let found: MongoTaskRecord | undefined;
  for (const record of tasks.values()) {
    if (record.kind !== kind) continue;
    if (record.connectionId !== target.connectionId || record.database !== target.database) continue;
    if (kind === "import" && (record.collection || "") !== (target.collection || "")) continue;
    if (!found || record.startedAt > found.startedAt) found = record;
  }
  return found;
}

export function updateMongoTaskImport(id: string, progress: MongoImportProgress): void {
  const record = tasks.get(id);
  if (!record) return;
  record.importProgress = progress;
}

export function updateMongoTaskDump(id: string, progress: MongoDatabaseDumpProgress): void {
  const record = tasks.get(id);
  if (!record) return;
  record.dumpProgress = progress;
  if (progress.status === "done") finishMongoTask(id, "done");
  else if (progress.status === "error") finishMongoTask(id, "failed", progress.errorMessage ?? "");
  else if (progress.status === "cancelled") finishMongoTask(id, "cancelled");
}

export function finishMongoTask(id: string, status: MongoTaskRecord["status"], error = ""): void {
  const record = tasks.get(id);
  if (!record) return;
  record.status = status;
  record.error = error;
  record.finishedAt = Date.now();
}
