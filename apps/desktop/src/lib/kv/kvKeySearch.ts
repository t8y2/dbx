import type { KvKeySummary } from "@/lib/backend/api";

export function normalizeKvKeySearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function kvKeyMatchesSearch(key: string, query: string): boolean {
  const normalized = normalizeKvKeySearchQuery(query);
  return !normalized || key.toLocaleLowerCase().includes(normalized);
}

export function filterKvKeysBySearch(keys: readonly KvKeySummary[], query: string): KvKeySummary[] {
  return keys.filter((key) => kvKeyMatchesSearch(key.key, query));
}
