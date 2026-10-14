export function ensureSqlExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /\.sql$/i.test(trimmed) ? trimmed : `${trimmed}.sql`;
}

export function stripSqlExtension(name: string): string {
  return name.replace(/\.sql$/i, "");
}

interface SqlNameSeries {
  index: number;
  format: (index: number) => string;
}

/**
 * The de-duplication suffix family a name already belongs to.
 *
 * A name that carries its own trailing counter keeps that formatting so the
 * next free name stays in the same series — `query_3.sql` continues as
 * `query_4.sql` and `report (2).sql` as `report (3).sql`, never the nested
 * `query_4 (2).sql` / `report (2) (2).sql` that stacking a fresh suffix would
 * produce. Names without a counter start a parenthesized series at 2.
 */
function sqlNameSeries(base: string): SqlNameSeries | undefined {
  const parenthesized = /^(.*?)([ _]?)\((\d+)\)$/.exec(base);
  if (parenthesized?.[1]) return { index: Number(parenthesized[3]), format: (index) => `${parenthesized[1]}${parenthesized[2]}(${index}).sql` };
  const underscored = /^(.*?)_(\d+)$/.exec(base);
  if (underscored?.[1]) return { index: Number(underscored[2]), format: (index) => `${underscored[1]}_${index}.sql` };
  return undefined;
}

/**
 * Resolves `baseName` to the first name that is free in `takenNames`.
 *
 * `takenNames` must come from the same scope the caller will persist into —
 * the saved-SQL library keys names by connection, catalog, database and folder,
 * so a caller that counts a narrower set can still hand back a colliding name.
 * Matching is case-insensitive and `.sql` is implied, mirroring the library's
 * own uniqueness rule.
 */
export function nextAvailableSqlName(baseName: string, takenNames: ReadonlySet<string>): string {
  const normalized = ensureSqlExtension(baseName);
  const normalizedTakenNames = new Set([...takenNames].map((name) => ensureSqlExtension(name).toLocaleLowerCase()));
  if (!normalizedTakenNames.has(normalized.toLocaleLowerCase())) return normalized;

  const base = stripSqlExtension(normalized);
  const series = sqlNameSeries(base);
  const format = series?.format ?? ((index: number) => `${base} (${index}).sql`);
  let index = (series?.index ?? 1) + 1;
  while (normalizedTakenNames.has(format(index).toLocaleLowerCase())) index++;
  return format(index);
}

/**
 * Extracts a candidate database name from a filename or folder name when users name
 * files like `dbname - query.sql` or organize queries with database prefixes.
 */
export function extractCandidateDatabaseFromName(name: string): string | undefined {
  const stripped = stripSqlExtension(name).trim();
  const match = /^([a-zA-Z0-9_]+)\s*[-–—]\s*.+/.exec(stripped);
  if (match && match[1]) return match[1];
  return undefined;
}
