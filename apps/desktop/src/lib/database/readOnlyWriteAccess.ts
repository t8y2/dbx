import { getActivePinia } from "pinia";
import { useReadOnlyUnlockStore, type WriteUnlockDurationSecs } from "@/stores/readOnlyUnlockStore";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";
import { classifySqlRisk, isSqlRiskMutation } from "@/lib/sql/sqlRisk";
import type { DatabaseType } from "@/types/database";

export type { WriteUnlockDurationSecs };

export const WRITE_UNLOCK_DURATIONS: WriteUnlockDurationSecs[] = [60, 300];

export function formatWriteUnlockRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function unlockStoreOrNull() {
  try {
    if (!getActivePinia()) return null;
    return useReadOnlyUnlockStore();
  } catch {
    return null;
  }
}

export function isWriteUnlockActive(connectionId: string | undefined | null): boolean {
  if (!connectionId) return false;
  return unlockStoreOrNull()?.isUnlocked(connectionId) === true;
}

export function connectionIsEffectivelyReadOnly(connection?: { id?: string; read_only?: boolean } | null): boolean {
  if (!connection?.read_only) return false;
  return !isWriteUnlockActive(connection.id);
}

export function sqlLooksLikeMutation(sql: string | undefined, databaseType?: DatabaseType): boolean {
  if (!sql?.trim()) return true;
  if (databaseType === "redis") {
    return sql.split("\n").some((line) => {
      const command = line.trim();
      return command.length > 0 && classifyRedisCommandSafety(command) !== "allowed";
    });
  }
  return isSqlRiskMutation(classifySqlRisk(sql, { dialect: databaseType }).risk);
}

export interface ReadOnlyWriteAccessOptions {
  connection?: { id?: string; name?: string; read_only?: boolean; db_type?: DatabaseType } | null;
  sql?: string;
  source?: string;
  treatAsMutation?: boolean;
}

export async function ensureReadOnlyWriteAccess(options: ReadOnlyWriteAccessOptions): Promise<boolean> {
  const connection = options.connection;
  if (!connection?.read_only) return true;
  if (!connection.id) return false;
  const store = unlockStoreOrNull();
  if (store?.isUnlocked(connection.id)) return true;
  const isMutation = options.treatAsMutation === true || sqlLooksLikeMutation(options.sql, connection.db_type);
  if (!isMutation) return true;
  if (!store) return false;
  return store.requestUnlock({
    connectionId: connection.id,
    connectionName: connection.name,
    sql: options.sql,
    source: options.source,
  });
}
