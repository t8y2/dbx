import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_KEY = "dbx-redis-key-search-history";
const MAX_HISTORY_PER_SCOPE = 20;
const LEGACY_SEARCH_MODES = ["key", "value", "all"] as const;

export interface RedisKeySearchHistoryScope {
  connectionId?: string;
  db?: number;
}

interface StoredKeySearchHistory {
  version: 1;
  scopes: Record<string, string[]>;
}

function normalizeSearchInput(value: string | undefined): string {
  return (value ?? "").trim();
}

export function redisKeySearchHistoryScopeKey(scope: RedisKeySearchHistoryScope): string {
  return [scope.connectionId ?? "", String(scope.db ?? "")].join("\u0001");
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

function mergeUniqueNewestFirst(entries: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeSearchInput(entry);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    if (merged.length >= MAX_HISTORY_PER_SCOPE) break;
  }
  return merged;
}

/** Resolve entries for a connection+db scope, migrating any legacy mode-scoped buckets. */
function scopeEntries(history: StoredKeySearchHistory, scope: RedisKeySearchHistoryScope): string[] {
  const key = redisKeySearchHistoryScopeKey(scope);
  const legacyKeys = LEGACY_SEARCH_MODES.map((mode) => `${key}\u0001${mode}`);
  const hasLegacy = legacyKeys.some((legacyKey) => (history.scopes[legacyKey]?.length ?? 0) > 0);
  if (!hasLegacy) return history.scopes[key] ?? [];

  const merged = mergeUniqueNewestFirst([...(history.scopes[key] ?? []), ...legacyKeys.flatMap((legacyKey) => history.scopes[legacyKey] ?? [])]);
  history.scopes[key] = merged;
  for (const legacyKey of legacyKeys) delete history.scopes[legacyKey];
  writeHistory(history);
  return merged;
}

export function loadRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, query = ""): string[] {
  const normalizedQuery = normalizeSearchInput(query).toLowerCase();
  const entries = scopeEntries(readHistory(), scope);
  if (!normalizedQuery) return entries.slice(0, MAX_HISTORY_PER_SCOPE);
  return entries.filter((entry) => entry.toLowerCase().includes(normalizedQuery)).slice(0, MAX_HISTORY_PER_SCOPE);
}

export function rememberRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeSearchInput(value);
  if (!normalized) return loadRedisKeySearchHistory(scope);

  const history = readHistory();
  const key = redisKeySearchHistoryScopeKey(scope);
  const previous = scopeEntries(history, scope);
  history.scopes[key] = mergeUniqueNewestFirst([normalized, ...previous]);
  writeHistory(history);
  return history.scopes[key];
}

export function forgetRedisKeySearchHistory(scope: RedisKeySearchHistoryScope, value: string | undefined): string[] {
  const normalized = normalizeSearchInput(value);
  if (!normalized) return loadRedisKeySearchHistory(scope);

  const history = readHistory();
  const key = redisKeySearchHistoryScopeKey(scope);
  const previous = scopeEntries(history, scope);
  history.scopes[key] = previous.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase());
  if (history.scopes[key].length === 0) delete history.scopes[key];
  writeHistory(history);
  return loadRedisKeySearchHistory(scope);
}
