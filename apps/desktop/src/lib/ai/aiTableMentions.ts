export interface AiTableMention {
  raw: string;
  /**
   * Owning database (#11660). Chips picked from the candidate list always record
   * it; a hand-typed mention carries it only when its leading segment names a
   * selected database. Whether it is also written into the raw text is decided
   * by `aiTableMentionQualifier`, so a single-database mention reads as before.
   */
  database?: string;
  schema?: string;
  table: string;
}

export const AI_TABLE_MENTION_SCHEMA_LIMIT = 8;
export const AI_TABLE_MENTION_CANDIDATE_LIMIT = 200;

const SIMPLE_IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

function isMentionBoundary(char: string | undefined): boolean {
  return !char || /\s|[([{,;:]/.test(char);
}

function isUnquotedMentionChar(char: string): boolean {
  return /[\p{L}\p{N}_$.-]/u.test(char);
}

function readQuotedSegment(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "`") return null;
  let value = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === quote) {
      if (source[i + 1] === quote) {
        value += quote;
        i++;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += char;
  }
  return null;
}

function readMentionToken(source: string, start: number): { raw: string; parts: string[]; end: number } | null {
  let i = start;
  const parts: string[] = [];
  let raw = "";

  while (i < source.length) {
    const quoted = readQuotedSegment(source, i);
    if (quoted) {
      parts.push(quoted.value);
      raw += source.slice(i, quoted.end);
      i = quoted.end;
    } else {
      let value = "";
      const valueStart = i;
      while (i < source.length && isUnquotedMentionChar(source[i]) && source[i] !== ".") {
        value += source[i];
        i++;
      }
      if (!value) break;
      parts.push(value);
      raw += source.slice(valueStart, i);
    }

    if (source[i] !== ".") break;
    raw += ".";
    i++;
  }

  const usableParts = parts.filter(Boolean);
  if (!usableParts.length) return null;
  return { raw, parts: usableParts, end: i };
}

function matchesSelectedDatabase(value: string, selectedDatabases: readonly string[]): boolean {
  return selectedDatabases.some((database) => database.toLowerCase() === value.toLowerCase());
}

/**
 * Reads the database/schema/table parts of a mention token.
 *
 * A segment is read as the database only when it names one of
 * `selectedDatabases` (#11660): two parts are then `database.table` (the
 * MySQL-style name, which has no schema level), three or more are
 * `database.schema.table`. Anything else keeps the legacy reading, where the
 * last two segments are schema and table — a hand-typed name with an extra
 * leading segment stays resolvable instead of turning into a database this run
 * cannot read and being dropped.
 */
function splitMentionParts(parts: string[], selectedDatabases: readonly string[]): { database?: string; schema?: string; table: string } {
  const table = parts[parts.length - 1];
  if (parts.length === 1) return { table };
  if (parts.length === 2) {
    const leading = parts[0];
    return matchesSelectedDatabase(leading, selectedDatabases) ? { database: leading, table } : { schema: leading, table };
  }
  const schema = parts[parts.length - 2];
  const database = parts[parts.length - 3];
  return matchesSelectedDatabase(database, selectedDatabases) ? { database, schema, table } : { schema, table };
}

export function parseAiTableMentions(text: string, selectedDatabases: readonly string[] = []): AiTableMention[] {
  const mentions: AiTableMention[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isMentionBoundary(text[i - 1])) continue;
    const token = readMentionToken(text, i + 1);
    if (!token) continue;

    const { database, schema, table } = splitMentionParts(token.parts, selectedDatabases);
    const key = aiTableMentionKey(schema, table, database);
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(database ? { raw: `@${token.raw}`, database, schema, table } : { raw: `@${token.raw}`, schema, table });
    }
    i = token.end - 1;
  }

  return mentions;
}

export function formatAiTableMention(schema: string | undefined, table: string, database?: string): string {
  const parts = [database, schema, table].filter((part): part is string => !!part);
  return `@${parts.map(formatMentionPart).join(".")}`;
}

function formatMentionPart(part: string): string {
  if (SIMPLE_IDENTIFIER_RE.test(part)) return part;
  return `"${part.replace(/"/g, '""')}"`;
}

/**
 * Label shown for a mention chip or candidate row (no `@` sigil). Same argument
 * order as `formatAiTableMention` so the two cannot be mixed up.
 */
