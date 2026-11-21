import { containsHan, pinyinFirstLetters } from "@/lib/common/pinyin";

export type QuickSearchResultType = "connection" | "plugin_workbench" | "database" | "schema" | "table" | "view" | "materialized_view" | "column" | "procedure" | "function" | "sequence" | "package" | "package-body" | "sql_file" | "sql_library_file" | "content_match" | "plugin_command";

export type QuickSearchCategory = "all" | "connections" | "databases" | "objects" | "fields" | "files" | "content" | "commands";

export function quickSearchCategory(result: QuickSearchResult): Exclude<QuickSearchCategory, "all"> {
  if (result.type === "connection") return "connections";
  if (result.type === "database" || result.type === "schema") return "databases";
  if (result.type === "column") return "fields";
  if (result.type === "sql_file" || result.type === "sql_library_file") return "files";
  if (result.type === "content_match") return "content";
  if (result.type === "plugin_command" || result.type === "plugin_workbench") return "commands";
  return "objects";
}

export type QuickSearchSource = "cache" | "remote" | "file" | "content" | "plugin";

/** Shared result contract for every item shown by the global quick search. */
export interface QuickSearchResult {
  id: string;
  type: QuickSearchResultType;
  label: string;
  description?: string;
  connectionId: string;
  database?: string;
  catalog?: string;
  schema?: string;
  /** Search namespace when the engine's database is its schema; not a navigation target. */
  schemaNamespace?: string;
  objectName?: string;
  signature?: string;
  tableName?: string;
  columnName?: string;
  columnComment?: string;
  tableComment?: string;
  tableType?: string;
  connectionName?: string;
  searchText: string;
  source?: QuickSearchSource;
  searchScope?: "data" | "structure";
}

export interface QuickSearchFields {
  name: string;
  comment: string;
  context: string;
  path: string;
}

export interface QuickSearchNormalizedFields {
  name: string;
  comment: string;
  context: string;
  path: string;
  searchText: string;
  pinyinName: string;
}

export interface QuickSearchQuery {
  raw: string;
  text: string;
  terms: string[];
  filters: {
    kind?: string;
    database?: string;
    schema?: string;
    comment?: string;
    file?: string;
    connection?: string;
    source?: QuickSearchSource;
    category?: "objects" | "files" | "commands";
  };
}

const FILTER_RE = /(^|\s)([a-z][a-z-]*):("[^"]*"|'[^']*'|\S+)/gi;

const KIND_ALIASES: Record<string, string> = {
  package_body: "package-body",
  field: "column",
  fields: "column",
  col: "column",
  cols: "column",
  relation: "table",
  relations: "table",
  sql: "sql_file",
  command: "plugin_command",
  commands: "plugin_command",
  object: "object",
  file: "file",
};

function normalizeFilterValue(value: string): string {
  const unquoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value;
  return unquoted.trim();
}

function normalizeKind(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return KIND_ALIASES[normalized] || normalized;
}

/** Parse DataGrip-style filters while preserving ordinary words as free text. */
export function parseQuickSearchQuery(raw: string): QuickSearchQuery {
  const filters: QuickSearchQuery["filters"] = {};
  const consumed: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  FILTER_RE.lastIndex = 0;
  while ((match = FILTER_RE.exec(raw))) {
    const key = match[2]!.toLowerCase();
    const value = normalizeFilterValue(match[3]!);
    if (!value) continue;
    if (key === "kind" || key === "type") filters.kind = normalizeKind(value);
    else if (key === "db" || key === "database") filters.database = value;
    else if (key === "schema") filters.schema = value;
    else if (key === "comment") filters.comment = value;
    else if (key === "file" || key === "path") filters.file = value;
    else if (key === "conn" || key === "connection") filters.connection = value;
    else if (key === "source") filters.source = value.toLowerCase() as QuickSearchSource;
    else if (key === "category" || key === "group") filters.category = value.toLowerCase() as QuickSearchQuery["filters"]["category"];
    else continue;
    consumed.push([match.index, FILTER_RE.lastIndex]);
  }

  let text = raw;
  for (let index = consumed.length - 1; index >= 0; index--) {
    const [start, end] = consumed[index]!;
    text = `${text.slice(0, start)} ${text.slice(end)}`;
  }
  const terms = text.trim().split(/\s+/).filter(Boolean);
  return { raw, text: terms.join(" "), terms, filters };
}

