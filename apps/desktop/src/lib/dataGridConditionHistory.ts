import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/safeStorage";

const STORAGE_KEY = "dbx-data-grid-condition-history";
const MAX_HISTORY_PER_SCOPE = 12;

export type DataGridConditionHistoryKind = "where" | "orderBy";

export interface DataGridConditionHistoryScope {
  connectionId?: string;
  database?: string;
  schema?: string;
  tableName?: string;
}

interface StoredConditionHistory {
  version: 1;
  scopes: Record<string, string[]>;
}

function normalizeConditionInput(value: string | undefined): string {
  return (value ?? "").trim().replace(/;+$/, "").trim();
}

export function dataGridConditionHistoryScopeKey(kind: DataGridConditionHistoryKind, scope: DataGridConditionHistoryScope): string {
  return [kind, scope.connectionId ?? "", scope.database ?? "", scope.schema ?? "", scope.tableName ?? ""].join("\u0001");
}

function emptyHistory(): StoredConditionHistory {
  return { version: 1, scopes: {} };
}

function readHistory(): StoredConditionHistory {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConditionHistory>;
    if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== "object") return emptyHistory();
    return { version: 1, scopes: parsed.scopes };
  } catch {
    return emptyHistory();
  }
}

function writeHistory(history: StoredConditionHistory) {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(history));
}

export function loadDataGridConditionHistory(kind: DataGridConditionHistoryKind, scope: DataGridConditionHistoryScope, query = ""): string[] {
  const key = dataGridConditionHistoryScopeKey(kind, scope);
  const normalizedQuery = normalizeConditionInput(query).toLowerCase();
  const entries = readHistory().scopes[key] ?? [];
  if (!normalizedQuery) return entries.slice(0, MAX_HISTORY_PER_SCOPE);
  return entries.filter((entry) => entry.toLowerCase().includes(normalizedQuery)).slice(0, MAX_HISTORY_PER_SCOPE);
}

export function rememberDataGridConditionHistory(kind: DataGridConditionHistoryKind, scope: DataGridConditionHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeConditionInput(value);
  if (!normalized) return loadDataGridConditionHistory(kind, scope);

  const history = readHistory();
  const key = dataGridConditionHistoryScopeKey(kind, scope);
  const previous = history.scopes[key] ?? [];
  history.scopes[key] = [normalized, ...previous.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())].slice(0, MAX_HISTORY_PER_SCOPE);
  writeHistory(history);
  return history.scopes[key];
}

export function forgetDataGridConditionHistory(kind: DataGridConditionHistoryKind, scope: DataGridConditionHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeConditionInput(value);
  if (!normalized) return loadDataGridConditionHistory(kind, scope);

  const history = readHistory();
  const key = dataGridConditionHistoryScopeKey(kind, scope);
  history.scopes[key] = (history.scopes[key] ?? []).filter((entry) => entry.toLowerCase() !== normalized.toLowerCase());
  if (history.scopes[key].length === 0) delete history.scopes[key];
  writeHistory(history);
  return loadDataGridConditionHistory(kind, scope);
}
