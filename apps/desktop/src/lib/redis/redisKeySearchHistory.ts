import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_KEY = "dbx-redis-key-search-history";
const MAX_HISTORY_PER_SCOPE = 20;

export type RedisKeySearchHistoryMode = "key" | "value" | "all";

export interface RedisKeySearchHistoryScope {
  connectionId?: string;
  db?: number;
  searchMode?: RedisKeySearchHistoryMode;
}

interface StoredKeySearchHistory {
  version: 1;
  scopes: Record<string, string[]>;
}

function normalizeSearchInput(value: string | undefined): string {
  return (value ?? "").trim();
}

export function redisKeySearchHistoryScopeKey(scope: RedisKeySearchHistoryScope): string {
  return [scope.connectionId ?? "", String(scope.db ?? ""), scope.searchMode ?? ""].join("\u0001");
}

function emptyHistory(): StoredKeySearchHistory {
  return { version: 1, scopes: {} };
}

function readHistory(): StoredKeySearchHistory {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredKeySearchHistory>;
    if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== "object") return emptyHistory();
    return { version: 1, scopes: parsed.scopes };
  } catch {
    return emptyHistory();
  }
}

function writeHistory(history: StoredKeySearchHistory) {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(history));
}

export function loadRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, query = ""): string[] {
  const key = redisKeySearchHistoryScopeKey(scope);
  const normalizedQuery = normalizeSearchInput(query).toLowerCase();
  const entries = readHistory().scopes[key] ?? [];
  if (!normalizedQuery) return entries.slice(0, MAX_HISTORY_PER_SCOPE);
  return entries.filter((entry) => entry.toLowerCase().includes(normalizedQuery)).slice(0, MAX_HISTORY_PER_SCOPE);
}

export function rememberRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeSearchInput(value);
  if (!normalized) return loadRedisKeySearchHistory(scope);

  const history = readHistory();
  const key = redisKeySearchHistoryScopeKey(scope);
  const previous = history.scopes[key] ?? [];
  history.scopes[key] = [normalized, ...previous.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())].slice(0, MAX_HISTORY_PER_SCOPE);
  writeHistory(history);
  return history.scopes[key];
}

export function forgetRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeSearchInput(value);
  if (!normalized) return loadRedisKeySearchHistory(scope);

  const history = readHistory();
  const key = redisKeySearchHistoryScopeKey(scope);
  history.scopes[key] = (history.scopes[key] ?? []).filter((entry) => entry.toLowerCase() !== normalized.toLowerCase());
  if (history.scopes[key].length === 0) delete history.scopes[key];
  writeHistory(history);
  return loadRedisKeySearchHistory(scope);
}