export function formatAiTableMentionLabel(schema: string | undefined, table: string, database?: string): string {
  return [database, schema, table].filter(Boolean).join(".");
}

/**
 * Database to write into a fully qualified mention, label or schema entry: one
 * is named while several databases are in play, or when it differs from the
 * run's primary database (#11660). A single-database reference to the primary
 * database stays bare, exactly as it was before multi-database mentions.
 */
export function aiTableMentionQualifier(database: string | undefined, primaryDatabase: string, multipleDatabases: boolean): string | undefined {
  if (!database) return undefined;
  if (multipleDatabases) return database;
  return database.toLowerCase() === primaryDatabase.toLowerCase() ? undefined : database;
}

export function aiTableMentionKey(schema: string | undefined, table: string, database?: string): string {
  return `${database || ""}.${schema || ""}.${table}`.toLowerCase();
}

/**
 * Splits what the user typed after `@` into an optional database prefix, an
 * optional schema prefix and the table filter.
 *
 * A leading segment is read as a database only when it names one of
 * `selectedDatabases` (#11660) — candidate labels are written in that same
 * order. Anything else keeps the legacy reading, where the part before the last
 * dot is a schema, so single-database filtering is unchanged.
 */
export function normalizeAiTableMentionQuery(query: string, selectedDatabases: readonly string[] = []): { databasePrefix?: string; schemaPrefix: string; tableFilter: string } {
  const clean = query.replace(/^["`]+|["`]+$/g, "");
  const segments = clean.split(".").map((segment) => segment.replace(/^["`]+|["`]+$/g, ""));
  const databasePrefix = segments.length > 1 && selectedDatabases.some((database) => database.toLowerCase() === segments[0].toLowerCase()) ? segments[0] : undefined;
  const scoped = (databasePrefix ? segments.slice(1) : segments).join(".");
  const dot = scoped.lastIndexOf(".");
  const parsed = dot < 0 ? { schemaPrefix: "", tableFilter: scoped } : { schemaPrefix: scoped.slice(0, dot), tableFilter: scoped.slice(dot + 1) };
  return databasePrefix ? { databasePrefix, ...parsed } : parsed;
}

/**
 * Which databases a `@` candidate load covers, and how much of the candidate
 * budget each of them gets (#11660).
 *
 * A query naming a selected database scopes the load to it; otherwise every
 * selected database is searched. The budget is split evenly so one large
 * database cannot consume all of it and push the other databases' candidates
 * out of the list.
 */
export function aiTableMentionDatabasePlan(databases: readonly string[], databasePrefix: string | undefined, totalLimit = AI_TABLE_MENTION_CANDIDATE_LIMIT): { databases: string[]; perDatabaseLimit: number } {
  const scoped = databasePrefix ? databases.filter((database) => database.toLowerCase() === databasePrefix.toLowerCase()) : [...databases];
  return { databases: scoped, perDatabaseLimit: Math.max(1, Math.ceil(totalLimit / Math.max(scoped.length, 1))) };
}

/**
 * Drops the mentions that belong to a database the composer no longer selects
 * (#11660): the reference could not be resolved any more, so the chip would
 * quote a table that never reaches the request. Unqualified mentions
 * (single-database mode) are always kept.
 */
export function withoutAiTableMentionsOfDatabases<T extends AiTableMention>(mentions: T[], removedDatabases: Iterable<string>): T[] {
  const removed = new Set<string>();
  for (const database of removedDatabases) removed.add(database.toLowerCase());
  // Handing back the caller's own array when nothing is dropped keeps the
  // composer's ref identity stable, so a caller that runs on every option change
  // does not re-trigger the watchers behind it.
  if (!removed.size) return mentions;
  return mentions.filter((mention) => !mention.database || !removed.has(mention.database.toLowerCase()));
}

export function filterAiTableMentionCandidates<T extends { name: string }>(candidates: T[], tableFilter: string, limit = AI_TABLE_MENTION_CANDIDATE_LIMIT): T[] {
  const normalizedFilter = tableFilter.toLowerCase();
  return candidates.filter((candidate) => !normalizedFilter || candidate.name.toLowerCase().includes(normalizedFilter)).slice(0, limit);
}
