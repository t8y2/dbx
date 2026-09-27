export type RedisDatabaseAliases = Record<string, string>;

function redisDatabaseKey(database: string | number): string | null {
  const index = typeof database === "number" ? database : Number(database);
  return Number.isInteger(index) && index >= 0 ? String(index) : null;
}

export function normalizeRedisDatabaseAliases(value: unknown): RedisDatabaseAliases | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const aliases: RedisDatabaseAliases = {};
  for (const [database, alias] of Object.entries(value)) {
    const key = redisDatabaseKey(database);
    const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
    if (key != null && normalizedAlias) aliases[key] = normalizedAlias;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

export function redisDatabaseAlias(aliases: RedisDatabaseAliases | undefined, database: string | number): string | undefined {
  const key = redisDatabaseKey(database);
  return key == null ? undefined : aliases?.[key]?.trim() || undefined;
}

export function redisDatabaseLabel(database: string | number, aliases?: RedisDatabaseAliases, totalKeyCount?: number): string {
  const key = redisDatabaseKey(database) ?? String(database);
  const alias = redisDatabaseAlias(aliases, key);
  const name = alias ? `db${key} · ${alias}` : `db${key}`;
  return totalKeyCount == null ? name : `${name} (${totalKeyCount})`;
}

// Default kept large enough that connections with a typical (or even a few
// hundred) configured databases render exactly as before #1236 — only a
// connection with an unusually large `databases` count hits the cap and gets
// a "load more" node instead of a wall of sidebar rows.
export const REDIS_DATABASE_DISPLAY_LIMIT_DEFAULT = 1000;
export const REDIS_DATABASE_DISPLAY_LIMIT_MIN = 10;
export const REDIS_DATABASE_DISPLAY_LIMIT_MAX = 100_000;
export const REDIS_DATABASE_DISPLAY_LIMIT_OPTIONS = [50, 100, 200, 500, 1000, 2000, 5000] as const;

export function limitRedisDatabaseList<T>(items: T[], limit: number | undefined): { visible: T[]; hasMore: boolean } {
  const effectiveLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : REDIS_DATABASE_DISPLAY_LIMIT_DEFAULT;
  if (items.length <= effectiveLimit) return { visible: items, hasMore: false };
  return { visible: items.slice(0, effectiveLimit), hasMore: true };
}
