import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";
import { uuid } from "@/lib/common/utils";

export interface OracleTriggerRecoveryScope {
  connectionId: string;
  database: string;
  schema: string;
  name: string;
  tableSchema?: string;
  tableName?: string;
}
export interface OracleTriggerRecoveryEntry {
  id: string;
  savedAt: string;
  source: string;
  enabled: boolean;
  tableSchema?: string;
  tableName?: string;
}

function key(scope: OracleTriggerRecoveryScope): string {
  return `oracle-trigger-recovery:${JSON.stringify([scope.connectionId, scope.database, scope.schema, scope.name])}`;
}

export async function loadOracleTriggerRecovery(scope: OracleTriggerRecoveryScope): Promise<OracleTriggerRecoveryEntry[]> {
  const value = await loadBrowserAppState(key(scope));
  if (value === null) return [];
  const malformed =
    !Array.isArray(value) ||
    value.some((entry) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.savedAt !== "string" || typeof entry.source !== "string" || typeof entry.enabled !== "boolean") return true;
      const hasTarget = entry.tableSchema !== undefined || entry.tableName !== undefined;
      return hasTarget && (typeof entry.tableSchema !== "string" || !entry.tableSchema || typeof entry.tableName !== "string" || !entry.tableName);
    });
  if (malformed) throw new Error("Trigger recovery history could not be read; existing recovery data was preserved");
  return value;
}

const writes = new Map<string, Promise<unknown>>();

export async function preserveOracleTriggerRecovery(scope: OracleTriggerRecoveryScope, source: string, enabled: boolean): Promise<OracleTriggerRecoveryEntry> {
  const scopeKey = key(scope);
  const previous = writes.get(scopeKey) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      const entries = await loadOracleTriggerRecovery(scope);
      const entry: OracleTriggerRecoveryEntry = { id: uuid(), savedAt: new Date().toISOString(), source, enabled };
      if (scope.tableSchema !== undefined || scope.tableName !== undefined) {
        if (!scope.tableSchema || !scope.tableName) throw new Error("Trigger recovery target identity is incomplete");
        entry.tableSchema = scope.tableSchema;
        entry.tableName = scope.tableName;
      }
      await saveBrowserAppState(scopeKey, [...entries, entry]);
      return entry;
    });
  writes.set(scopeKey, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(scopeKey) === pending) writes.delete(scopeKey);
  }
}
