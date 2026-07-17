import type { SavedSqlFile } from "@/types/database";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_MS = 30 * DAY_MS;

export interface SavedSqlHistoryScope {
  connectionId?: string;
  database?: string;
  schema?: string;
  tableName?: string;
  limit?: number;
  now?: number;
}

function timestamp(value?: string) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function normalize(value?: string) {
  return (value || "").trim().toLowerCase();
}

function containsToken(text: string | undefined, token: string) {
  const normalizedText = normalize(text);
  const normalizedToken = normalize(token);
  if (!normalizedText || !normalizedToken) return false;
  return normalizedText.includes(normalizedToken);
}

function scopeRelevance(file: SavedSqlFile, scope: SavedSqlHistoryScope) {
  let score = 0;
  if (scope.database != null && file.database === scope.database) score += 100;
  if (scope.schema && file.schema === scope.schema) score += 30;
  if (scope.tableName) {
    const schemaTable = scope.schema ? `${scope.schema}.${scope.tableName}` : "";
    if (containsToken(file.name, scope.tableName) || containsToken(file.sql, scope.tableName)) score += 80;
    if (schemaTable && (containsToken(file.name, schemaTable) || containsToken(file.sql, schemaTable))) score += 40;
  }
  return score;
}

export function savedSqlHistoryScore(file: SavedSqlFile, now = Date.now()) {
  const openCount = Math.max(0, file.openCount ?? 0);
  const openedAt = timestamp(file.openedAt);
  const age = openedAt > 0 ? Math.max(0, now - openedAt) : RECENCY_WINDOW_MS;
  const recency = openedAt > 0 ? Math.max(0, 1 - age / RECENCY_WINDOW_MS) : 0;
  return openCount * 1000 + recency * 999;
}

export function savedSqlMatchesHistoryScope(file: SavedSqlFile, scope: SavedSqlHistoryScope) {
  if (scope.connectionId && file.connectionId !== scope.connectionId) return false;
  if (scope.database != null && file.database !== scope.database) return false;
  if (scope.schema && file.schema && file.schema !== scope.schema) return false;
  return true;
}

export function rankSavedSqlHistory(files: SavedSqlFile[], scope: SavedSqlHistoryScope = {}) {
  const now = scope.now ?? Date.now();
  const ranked = files
    .filter((file) => savedSqlMatchesHistoryScope(file, scope))
    .map((file) => ({
      file,
      score: scopeRelevance(file, scope) + savedSqlHistoryScore(file, now),
      openedAt: timestamp(file.openedAt),
      updatedAt: timestamp(file.updatedAt),
    }))
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const openedDiff = b.openedAt - a.openedAt;
      if (openedDiff !== 0) return openedDiff;
      const updatedDiff = b.updatedAt - a.updatedAt;
      if (updatedDiff !== 0) return updatedDiff;
      return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" });
    })
    .map((item) => item.file);

  return typeof scope.limit === "number" ? ranked.slice(0, Math.max(0, scope.limit)) : ranked;
}