function includesValue(value: string | undefined, expected: string | undefined): boolean {
  return !expected || (value || "").toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function normalizedQuickSearchFields(result: QuickSearchResult & { filePath?: string; fileName?: string }, fields = quickSearchFields(result)): QuickSearchNormalizedFields {
  return {
    name: fields.name.toLowerCase(),
    comment: fields.comment.toLocaleLowerCase(),
    context: fields.context.toLocaleLowerCase(),
    path: fields.path.toLocaleLowerCase(),
    searchText: result.searchText.toLocaleLowerCase(),
    pinyinName: containsHan(fields.name) ? pinyinFirstLetters(fields.name) : "",
  };
}

export function quickSearchFields(result: QuickSearchResult & { filePath?: string; fileName?: string }): QuickSearchFields {
  const comment = [result.columnComment, result.tableComment].filter(Boolean).join(" ");
  const context = [result.connectionName, result.catalog, result.database, result.schema, result.tableName, result.objectName].filter(Boolean).join(" ");
  const path = [result.filePath, result.fileName, result.type === "sql_file" || result.type === "sql_library_file" ? result.label : ""].filter(Boolean).join(" ");
  return {
    name: result.label,
    comment,
    context,
    path,
  };
}

/** Narrow connection/database contexts before applying the remote request budget. */
export function matchesQuickSearchContext(context: Pick<QuickSearchResult, "connectionName" | "database">, query: QuickSearchQuery): boolean {
  return includesValue(context.connectionName, query.filters.connection) && includesValue(context.database, query.filters.database);
}

/** Apply all explicit filters before fuzzy ranking is attempted. */
export function matchesQuickSearchQuery(result: QuickSearchResult & { filePath?: string; fileName?: string }, query: QuickSearchQuery): boolean {
  return matchesQuickSearchQueryFields(result, query, normalizedQuickSearchFields(result));
}

function matchesQuickSearchQueryFields(result: QuickSearchResult, query: QuickSearchQuery, fields: QuickSearchNormalizedFields): boolean {
  const filters = query.filters;
  if (filters.kind) {
    const kindMatches = filters.kind === "file" ? ["sql_file", "sql_library_file", "content_match"].includes(result.type) : filters.kind === "object" ? !["sql_file", "sql_library_file", "content_match", "plugin_command", "plugin_workbench"].includes(result.type) : result.type === filters.kind;
    if (!kindMatches) return false;
  }
  if (!matchesQuickSearchContext(result, query)) return false;
  if (filters.schema && !(result.schemaNamespace ?? result.schema ?? "").toLocaleLowerCase().includes(filters.schema.toLocaleLowerCase())) return false;
  if (filters.comment && !fields.comment.includes(filters.comment.toLocaleLowerCase())) return false;
  if (filters.file && !fields.path.includes(filters.file.toLocaleLowerCase())) return false;
  if (filters.source && inferQuickSearchSource(result) !== filters.source) return false;
  if (filters.category) {
    const category = result.type === "sql_file" || result.type === "sql_library_file" || result.type === "content_match" ? "files" : result.type === "plugin_command" || result.type === "plugin_workbench" ? "commands" : "objects";
    if (category !== filters.category) return false;
  }
  return true;
}

export interface QuickSearchIndexEntry<T extends QuickSearchResult = QuickSearchResult> {
  result: T;
  fields: QuickSearchFields;
  normalized: QuickSearchNormalizedFields;
  source: QuickSearchSource;
}

export interface QuickSearchIndex<T extends QuickSearchResult = QuickSearchResult> {
  entries: QuickSearchIndexEntry<T>[];
  byName: Map<string, QuickSearchIndexEntry<T>[]>;
  byComment: Map<string, QuickSearchIndexEntry<T>[]>;
  byCharacter: Map<string, Uint32Array>;
}

export function inferQuickSearchSource(result: QuickSearchResult): QuickSearchSource {
  if (result.source) return result.source;
  if (result.type === "plugin_command" || result.type === "plugin_workbench") return "plugin";
  if (result.type === "sql_file" || result.type === "sql_library_file" || result.type === "content_match") return result.type === "content_match" ? "content" : "file";
  if (result.id.startsWith("structure-")) return "remote";
  return "cache";
}

/** Build the local metadata index once per reactive source snapshot. */
export function buildQuickSearchIndex<T extends QuickSearchResult & { filePath?: string; fileName?: string }>(results: T[]): QuickSearchIndex<T> {
  return updateQuickSearchIndex(undefined, results);
}

/** Reuse unchanged entries when a reactive source publishes a new snapshot. */
export function updateQuickSearchIndex<T extends QuickSearchResult & { filePath?: string; fileName?: string }>(previous: QuickSearchIndex<T> | undefined, results: T[]): QuickSearchIndex<T> {
  const previousById = new Map((previous?.entries || []).map((entry) => [entry.result.id, entry]));
  const entries = results.map((result) => {
    const fields = quickSearchFields(result);
    const source = inferQuickSearchSource(result);
    const old = previousById.get(result.id);
    if (old && old.source === source && old.fields.name === fields.name && old.fields.comment === fields.comment && old.fields.context === fields.context && old.fields.path === fields.path && old.normalized.searchText === result.searchText.toLocaleLowerCase()) {
      old.result = result;
      return old;
    }
    return { result, fields, normalized: normalizedQuickSearchFields(result, fields), source };
  });
  const byName = new Map<string, QuickSearchIndexEntry<T>[]>();
  const byComment = new Map<string, QuickSearchIndexEntry<T>[]>();
  const characterPostings = new Map<string, number[]>();
  for (const [entryIndex, entry] of entries.entries()) {
    const nameKey = entry.normalized.name;
    const nameEntries = byName.get(nameKey);
    if (nameEntries) nameEntries.push(entry);
    else byName.set(nameKey, [entry]);
    for (const comment of entry.normalized.comment.split(/\s+/).filter(Boolean)) {
      const commentEntries = byComment.get(comment);
      if (commentEntries) commentEntries.push(entry);
      else byComment.set(comment, [entry]);
    }
    const searchableCharacters = new Set(`${entry.normalized.name} ${entry.normalized.comment} ${entry.normalized.context} ${entry.normalized.path} ${entry.normalized.searchText} ${entry.normalized.pinyinName}`);
    for (const character of searchableCharacters) {
      if (/\s/u.test(character)) continue;
      const characterEntries = characterPostings.get(character);
      if (characterEntries) characterEntries.push(entryIndex);
      else characterPostings.set(character, [entryIndex]);
    }
  }
  const byCharacter = new Map([...characterPostings].map(([character, posting]) => [character, Uint32Array.from(posting)]));
  return { entries, byName, byComment, byCharacter };
}

/** Narrow the full index using characters that must occur in any literal or fuzzy match. */
export function quickSearchCandidateEntries<T extends QuickSearchResult>(index: QuickSearchIndex<T>, query: QuickSearchQuery): QuickSearchIndexEntry<T>[] {
  const filterText = [query.text, query.filters.comment, query.filters.file, query.filters.connection, query.filters.database, query.filters.schema].filter(Boolean).join(" ").toLocaleLowerCase();
  const characters = [...new Set([...filterText].filter((character) => !/\s/u.test(character)))];
  if (characters.length === 0) return index.entries;

  let smallest: Uint32Array | undefined;
  for (const character of characters) {
    const entries = index.byCharacter.get(character);
    if (!entries) return [];
    if (!smallest || entries.length < smallest.length) smallest = entries;
  }
  if (!smallest) return index.entries;
  let candidates = Array.from(smallest);
  const allowedMarks = new Uint32Array(index.entries.length);
  let mark = 0;
  for (const character of characters) {
    const entries = index.byCharacter.get(character)!;
    if (entries === smallest) continue;
    mark += 1;
    for (const entryIndex of entries) allowedMarks[entryIndex] = mark;
    candidates = candidates.filter((entryIndex) => allowedMarks[entryIndex] === mark);
    if (candidates.length === 0) return [];
  }
  return candidates.map((entryIndex) => index.entries[entryIndex]!);
}

export function matchesIndexedQuickSearchQuery<T extends QuickSearchResult>(entry: QuickSearchIndexEntry<T>, query: QuickSearchQuery): boolean {
  return matchesQuickSearchQueryFields(entry.result, query, entry.normalized);
}

export interface QuickSearchFieldMatch {
  kind: "exact" | "prefix" | "substring";
  score: number;
}

/** Literal field matching used for comments, paths and connection context. */
export function matchQuickSearchField(query: string, value: string): QuickSearchFieldMatch | null {
  return matchQuickSearchFieldNormalized(query.trim().toLocaleLowerCase(), value.toLocaleLowerCase());
}

export function matchQuickSearchFieldNormalized(normalizedQuery: string, normalizedValue: string): QuickSearchFieldMatch | null {
  if (!normalizedQuery) return { kind: "exact", score: 900 };
  if (normalizedValue === normalizedQuery) return { kind: "exact", score: 5 };
  if (normalizedValue.startsWith(normalizedQuery)) return { kind: "prefix", score: 220 + Math.min(normalizedValue.length - normalizedQuery.length, 99) };
  const index = normalizedValue.indexOf(normalizedQuery);
  if (index >= 0) return { kind: "substring", score: 420 + Math.min(index, 99) };
  return null;
}
