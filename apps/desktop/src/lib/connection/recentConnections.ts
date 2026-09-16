export const RECENT_CONNECTION_IDS_STORAGE_KEY = "dbx-recent-connection-ids-v1";
export const MAX_RECENT_CONNECTION_IDS = 5;

function normalizeRecentConnectionIds(ids: readonly unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of ids) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length === MAX_RECENT_CONNECTION_IDS) break;
  }

  return normalized;
}

export function parseRecentConnectionIds(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeRecentConnectionIds(parsed) : [];
  } catch {
    return [];
  }
}

export function recordRecentConnection(history: readonly string[], connectionId: string): readonly string[] {
  const id = connectionId.trim();
  const nextHistory = normalizeRecentConnectionIds(id ? [id, ...history] : history);
  const unchanged = nextHistory.length === history.length && nextHistory.every((value, index) => value === history[index]);
  return unchanged ? history : nextHistory;
}

export function rankRecentConnections<T extends { id: string }>(connections: readonly T[], history: readonly string[], limit = MAX_RECENT_CONNECTION_IDS): T[] {
  const cappedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), MAX_RECENT_CONNECTION_IDS)) : MAX_RECENT_CONNECTION_IDS;
  if (cappedLimit === 0) return [];

  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const ranked: T[] = [];
  const selectedIds = new Set<string>();

  for (const id of normalizeRecentConnectionIds(history)) {
    const connection = connectionById.get(id);
    if (!connection) continue;
    ranked.push(connection);
    selectedIds.add(id);
    if (ranked.length === cappedLimit) return ranked;
  }

  for (const connection of connections) {
    if (selectedIds.has(connection.id)) continue;
    ranked.push(connection);
    selectedIds.add(connection.id);
    if (ranked.length === cappedLimit) break;
  }

  return ranked;
}
