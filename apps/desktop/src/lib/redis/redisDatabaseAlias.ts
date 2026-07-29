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
