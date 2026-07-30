import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { loadDataGridColumnLayout, saveDataGridColumnLayout } from "@/lib/dataGrid/dataGridColumnLayoutStorage";

const STORAGE_PREFIX = "dbx-document-grid-column-visibility:v1:";

export interface DocumentGridColumnVisibilityScope {
  databaseType?: string;
  connectionId: string;
  database: string;
  collection: string;
}

export function documentGridColumnVisibilityScopeKey(scope: DocumentGridColumnVisibilityScope): string {
  return ["document-column-visibility", scope.databaseType ?? "", scope.connectionId, scope.database, scope.collection].join("\u0001");
}

export function loadDocumentGridHiddenColumnKeys(scopeKey: string): string[] {
  const raw = safeLocalStorageGet(`${STORAGE_PREFIX}${scopeKey}`);
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((key): key is string => typeof key === "string"))];
  } catch (error) {
    console.warn(`[DBX][document-grid-column-visibility:parse] ${scopeKey}`, error);
    return [];
  }
}

export function saveDocumentGridHiddenColumnKeys(scopeKey: string, hiddenColumnKeys: readonly string[]) {
  const normalizedKeys = [...new Set(hiddenColumnKeys)];
  if (normalizedKeys.length === 0) {
    safeLocalStorageRemove(`${STORAGE_PREFIX}${scopeKey}`);
    return;
  }
  safeLocalStorageSet(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(normalizedKeys));
}

export function migrateDocumentGridColumnVisibilityToLayout(legacyScopeKey: string, layoutScopeKey: string) {
  const legacyStorageKey = `${STORAGE_PREFIX}${legacyScopeKey}`;
  if (loadDataGridColumnLayout(layoutScopeKey)) {
    safeLocalStorageRemove(legacyStorageKey);
    return;
  }
  const hiddenKeys = loadDocumentGridHiddenColumnKeys(legacyScopeKey);
  if (hiddenKeys.length === 0) return;
  saveDataGridColumnLayout(layoutScopeKey, { orderKeys: [], hiddenKeys });
  if (loadDataGridColumnLayout(layoutScopeKey)) safeLocalStorageRemove(legacyStorageKey);
}
