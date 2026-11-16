import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { ConnectionConfig } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { connectionIsDorisFamilyCatalogCapable, isInternalDorisCatalog } from "@/lib/database/databaseCapabilities";
import { runDatabaseStructureSearch, supportsDatabaseStructureSearchFromManifest, type DatabaseStructureSearchHit } from "@/lib/database/databaseStructureSearch";
import { usesDocumentStructureSearch, usesSqlCatalogStructureSearch } from "@/lib/database/databaseStructureSearchCapabilities";
import { connectionObjectTreeNodeSchema, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import {
  decodeQuickOpenMetadataCache,
  encodeQuickOpenMetadataCache,
  isPersistedQuickOpenResultType,
  quickOpenMetadataCacheGeneration,
  quickOpenMetadataCacheKey,
  quickOpenMetadataConnectionFingerprint,
  type PersistedQuickOpenItem,
  type PersistedQuickOpenResultType,
} from "@/lib/quickOpen/quickOpenMetadataCache";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";
import { getSqlFileFilter, getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import { composeGlobalSearchRoots, getGlobalSearchExtensions, globalSearchSettingsVersion } from "@/lib/globalSearch/globalSearchSettings";
import { isQuickOpenScopeActive, pruneQuickOpenScope, quickOpenScopeIds, quickOpenScopeIncludes, setQuickOpenScopeIds } from "@/lib/quickOpen/quickOpenScope";
import { containsHan, pinyinFirstLetters } from "@/lib/common/pinyin";
import {
  quickSearchCategory,
  type QuickSearchCategory,
  type QuickSearchQuery,
  matchQuickSearchField,
  matchesQuickSearchContext,
  matchesQuickSearchQuery,
  parseQuickSearchQuery,
  updateQuickSearchIndex,
  type QuickSearchIndex,
  type QuickSearchResult,
  type QuickSearchResultType,
  type QuickSearchSource,
} from "@/lib/quickOpen/quickSearch";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import i18n, { currentLocale } from "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";

const REMOTE_SEARCH_DEBOUNCE_MS = 180;
const REMOTE_SEARCH_MIN_QUERY_LENGTH = 2;
const REMOTE_SEARCH_MAX_REQUESTS = 8;
const REMOTE_SEARCH_CONCURRENCY = 2;
const REMOTE_STRUCTURE_SEARCH_CONCURRENCY = 2;
const REMOTE_SEARCH_RESULTS_PER_REQUEST = 25;
const REMOTE_SEARCH_MAX_RESULTS_PER_CATEGORY = 100;
const QUICK_OPEN_MAX_RESULTS = 200;
const INITIAL_SQL_LIBRARY_LIMIT = 20;
const INITIAL_SQL_FILE_LIMIT = 20;
const RECENT_QUICK_OPEN_LIMIT = 12;
const RECENT_QUICK_OPEN_STORAGE_KEY = "dbx.quick-open.recent-items";
const RECENT_QUICK_OPEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

const CONTENT_SEARCH_DEBOUNCE_MS = 200;
const CONTENT_SEARCH_MAX_RESULTS = 500;

function utf16OffsetForUnicodeColumn(text: string, column: number): number {
  let remainingCharacters = Math.max(0, column - 1);
  let offset = 0;
  for (const character of text) {
    if (remainingCharacters-- <= 0) break;
    offset += character.length;
  }
  return offset;
}

const REMOTE_SEARCH_UNSUPPORTED_TYPES = new Set<ConnectionConfig["db_type"]>(["redis", "meilisearch", "solr", "couchdb", "qdrant", "weaviate", "chromadb", "victoriametrics", "etcd", "zookeeper", "mq", "nacos", "consul", "salesforce"]);

type QuickOpenCacheApiMethod = (...args: any[]) => Promise<any>;

function optionalQuickOpenCacheApiMethod(name: "deleteSchemaCachePrefix" | "loadSchemaCache" | "saveSchemaCache"): QuickOpenCacheApiMethod | undefined {
  try {
    const method = (api as unknown as Record<string, unknown>)[name];
    return typeof method === "function" ? (method as QuickOpenCacheApiMethod) : undefined;
  } catch {
    // Some unit-test module mocks intentionally omit unrelated backend methods.
    return undefined;
  }
}

export interface QuickOpenItem extends QuickSearchResult {
  type: QuickSearchResultType;
  source?: QuickSearchSource;
  objectName?: string; // For non-table objects (views, procedures, functions, sequences, packages)
  tableName?: string; // Kept for backward compatibility
  columnName?: string;
  columnComment?: string;
  tableComment?: string;
  tableType?: string;
  // Search text is retained for plugin and legacy integrations.
  filePath?: string; // For external SQL files
  fileModifiedAt?: number; // Filesystem mtime for external SQL files
  sqlFileId?: string; // For saved SQL library files
  fileName?: string; // For content matches: file name shown in the group header
  line?: number; // For content matches: 1-based line
  column?: number; // For content matches: 1-based char column
  matchText?: string; // For content matches: matched slice
  lineText?: string; // For content matches: full matching line
  highlightIndices?: [number, number]; // For content matches: [start, end) chars into lineText to highlight
  pluginId?: string; // For plugin commands and plugin workbenches: source plugin manifest id
  commandId?: string; // For plugin commands: short id of the command contribution
  pluginName?: string; // For plugin commands: source plugin display name (provenance hint)
  contributionId?: string; // For plugin workbenches: workbench contribution id
  pluginIcon?: string; // For plugin workbenches: contribution icon path, falling back to the manifest icon
}

export interface UseQuickOpenOptions {
  /**
   * External extra items (e.g. plugin commandPalette commands): merged into the initial list and the search result pool,
   * refreshed by the caller; with no query they are appended after the built-in entries in injection order.
   */
  extraItems?: Ref<QuickOpenItem[]>;
  category?: Ref<QuickSearchCategory>;
  /** Dialog visibility; standalone callers are enabled by default. */
  enabled?: Readonly<Ref<boolean>>;
}

export type QuickOpenMatchKind = "exact" | "initials" | "prefix" | "word-prefix" | "substring" | "fuzzy";

export interface QuickOpenMatch {
  kind: QuickOpenMatchKind;
  score: number;
  indices: number[];
}

interface IdentifierWord {
  text: string;
  start: number;
}

const IDENTIFIER_SEPARATOR_RE = /[_\-. /\\]/;

function identifierWords(text: string): IdentifierWord[] {
  const words: IdentifierWord[] = [];
  let start = -1;

  function pushWord(end: number): void {
    if (start < 0 || end <= start) return;
    words.push({ text: text.slice(start, end), start });
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (IDENTIFIER_SEPARATOR_RE.test(char)) {
      pushWord(index);
      start = -1;
      continue;
    }
    if (start < 0) {
      start = index;
      continue;
    }
    const previous = text[index - 1];
    if (previous >= "a" && previous <= "z" && char >= "A" && char <= "Z") {
      pushWord(index);
      start = index;
    }
  }
  pushWord(text.length);
  return words;
}

function rangeIndices(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

const PINYIN_QUERY_RE = /^[a-z0-9]+$/;

/**
 * Original-text indices of the characters that feed `pinyinFirstLetters(text)`, in order.
 * Iterates by Unicode code point (like `pinyinFirstLetters`), not UTF-16 code unit, so
 * supplementary-plane Han characters (surrogate pairs) stay aligned with the letters they produce.
 */
function pinyinLetterPositions(text: string): number[] {
  const positions: number[] = [];
  let index = 0;
  for (const char of text) {
    if (/[\p{Script=Han}a-z0-9]/iu.test(char)) positions.push(index);
    index += char.length;
  }
  return positions;
}

function matchWordPrefixes(words: IdentifierWord[], query: string): number[] | null {
  interface PrefixState {
    queryIndex: number;
    firstWordIndex: number;
    lastWordIndex: number;
    usedWords: number;
    indices: number[];
  }

  function stateScore(state: PrefixState): number {
    if (state.usedWords === 0) return 0;
    return (state.lastWordIndex - state.firstWordIndex - state.usedWords + 1) * 10 + state.usedWords;
  }

  function retainBest(states: Map<string, PrefixState>, candidate: PrefixState): void {
    const key = `${candidate.queryIndex}:${candidate.usedWords}`;
    const current = states.get(key);
    if (!current || stateScore(candidate) < stateScore(current)) states.set(key, candidate);
  }

  let states = new Map<string, PrefixState>([["0:0", { queryIndex: 0, firstWordIndex: -1, lastWordIndex: -1, usedWords: 0, indices: [] }]]);
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const nextStates = new Map(states);
    const word = words[wordIndex];
    const lowerWord = word.text.toLowerCase();
    for (const state of states.values()) {
      const maxLength = Math.min(lowerWord.length, query.length - state.queryIndex);
      for (let length = 1; length <= maxLength; length++) {
        if (lowerWord.slice(0, length) !== query.slice(state.queryIndex, state.queryIndex + length)) break;
        retainBest(nextStates, {
          queryIndex: state.queryIndex + length,
          firstWordIndex: state.usedWords === 0 ? wordIndex : state.firstWordIndex,
          lastWordIndex: wordIndex,
          usedWords: state.usedWords + 1,
          indices: [...state.indices, ...rangeIndices(word.start, length)],
        });
      }
    }
    states = nextStates;
  }

  return [...states.values()].filter((state) => state.queryIndex === query.length && state.usedWords >= 2).sort((a, b) => stateScore(a) - stateScore(b))[0]?.indices ?? null;
}

/** Match one quick-open field and return label-relative highlight indices. */
export function matchQuickOpenText(query: string, text: string): QuickOpenMatch | null {
  const lowerQuery = query.trim().toLowerCase();
  const lowerText = text.toLowerCase();
  if (!lowerQuery) return { kind: "exact", score: Infinity, indices: [] };

  if (lowerText === lowerQuery) {
    return { kind: "exact", score: 1, indices: rangeIndices(0, text.length) };
  }

  const words = identifierWords(text);
  const initials = words.map((word) => word.text[0]?.toLowerCase() ?? "").join("");
  if (words.length >= 2 && initials === lowerQuery) {
    return { kind: "initials", score: 100 + Math.min(words.length, 99), indices: words.map((word) => word.start) };
  }

  if (lowerText.startsWith(lowerQuery)) {
    return { kind: "prefix", score: 200 + Math.min(text.length - lowerQuery.length, 99), indices: rangeIndices(0, lowerQuery.length) };
  }

  // DataGrip-style pinyin-initials matching for Chinese identifiers, e.g. "总租金" via "zzj".
  // Only tried after literal matches fail, so a mixed Han+Latin name that literally prefix-matches
  // (e.g. "abc表" via "abc") keeps its better literal-prefix score instead of being intercepted here.
  const isPinyinQuery = PINYIN_QUERY_RE.test(lowerQuery) && containsHan(text);
  if (isPinyinQuery) {
    const pinyinLetters = pinyinFirstLetters(text);
    if (pinyinLetters === lowerQuery) {
      return { kind: "initials", score: 150 + Math.min(text.length, 99), indices: pinyinLetterPositions(text) };
    }
    if (pinyinLetters.startsWith(lowerQuery)) {
      return { kind: "prefix", score: 250 + Math.min(text.length - lowerQuery.length, 99), indices: pinyinLetterPositions(text).slice(0, lowerQuery.length) };
    }
  }

  const wordPrefixIndices = matchWordPrefixes(words, lowerQuery);
  if (wordPrefixIndices) {
    return { kind: "word-prefix", score: 300 + Math.min(text.length - lowerQuery.length, 99), indices: wordPrefixIndices };
  }

  const substringIndex = lowerText.indexOf(lowerQuery);
  if (substringIndex >= 0) {
    return { kind: "substring", score: 400 + Math.min(substringIndex, 99), indices: rangeIndices(substringIndex, lowerQuery.length) };
  }

  if (lowerQuery.length < 2) return null;
  const indices: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < lowerText.length && queryIndex < lowerQuery.length; index++) {
    if (lowerText[index] !== lowerQuery[queryIndex]) continue;
    indices.push(index);
    queryIndex++;
  }
  if (queryIndex === lowerQuery.length) {
    const span = indices[indices.length - 1] - indices[0] + 1;
    return { kind: "fuzzy", score: 500 + Math.min(span - lowerQuery.length, 99), indices };
  }

  // Non-contiguous pinyin-initials fallback, e.g. "zj" matching "总租金" (pinyin initials "zzj"),
  // matching the ordered-subsequence behavior every other pinyin call site in the app already has.
  if (isPinyinQuery) {
    const pinyinLetters = pinyinFirstLetters(text);
    const positions = pinyinLetterPositions(text);
    const letterIndices: number[] = [];
    let letterQueryIndex = 0;
    let letterCount = 0;
    // Iterate the initials by code point, keeping letterCount aligned with
    // positions: unmapped supplementary-plane Han characters occupy two code
    // units in pinyinLetters but still correspond to exactly one position.
    for (const letter of pinyinLetters) {
      if (letterQueryIndex >= lowerQuery.length) break;
      if (letter === lowerQuery[letterQueryIndex]) {
        letterIndices.push(positions[letterCount] ?? letterCount);
        letterQueryIndex += 1;
      }
      letterCount += 1;
    }
    if (letterQueryIndex === lowerQuery.length) {
      const pinyinSpan = letterIndices[letterIndices.length - 1] - letterIndices[0] + 1;
      return { kind: "fuzzy", score: 500 + Math.min(pinyinSpan - lowerQuery.length, 99), indices: letterIndices };
    }
  }

  return null;
}

interface MatchedItem extends QuickOpenItem {
  matchScore: number;
  matchIndices: number[];
}

function loadSavedSqlFileFolderPaths(): string[] {
  return getSqlFileFolderPaths();
}

function folderNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.pop() || path;
}

function collectSqlFileEntries(entries: SqlFileEntry[], results: SqlFileEntry[]): void {
  for (const entry of entries) {
    if (entry.is_dir) {
      collectSqlFileEntries(entry.children, results);
    } else {
      results.push(entry);
    }
  }
}

export function useQuickOpen(options: UseQuickOpenOptions = {}) {
  const connectionStore = useConnectionStore();
  const savedSqlStore = useSavedSqlStore();
  const extraItems = options.extraItems;
  const searchQuery = ref("");
  const selectedIndex = ref(0);
  const remoteItems = ref<QuickOpenItem[]>([]);
  const sqlFileItems = ref<QuickOpenItem[]>([]);
  let remoteSearchGeneration = 0;
  let remoteSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRemoteRequests = 0;
  const activeRemoteExecutionIds = new Set<string>();
  let activeRemoteStructureRequests = 0;
  const remoteRequestWaiters: Array<{ generation: number; resolve: (acquired: boolean) => void }> = [];
  const remoteStructureRequestWaiters: Array<{ generation: number; resolve: (acquired: boolean) => void }> = [];
  let sqlFilesLoaded = false;
  let sqlFilesLoadingPromise: Promise<void> | null = null;
  let sqlFilesLoadGeneration = 0;
  const pluginWorkbenchItems = ref<QuickOpenItem[]>([]);
  let pluginWorkbenchesLoading = false;
  const persistedMetadataItems = ref<QuickOpenItem[]>([]);
  let persistedMetadataDisposed = false;
  let persistedMetadataLoadPromise: Promise<void> | null = null;
  let persistedMetadataLoadGeneration = 0;
  let persistedMetadataConnectionSignature = "";
  const persistedMetadataWriteQueues = new Map<string, Promise<void>>();
  const persistedMetadataWriteSignatures = new Map<string, { generation: number; signature: string }>();

  function persistedQuickOpenItemKey(item: PersistedQuickOpenItem): string {
    if (item.type === "column") return JSON.stringify(["column", item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.tableName ?? "", item.columnName ?? item.label]);
    if (item.type === "table" || item.type === "view" || item.type === "materialized_view") return JSON.stringify(["relation", item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.tableName ?? item.objectName ?? item.label]);
    return JSON.stringify(["item", item.type, item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.objectName ?? item.label, item.signature ?? null]);
  }

  function persistedQuickOpenSnapshot(item: QuickOpenItem): PersistedQuickOpenItem | null {
    if (!item.connectionId || !isPersistedQuickOpenResultType(item.type)) return null;
    return {
      type: item.type as PersistedQuickOpenResultType,
      label: item.label,
      connectionId: item.connectionId,
      ...(item.database === undefined ? {} : { database: item.database }),
      ...(item.schema === undefined ? {} : { schema: item.schema }),
      ...(item.catalog === undefined ? {} : { catalog: item.catalog }),
      ...(item.tableName === undefined ? {} : { tableName: item.tableName }),
      ...(item.objectName === undefined ? {} : { objectName: item.objectName }),
      ...(item.columnName === undefined ? {} : { columnName: item.columnName }),
      ...(item.columnComment === undefined ? {} : { columnComment: item.columnComment }),
      ...(item.tableComment === undefined ? {} : { tableComment: item.tableComment }),
      ...(item.tableType === undefined ? {} : { tableType: item.tableType }),
      ...(item.signature === undefined ? {} : { signature: item.signature }),
    };
  }

  function cachedQuickOpenItem(item: PersistedQuickOpenItem, conn: ConnectionConfig): QuickOpenItem | null {
    if (item.connectionId !== conn.id) return null;
    const database = item.database;
    const schema = database ? connectionObjectTreeNodeSchema(conn, database, item.schema) : item.schema;
    const catalog = item.catalog;
    const location = [conn.name, catalog, database, schema].filter(Boolean).join(" / ");
    const objectName = item.objectName || item.tableName || item.label;
    const tableType = item.tableType || (item.type === "view" ? "VIEW" : item.type === "materialized_view" ? "MATERIALIZED_VIEW" : item.type === "table" || item.type === "column" ? "TABLE" : undefined);
    const description = item.type === "database" ? conn.name : item.type === "schema" ? [conn.name, catalog, database].filter(Boolean).join(" / ") : [location, item.type === "column" ? item.tableName : objectName].filter(Boolean).join(" / ");
    const searchText = [conn.name, catalog, database, schema, item.tableName, item.objectName, item.columnName, item.label, item.columnComment, item.tableComment, item.signature].filter(Boolean).join(" ");
    const id = JSON.stringify([item.type, conn.id, catalog ?? "", database ?? "", schema ?? "", item.tableName ?? item.objectName ?? "", item.columnName ?? null, item.signature ?? null]);
    return {
      id,
      type: item.type,
      label: item.label,
      description,
      connectionId: conn.id,
      ...(database === undefined ? {} : { database }),
      ...(schema === undefined ? {} : { schema }),
      ...(catalog === undefined ? {} : { catalog }),
      ...(item.type === "table" ? { tableName: item.tableName || item.label } : {}),
      ...(item.type === "view" || item.type === "materialized_view" ? { objectName: item.objectName || item.label } : {}),
      ...(item.type === "column" ? { tableName: item.tableName, columnName: item.columnName || item.label, columnComment: item.columnComment } : {}),
      ...(item.type === "procedure" || item.type === "function" || item.type === "sequence" || item.type === "package" || item.type === "package-body" ? { objectName: item.objectName || item.label, signature: item.signature } : {}),
      ...(item.tableComment === undefined ? {} : { tableComment: item.tableComment }),
      ...(tableType === undefined ? {} : { tableType }),
      connectionName: conn.name,
      schemaNamespace: databaseIsSearchSchema(conn) && database ? database : undefined,
      searchText,
      source: "cache",
    };
  }

  function cachedTableType(tableType: string): "table" | "view" | "materialized_view" {
    const normalized = tableType.toUpperCase().replaceAll(" ", "_");
    if (normalized === "MATERIALIZED_VIEW") return "materialized_view";
    if (normalized === "VIEW") return "view";
    return "table";
  }

  interface RecentQuickOpenEntry {
    id: string;
    item: QuickOpenItem;
    lastOpenedAt: number;
  }

  function loadRecentQuickOpenEntries(): RecentQuickOpenEntry[] {
    try {
      const stored = localStorage.getItem(RECENT_QUICK_OPEN_STORAGE_KEY);
      if (!stored) return [];
      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      const now = Date.now();
      return parsed
        .flatMap((entry): RecentQuickOpenEntry[] => {
          if (!entry || typeof entry !== "object") return [];
          const candidate = entry as Partial<RecentQuickOpenEntry>;
          if (typeof candidate.id !== "string" || !candidate.item || typeof candidate.item !== "object" || typeof candidate.item.id !== "string" || typeof candidate.item.label !== "string") return [];
          const lastOpenedAt = typeof candidate.lastOpenedAt === "number" ? candidate.lastOpenedAt : now;
          return now - lastOpenedAt > RECENT_QUICK_OPEN_MAX_AGE_MS ? [] : [{ id: candidate.id, item: recentItemSnapshot(candidate.item), lastOpenedAt }];
        })
        .slice(0, RECENT_QUICK_OPEN_LIMIT);
    } catch {
      return [];
    }
  }

  const recentQuickOpenEntries = ref<RecentQuickOpenEntry[]>(loadRecentQuickOpenEntries());

  function recentItemSnapshot(item: QuickOpenItem): QuickOpenItem {
    if (item.type === "content_match" && item.filePath) {
      return {
        id: `recent-file-${item.filePath}`,
        type: "sql_file",
        label: item.fileName || item.label,
        description: item.filePath,
        connectionId: "",
        filePath: item.filePath,
        searchText: `${item.fileName || item.label} ${item.filePath}`,
        source: "file",
      };
    }
    // History stores a target, not the modifier action used to open it.
    // Apply this on both load and save to normalize previously persisted entries.
    const snapshot = { ...item };
    delete snapshot.searchScope;
    return snapshot;
  }

  function recordRecentItem(item: QuickOpenItem): void {
    const snapshot = recentItemSnapshot(item);
    recentQuickOpenEntries.value = [{ id: snapshot.id, item: snapshot, lastOpenedAt: Date.now() }, ...recentQuickOpenEntries.value.filter((entry) => entry.id !== snapshot.id)].slice(0, RECENT_QUICK_OPEN_LIMIT);
    try {
      localStorage.setItem(RECENT_QUICK_OPEN_STORAGE_KEY, JSON.stringify(recentQuickOpenEntries.value));
    } catch {
      // Recent history is a convenience; restricted storage must not affect search.
    }
  }

  // --- Content search mode (global search of local SQL/text file contents) ---
  const contentMode = ref(false);
  const contentSearching = ref(false);
  const contentSearchError = ref<string | null>(null);
  const contentItems = ref<MatchedItem[]>([]);
  let contentSearchGeneration = 0;
  let contentSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let activeContentSearchId: string | undefined;

  function cancelActiveContentSearch(): void {
    const searchId = activeContentSearchId;
    activeContentSearchId = undefined;
    if (searchId && typeof api.cancelGlobalSearch === "function") {
      void api.cancelGlobalSearch(searchId).catch(() => undefined);
    }
  }

  interface ContentGroup {
    header: string;
    filePath: string;
    matches: MatchedItem[];
  }

  const contentGroups = computed<ContentGroup[]>(() => {
    const groups: ContentGroup[] = [];
    const indexByPath = new Map<string, ContentGroup>();
    for (const item of contentItems.value) {
      const path = item.filePath;
      if (!path) continue;
      let group = indexByPath.get(path);
      if (!group) {
        group = { header: item.fileName || item.label, filePath: path, matches: [] };
        indexByPath.set(path, group);
        groups.push(group);
      }
      group.matches.push(item);
    }
    for (const group of groups) {
      group.matches.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    }
    return groups;
  });

  const selectableContentItems = computed<MatchedItem[]>(() => contentGroups.value.flatMap((group) => group.matches));

  function clearContentResults(): void {
    contentItems.value = [];
    contentSearching.value = false;
    contentSearchError.value = null;
  }

  async function runContentSearch(query: string, generation: number): Promise<void> {
    if (generation !== contentSearchGeneration || !contentMode.value || options.enabled?.value === false) return;
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchTimer = undefined;
    cancelActiveContentSearch();
    const searchId = `quick-open-${Date.now()}-${generation}`;
    activeContentSearchId = searchId;
    const roots = composeGlobalSearchRoots();
    if (roots.length === 0) {
      if (activeContentSearchId === searchId) activeContentSearchId = undefined;
      if (generation === contentSearchGeneration) clearContentResults();
      return;
    }
    contentSearchError.value = null;
    contentSearching.value = true;
    try {
      const response = await api.globalSearch({
        roots,
        query,
        extensions: getGlobalSearchExtensions(),
        limit: CONTENT_SEARCH_MAX_RESULTS,
        searchId,
      });
      if (generation !== contentSearchGeneration) return;
      // Accept the legacy array shape from older desktop binaries while the
      // current backend returns partial matches together with scan errors.
      const matches = Array.isArray(response) ? response : response.matches;
      const scanErrors = Array.isArray(response) ? [] : response.errors;
      contentSearchError.value = scanErrors.length > 0 ? scanErrors.map((error) => `${error.path}: ${error.message}`).join("\n") : null;
      contentItems.value = matches.map((match) => {
        const isFileName = match.line === 0;
        const highlightStart = isFileName ? utf16OffsetForUnicodeColumn(match.fileName, match.column) : utf16OffsetForUnicodeColumn(match.lineText, match.column);
        const highlightIndices: [number, number] = [highlightStart, highlightStart + match.matchText.length];
        return {
          id: `content-${match.path}-${match.line}-${match.column}`,
          type: "content_match" as const,
          label: match.fileName,
          description: match.fileName,
          connectionId: "",
          filePath: match.path,
          fileName: match.fileName,
          line: match.line,
          column: match.column,
          matchText: match.matchText,
          lineText: isFileName ? match.fileName : match.lineText,
          highlightIndices,
          searchText: match.lineText,
          matchScore: 0,
          matchIndices: [],
        };
      });
    } catch (error) {
      if (generation === contentSearchGeneration) {
        contentItems.value = [];
        contentSearchError.value = translateBackendError(i18n.global.t, error);
      }
    } finally {
      if (generation === contentSearchGeneration) contentSearching.value = false;
      if (activeContentSearchId === searchId) activeContentSearchId = undefined;
    }
  }

  function setContentMode(enabled: boolean): void {
    if (contentMode.value === enabled) return;
    contentMode.value = enabled;
    selectedIndex.value = 0;
    if (!enabled) {
      contentSearchGeneration += 1;
      cancelActiveContentSearch();
      if (contentSearchTimer) clearTimeout(contentSearchTimer);
      contentSearchTimer = undefined;
      clearContentResults();
      return;
    }
    if (enabled) {
      const query = searchQuery.value.trim();
      if (query) {
        const generation = ++contentSearchGeneration;
        void runContentSearch(query, generation);
      } else {
        clearContentResults();
      }
    }
  }

  function retryContentSearch(): void {
    if (!contentMode.value) return;
    const query = searchQuery.value.trim();
    if (!query) {
      clearContentResults();
      return;
    }
    selectedIndex.value = 0;
    contentSearchError.value = null;
    contentSearchGeneration += 1;
    const generation = contentSearchGeneration;
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchTimer = undefined;
    void runContentSearch(query, generation);
  }

  function getConnectionLabel(connectionId: string): string {
    if (!connectionId) return i18n.global.t("sqlLibrary.unassociated");
    const conn = connectionStore.connections.find((c) => c.id === connectionId);
    return conn?.name || i18n.global.t("sqlLibrary.deletedConnection");
  }

  const sqlLibraryAllItems = computed<QuickOpenItem[]>(() => {
    // Files bound to a connection outside the scope are hidden with it; unbound files stay visible.
    return savedSqlStore.allFiles
      .filter((file) => !file.connectionId || quickOpenScopeIncludes(file.connectionId))
      .map((file) => ({
        id: `sqllib-${file.id}`,
        type: "sql_library_file" as const,
        label: file.name,
        description: getConnectionLabel(file.connectionId),
        connectionId: file.connectionId,
        connectionName: getConnectionLabel(file.connectionId),
        sqlFileId: file.id,
        searchText: `${file.name} ${getConnectionLabel(file.connectionId)}`,
      }));
  });

  const sqlLibraryRecentItems = computed<QuickOpenItem[]>(() => {
    return [...sqlLibraryAllItems.value]
      .sort((a, b) => {
        const fileA = savedSqlStore.getFile(a.sqlFileId!);
        const fileB = savedSqlStore.getFile(b.sqlFileId!);
        const timeA = fileA?.openedAt || fileA?.updatedAt || "";
        const timeB = fileB?.openedAt || fileB?.updatedAt || "";
        return timeB.localeCompare(timeA);
      })
      .slice(0, INITIAL_SQL_LIBRARY_LIMIT);
  });

  async function loadExternalSqlFiles(): Promise<void> {
    if (sqlFilesLoaded || sqlFilesLoadingPromise) return sqlFilesLoadingPromise ?? undefined;
    const generation = sqlFilesLoadGeneration;
    const loadingPromise = (async () => {
      try {
        const folderPaths = loadSavedSqlFileFolderPaths();
        if (folderPaths.length === 0) {
          if (generation === sqlFilesLoadGeneration) sqlFilesLoaded = true;
          return;
        }
        const allEntries: Array<{ entry: SqlFileEntry; rootFolder: string }> = [];
        for (const folderPath of folderPaths) {
          try {
            const entries = await api.listSqlFilesInFolder(folderPath, getSqlFileFilter());
            const collected: SqlFileEntry[] = [];
            collectSqlFileEntries(entries, collected);
            const rootName = folderNameFromPath(folderPath);
            for (const entry of collected) {
              allEntries.push({ entry, rootFolder: rootName });
            }
          } catch {
            // Skip folders that fail to load
          }
        }
        // Folder changes invalidate this snapshot; an updated scan runs after cleanup below.
        if (generation !== sqlFilesLoadGeneration) return;
        sqlFileItems.value = allEntries.map(({ entry, rootFolder }) => {
          const parentDir = entry.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
          const parentName = folderNameFromPath(parentDir || entry.path);
          // Show the top-level folder name so users can distinguish files from different directories
          const description = parentName === rootFolder ? rootFolder : `${rootFolder} / ${parentName}`;
          return {
            id: `sqlfile-${entry.path}`,
            type: "sql_file" as const,
            label: entry.name,
            description,
            connectionId: "",
            filePath: entry.path,
            fileModifiedAt: entry.modified_at,
            searchText: `${entry.name} ${rootFolder} ${parentName}`,
          };
        });
        sqlFilesLoaded = true;
      } catch {
        // ignore errors
      }
    })();
    sqlFilesLoadingPromise = loadingPromise;
    try {
      await loadingPromise;
    } finally {
      if (sqlFilesLoadingPromise === loadingPromise) sqlFilesLoadingPromise = null;
    }
    if (generation !== sqlFilesLoadGeneration) await loadExternalSqlFiles();
  }

  /**
   * Limited set of external SQL files for the initial (no-query) view.
   * Shows files from all configured folders, capped to INITIAL_SQL_FILE_LIMIT.
   */
  const sqlFileRecentItems = computed<QuickOpenItem[]>(() => {
    const recentOrder = new Map(recentQuickOpenEntries.value.filter((entry) => entry.item.type === "sql_file" && entry.item.filePath).map((entry, index) => [entry.item.filePath!, index]));
    return [...sqlFileItems.value]
      .sort((left, right) => {
        const leftOrder = left.filePath ? recentOrder.get(left.filePath) : undefined;
        const rightOrder = right.filePath ? recentOrder.get(right.filePath) : undefined;
        if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
        const leftModifiedAt = left.fileModifiedAt ?? 0;
        const rightModifiedAt = right.fileModifiedAt ?? 0;
        if (leftModifiedAt !== rightModifiedAt) return rightModifiedAt - leftModifiedAt;
        return (left.filePath || left.label).localeCompare(right.filePath || right.label);
      })
      .slice(0, INITIAL_SQL_FILE_LIMIT);
  });

  /**
   * Refresh quick-open entries for plugin workbenches that no connection
   * provider claims. A workbench bound via a provider's `workbench` pointer is
   * opened through its connection (which quick open already lists as a
   * connection item with full context), so listing it here would only offer a
   * contextless dead end. Unclaimed workbenches otherwise have no entry point
   * outside the Plugin Center's Installed tab.
   * Re-runs on every dialog open so installs/uninstalls show up without a restart.
   */
  async function loadPluginWorkbenches(): Promise<void> {
    if (pluginWorkbenchesLoading) return;
    pluginWorkbenchesLoading = true;
    try {
      const registry = createFrontendPluginRegistry(await api.listPlugins(), currentLocale());
      const connectionBound = new Set(
        registry
          .listConnectionProviders()
          .filter((entry) => entry.contribution.workbench)
          .map((entry) => `${entry.plugin.manifest.id}/${entry.contribution.workbench}`),
      );
      pluginWorkbenchItems.value = registry
        .listWorkbenches()
        .filter((entry) => !connectionBound.has(`${entry.plugin.manifest.id}/${entry.contribution.id}`))
        .map((entry) => ({
          id: `pluginwb-${entry.plugin.manifest.id}-${entry.contribution.id}`,
          type: "plugin_workbench" as const,
          label: entry.contribution.label,
          description: entry.plugin.manifest.name,
          connectionId: "",
          pluginId: entry.plugin.manifest.id,
          contributionId: entry.contribution.id,
          pluginIcon: entry.contribution.icon || entry.plugin.manifest.icon,
          searchText: `${entry.plugin.manifest.name} ${entry.contribution.label} ${entry.contribution.id}`,
        }));
    } catch {
      // Plugin listings are best-effort; quick open keeps working without them.
    } finally {
      pluginWorkbenchesLoading = false;
    }
  }

  const allItems = computed((): QuickOpenItem[] => {
    const items: QuickOpenItem[] = [];
    // A narrowed scope hides unselected connections and everything beneath them,
    // keeping local tree entries in sync with the remote search pool.
    const connections = connectionStore.connections.filter((conn) => quickOpenScopeIncludes(conn.id));
    const treeNodes = connectionStore.treeNodes;

    // Add connections
    for (const conn of connections) {
      items.push({
        id: `conn-${conn.id}`,
        type: "connection",
        label: conn.name,
        connectionId: conn.id,
        connectionName: conn.name,
        searchText: `${conn.name}`,
      });
    }

    // Standalone plugin workbenches sit right after connections so they stay
    // reachable in the no-query list before the (much longer) tree items.
    items.push(...pluginWorkbenchItems.value);

    // Add databases and tables from tree nodes
    // Filter tree nodes by connection
    for (const conn of connections) {
      // Connections may live under sidebar groups, so locate their tree recursively.
      const connectionTreeNode = findConnectionTreeNode(treeNodes, conn.id);
      const connectionTreeNodes = connectionTreeNode?.children || treeNodes.filter((node) => node.connectionId === conn.id);
      if (connectionTreeNodes.length === 0) continue;

      // Process tree nodes to extract databases and tables
      processDatabaseTreeNodes(connectionTreeNodes, conn, items);
    }

    return items;
  });

  const searchableMetadataItems = computed<QuickOpenItem[]>(() => {
    const seen = new Set<string>();
    const scopedPersistedMetadataItems = persistedMetadataItems.value.filter((item) => !item.connectionId || quickOpenScopeIncludes(item.connectionId));
    return [...allItems.value, ...scopedPersistedMetadataItems].filter((item) => {
      const key = quickOpenItemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  // Update the index from reactive snapshots while reusing unchanged entries.
  // Query keystrokes only read this index; source updates rebuild changed keys.
  let previousQuickSearchIndex: QuickSearchIndex<QuickOpenItem> | undefined;
  const quickSearchIndex = computed(() => {
    const results = [...searchableMetadataItems.value, ...sqlLibraryAllItems.value, ...sqlFileItems.value, ...remoteItems.value, ...(extraItems?.value ?? [])];
    previousQuickSearchIndex = updateQuickSearchIndex(previousQuickSearchIndex, results);
    return previousQuickSearchIndex;
  });

  function processDatabaseTreeNodes(nodes: any[], conn: ConnectionConfig, results: QuickOpenItem[], ownerType?: string, ownerCatalog?: string): void {
    for (const node of nodes) {
      const catalog = node.type === "doris-catalog" && isInternalDorisCatalog(node.catalogType, node.catalog) ? undefined : (node.catalog ?? ownerCatalog);
      const items = {
        push(item: QuickOpenItem) {
          const schema = item.database ? connectionObjectTreeNodeSchema(conn, item.database, item.schema) : item.schema;
          results.push({
            ...item,
            catalog,
            schema,
            schemaNamespace: databaseIsSearchSchema(conn) ? item.database : undefined,
            id: JSON.stringify([item.type, conn.id, catalog ?? "", item.database ?? "", schema ?? "", item.tableName ?? item.objectName ?? "", item.columnName ?? null, item.signature ?? null]),
            description: catalog ? `${catalog} / ${item.description || ""}` : item.description,
            searchText: catalog ? `${catalog} ${item.searchText}` : item.searchText,
          });
        },
      };
      // Column nodes (including persisted nodes) do not carry the owner's type.
      // Keep it across metadata groups, resetting at database/schema boundaries.
      const inheritedType = node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : node.type === "table" ? "TABLE" : node.type === "database" || node.type === "schema" ? undefined : ownerType;
      // Skip certain node types
      if (node.type === "group" || node.type === "linked-server-root") {
        if (node.children) {
          processDatabaseTreeNodes(node.children, conn, results, inheritedType, catalog);
        }
        continue;
      }

      // Database nodes
      if (node.type === "database" && node.database) {
        items.push({
          id: `db-${conn.id}-${node.database}`,
          type: "database",
          label: node.label || node.database,
          description: conn.name,
          connectionId: conn.id,
          database: node.database,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database}`,
        });
      }

      // Schema nodes are navigable results and also contain database objects.
      if (node.type === "schema" && node.database && node.schema) {
        items.push({
          id: `schema-${conn.id}-${node.database}-${node.schema}`,
          type: "schema",
          label: node.label || node.schema,
          description: `${conn.name} / ${node.database}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema}`,
        });
        if (node.children) processDatabaseTreeNodes(node.children, conn, results, inheritedType, catalog);
        continue;
      }

      // Table nodes
      if (node.type === "table" && node.database && node.label) {
        items.push({
          id: `table-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "table",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          tableName: node.label,
          tableType: "TABLE",
          tableComment: node.comment || undefined,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label} ${node.comment || ""}`,
        });
      }

      // Cached column nodes are searchable immediately and retain enough context
      // to jump directly to the owning table structure.
      if (node.type === "column" && node.database && node.tableName) {
        const meta = node.meta as { name?: string; data_type?: string; comment?: string | null } | undefined;
        const columnName = meta?.name || node.objectName || String(node.label || "").split(" (")[0];
        if (columnName) {
          const comment = meta?.comment || undefined;
          items.push({
            id: `column-${conn.id}-${node.database}-${node.schema || ""}-${node.tableName}-${columnName}`,
            type: "column",
            label: columnName,
            description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""} / ${node.tableName}${meta?.data_type ? ` · ${meta.data_type}` : ""}${comment ? ` · ${comment}` : ""}`,
            connectionId: conn.id,
            database: node.database,
            schema: node.schema,
            tableName: node.tableName,
            columnName,
            columnComment: comment,
            tableType: node.tableType || inheritedType || "TABLE",
            connectionName: conn.name,
            searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.tableName} ${columnName} ${comment || ""}`,
          });
        }
      }

      // View nodes
      if (node.type === "view" && node.database && node.label) {
        items.push({
          id: `view-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "view",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          tableType: "VIEW",
          tableComment: node.comment || undefined,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label} ${node.comment || ""}`,
        });
      }

      // Materialized view nodes
      if (node.type === "materialized_view" && node.database && node.label) {
        items.push({
          id: `mview-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "materialized_view",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          tableType: "MATERIALIZED_VIEW",
          tableComment: node.comment || undefined,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label} ${node.comment || ""}`,
        });
      }

      // Procedure nodes
      if (node.type === "procedure" && node.database && node.label) {
        items.push({
          id: `proc-${conn.id}-${node.database}-${node.schema || ""}-${routineIdentity(node)}`,
          type: "procedure",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          signature: node.signature,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${routineIdentity(node)}`,
        });
      }

      // Function nodes
      if (node.type === "function" && node.database && node.label) {
        items.push({
          id: `func-${conn.id}-${node.database}-${node.schema || ""}-${routineIdentity(node)}`,
          type: "function",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          signature: node.signature,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${routineIdentity(node)}`,
        });
      }

      // Sequence nodes
      if (node.type === "sequence" && node.database && node.label) {
        items.push({
          id: `seq-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "sequence",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Package nodes
      if (node.type === "package" && node.database && node.label) {
        items.push({
          id: `pkg-${conn.id}-${node.database}-${node.schema || ""}-${routineIdentity(node)}`,
          type: "package",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          signature: node.signature,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${routineIdentity(node)}`,
        });
      }

      // Package-body nodes
      if (node.type === "package-body" && node.database && node.label) {
        items.push({
          id: `pkgbody-${conn.id}-${node.database}-${node.schema || ""}-${routineIdentity(node)}`,
          type: "package-body",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          signature: node.signature,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${routineIdentity(node)}`,
        });
      }

      // Process children recursively
      if (node.children) {
        processDatabaseTreeNodes(node.children, conn, results, inheritedType, catalog);
      }
    }
  }

  const liveMetadataItemsForPersistence = computed<QuickOpenItem[]>(() => {
    const items: QuickOpenItem[] = [];
    for (const conn of connectionStore.connections) {
      const connectionTreeNode = findConnectionTreeNode(connectionStore.treeNodes, conn.id);
      const connectionTreeNodes = connectionTreeNode?.children || connectionStore.treeNodes.filter((node) => node.connectionId === conn.id);
      if (connectionTreeNodes.length > 0) processDatabaseTreeNodes(connectionTreeNodes, conn, items);
    }
    return items;
  });

  function findConnectionTreeNode(nodes: any[], connectionId: string): any | undefined {
    for (const node of nodes) {
      if (node.type === "connection" && node.connectionId === connectionId) return node;
      if (node.children) {
        const match = findConnectionTreeNode(node.children, connectionId);
        if (match) return match;
      }
    }
    return undefined;
  }

  function quickOpenItemKey(item: QuickOpenItem): string {
    if (item.type === "sql_file" && item.filePath) return JSON.stringify(["file", item.filePath]);
    if (item.type === "column") {
      return JSON.stringify(["column", item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.tableName ?? "", item.columnName ?? item.label]);
    }
    if (item.type === "table" || item.type === "view" || item.type === "materialized_view") {
      return JSON.stringify(["relation", item.connectionId, item.catalog ?? "", item.database ?? "", item.schema ?? "", item.tableName ?? item.objectName ?? item.label]);
    }
    return JSON.stringify(["item", item.id]);
  }

  function routineIdentity(node: { label: string; signature?: string }): string {
    return `${node.label}${node.signature ? `(${node.signature})` : ""}`;
  }

  function databaseIsSearchSchema(conn: ConnectionConfig): boolean {
    return connectionIsDorisFamilyCatalogCapable(conn) || ["mysql", "sqlite", "manticoresearch", "goldendb", "clickhouse", "tdengine"].includes(effectiveDatabaseTypeForConnection(conn) || "");
  }

  function persistedMetadataConnectionSignatureFor(connections: readonly ConnectionConfig[]): string {
    return connections
      .map((conn) => `${conn.id}:${quickOpenMetadataConnectionFingerprint(conn)}`)
      .sort()
      .join("\n");
  }

  function mergePersistedMetadataItems(items: readonly QuickOpenItem[]): QuickOpenItem[] {
    const merged = new Map<string, QuickOpenItem>();
    for (const item of items) {
      const key = quickOpenItemKey(item);
      if (!merged.has(key)) merged.set(key, item);
    }
    return [...merged.values()];
  }

  async function waitForPersistedMetadataWrites(): Promise<void> {
    const pendingWrites = [...persistedMetadataWriteQueues.values()];
    if (pendingWrites.length > 0) await Promise.allSettled(pendingWrites);
  }

  async function loadPersistedQuickOpenMetadata(): Promise<void> {
    if (persistedMetadataDisposed) return;
    const configs = [...connectionStore.connections];
    const signature = persistedMetadataConnectionSignatureFor(configs);
    if (persistedMetadataConnectionSignature === signature && !persistedMetadataLoadPromise) return;
    if (persistedMetadataLoadPromise) return persistedMetadataLoadPromise;
    const generation = ++persistedMetadataLoadGeneration;
    const loading = (async () => {
      await waitForPersistedMetadataWrites();
      if (persistedMetadataDisposed || generation !== persistedMetadataLoadGeneration) return;
      const configById = new Map(configs.map((conn) => [conn.id, conn]));
      const loadedItems: QuickOpenItem[] = [];
      const tableScopes = typeof connectionStore.loadSidebarTableSearchIndexScopes === "function" ? await connectionStore.loadSidebarTableSearchIndexScopes((scope) => configById.has(scope.connectionId)).catch(() => []) : [];

      // A complete sidebar table index is the best available offline source for
      // tables and views. Stale entries are retained as last-known metadata;
      // opening the result still revalidates the live object. It is intentionally
      // read without ensureConnected().
      for (const { scope, entries } of tableScopes) {
        const conn = configById.get(scope.connectionId);
        if (!conn) continue;
        const database = scope.database;
        const databaseItem = cachedQuickOpenItem({ type: "database", label: database, connectionId: conn.id, database, catalog: scope.catalog }, conn);
        if (databaseItem) loadedItems.push(databaseItem);
        if (scope.schema) {
          const schemaItem = cachedQuickOpenItem({ type: "schema", label: scope.schema, connectionId: conn.id, database, schema: scope.schema, catalog: scope.catalog }, conn);
          if (schemaItem) loadedItems.push(schemaItem);
        }
        for (const entry of entries) {
          const type = cachedTableType(entry.table_type);
          const item = cachedQuickOpenItem(
            {
              type,
              label: entry.name,
              connectionId: conn.id,
              database,
              schema: scope.schema,
              catalog: scope.catalog,
              ...(type === "table" ? { tableName: entry.name } : { objectName: entry.name }),
              tableType: entry.table_type,
              ...(entry.comment == null ? {} : { tableComment: entry.comment }),
            },
            conn,
          );
          if (item) loadedItems.push(item);
        }
      }

      const loadSchemaCache = optionalQuickOpenCacheApiMethod("loadSchemaCache");
      if (loadSchemaCache) {
        await Promise.all(
          configs.map(async (conn) => {
            try {
              const decoded = decodeQuickOpenMetadataCache(await loadSchemaCache(quickOpenMetadataCacheKey(conn.id)));
              if (!decoded || decoded.connectionId !== conn.id || decoded.connectionFingerprint !== quickOpenMetadataConnectionFingerprint(conn)) return;
              for (const item of decoded.items) {
                const cached = cachedQuickOpenItem(item, conn);
                if (cached) loadedItems.push(cached);
              }
            } catch {
              // A missing or unreadable offline cache must not affect Quick Open.
            }
          }),
        );
      }

      if (persistedMetadataDisposed || generation !== persistedMetadataLoadGeneration || persistedMetadataConnectionSignatureFor([...connectionStore.connections]) !== signature) return;
      persistedMetadataItems.value = mergePersistedMetadataItems(loadedItems);
      persistedMetadataConnectionSignature = signature;
    })();
    persistedMetadataLoadPromise = loading;
    try {
      await loading;
    } finally {
      if (persistedMetadataLoadPromise === loading) persistedMetadataLoadPromise = null;
      const currentSignature = persistedMetadataConnectionSignatureFor([...connectionStore.connections]);
      if (!persistedMetadataDisposed && currentSignature !== signature && options.enabled?.value !== false) void loadPersistedQuickOpenMetadata();
    }
  }

  async function persistLiveQuickOpenMetadata(items: readonly QuickOpenItem[]): Promise<void> {
    if (persistedMetadataDisposed) return;
    const saveSchemaCache = optionalQuickOpenCacheApiMethod("saveSchemaCache");
    if (!saveSchemaCache) return;
    const deleteSchemaCachePrefix = optionalQuickOpenCacheApiMethod("deleteSchemaCachePrefix");
    const byConnection = new Map<string, QuickOpenItem[]>();
    for (const item of items) {
      if (!item.connectionId || !isPersistedQuickOpenResultType(item.type)) continue;
      const connectionItems = byConnection.get(item.connectionId) ?? [];
      connectionItems.push(item);
      byConnection.set(item.connectionId, connectionItems);
    }
    if (byConnection.size === 0) return;
    await loadPersistedQuickOpenMetadata();
    if (persistedMetadataDisposed) return;
    await Promise.all(
      [...byConnection.entries()].map(async ([connectionId, liveItems]) => {
        const conn = typeof connectionStore.getConfig === "function" ? connectionStore.getConfig(connectionId) : connectionStore.connections.find((candidate) => candidate.id === connectionId);
        if (!conn) return;
        const connectionFingerprint = quickOpenMetadataConnectionFingerprint(conn);
        const cacheGeneration = quickOpenMetadataCacheGeneration(connectionId);
        const snapshots = liveItems.flatMap((item) => {
          const snapshot = persistedQuickOpenSnapshot(item);
          return snapshot ? [snapshot] : [];
        });
        if (snapshots.length === 0) return;
        const mergedByKey = new Map<string, PersistedQuickOpenItem>();
        for (const item of persistedMetadataItems.value) {
          if (item.connectionId !== connectionId) continue;
          const snapshot = persistedQuickOpenSnapshot(item);
          if (snapshot) mergedByKey.set(persistedQuickOpenItemKey(snapshot), snapshot);
        }
        for (const snapshot of snapshots) mergedByKey.set(persistedQuickOpenItemKey(snapshot), snapshot);
        const merged = [...mergedByKey.values()];
        const writeSignature = JSON.stringify({ connectionFingerprint, items: merged });
        const cacheKey = quickOpenMetadataCacheKey(connectionId);
        const previousWrite = persistedMetadataWriteSignatures.get(cacheKey);
        if (previousWrite?.generation === cacheGeneration && previousWrite.signature === writeSignature) return;
        const previous = persistedMetadataWriteQueues.get(cacheKey) ?? Promise.resolve();
        const pending = previous
          .catch(() => undefined)
          .then(async () => {
            if (persistedMetadataDisposed || quickOpenMetadataCacheGeneration(connectionId) !== cacheGeneration) return;
            const current = typeof connectionStore.getConfig === "function" ? connectionStore.getConfig(connectionId) : connectionStore.connections.find((candidate) => candidate.id === connectionId);
            if (!current || quickOpenMetadataConnectionFingerprint(current) !== connectionFingerprint) return;
            await saveSchemaCache(cacheKey, encodeQuickOpenMetadataCache(connectionId, connectionFingerprint, merged));
            if (quickOpenMetadataCacheGeneration(connectionId) !== cacheGeneration) {
              if (deleteSchemaCachePrefix) await deleteSchemaCachePrefix(cacheKey).catch(() => undefined);
              return;
            }
            if (persistedMetadataDisposed) return;
            const latest = typeof connectionStore.getConfig === "function" ? connectionStore.getConfig(connectionId) : connectionStore.connections.find((candidate) => candidate.id === connectionId);
            if (!latest || quickOpenMetadataConnectionFingerprint(latest) !== connectionFingerprint) return;
            persistedMetadataWriteSignatures.set(cacheKey, { generation: cacheGeneration, signature: writeSignature });
            const cachedItems = merged.flatMap((item) => {
              const cached = cachedQuickOpenItem(item, latest);
              return cached ? [cached] : [];
            });
            persistedMetadataItems.value = mergePersistedMetadataItems([...persistedMetadataItems.value.filter((item) => item.connectionId !== connectionId), ...cachedItems]);
          });
        persistedMetadataWriteQueues.set(cacheKey, pending);
        try {
          await pending;
        } catch {
          // Persistence is best-effort; live tree results remain available.
        } finally {
          if (persistedMetadataWriteQueues.get(cacheKey) === pending) persistedMetadataWriteQueues.delete(cacheKey);
        }
      }),
    );
  }

  function watchPersistedQuickOpenMetadata(): void {
    watch(
      liveMetadataItemsForPersistence,
      (items) => {
        void persistLiveQuickOpenMetadata(items);
      },
      { flush: "post", immediate: true },
    );
    watch(
      () => options.enabled?.value ?? true,
      (enabled) => {
        if (enabled) void loadPersistedQuickOpenMetadata();
      },
      { immediate: true },
    );
    watch(
      () => connectionStore.connections.map((conn) => `${conn.id}:${quickOpenMetadataConnectionFingerprint(conn)}`).join("\n"),
      () => {
        persistedMetadataLoadGeneration += 1;
        persistedMetadataConnectionSignature = "";
        // Do not expose a snapshot from an old endpoint while the new
        // connection configuration is being loaded and fingerprint-checked.
        persistedMetadataItems.value = [];
        if (options.enabled?.value !== false) void loadPersistedQuickOpenMetadata();
        pruneQuickOpenScope(connectionStore.connections.map((conn) => conn.id));
      },
      { flush: "post" },
    );
  }

  watchPersistedQuickOpenMetadata();

  function remoteTableItem(table: SqlCompletionTable, conn: ConnectionConfig, database: string, contextCatalog?: string): QuickOpenItem {
    const catalog = table.catalog ?? contextCatalog;
    database = table.database ?? database;
    const schema = connectionObjectTreeNodeSchema(conn, database, table.schema);
    // Completion "tables" may carry routine navigation types; quick-open relation entries only accept relation kinds.
    const type = table.type === "view" || table.type === "materialized_view" ? table.type : "table";
    const prefix = type === "materialized_view" ? "mview" : type;
    return {
      id: JSON.stringify([prefix, conn.id, catalog ?? "", database, schema ?? "", table.name]),
      type,
      label: table.name,
      description: `${conn.name}${catalog ? ` / ${catalog}` : ""} / ${database}${schema ? " / " + schema : ""}`,
      connectionId: conn.id,
      database,
      catalog,
      schema,
      schemaNamespace: databaseIsSearchSchema(conn) ? database : undefined,
      ...(type === "table" ? { tableName: table.name } : { objectName: table.name }),
      tableType: type === "view" ? "VIEW" : type === "materialized_view" ? "MATERIALIZED_VIEW" : "TABLE",
      connectionName: conn.name,
      searchText: `${conn.name} ${catalog || ""} ${database} ${table.schema || ""} ${table.name}`,
      source: "remote",
    };
  }

  function collectConnectionDatabases(nodes: any[], connectionId: string, databases: Map<string, { database: string; catalog?: string }>, ownerCatalog?: string): void {
    for (const node of nodes) {
      const catalog = node.type === "doris-catalog" && isInternalDorisCatalog(node.catalogType, node.catalog) ? undefined : (node.catalog ?? ownerCatalog);
      if (node.connectionId === connectionId && node.type === "database" && node.database) databases.set(JSON.stringify([catalog ?? "", node.database]), { database: node.database, catalog });
      if (node.children) collectConnectionDatabases(node.children, connectionId, databases, catalog);
    }
  }

  type RemoteSearchContext = { conn: ConnectionConfig; database: string; catalog?: string; schema?: string };

  function remoteSearchContexts(query: QuickSearchQuery): RemoteSearchContext[] {
    if (typeof connectionStore.listCompletionTables !== "function") return [];
    if (!connectionStore.connectedIds || typeof connectionStore.connectedIds.has !== "function") return [];

    const databasesByConnection: Array<{ conn: ConnectionConfig; databases: Array<{ database: string; catalog?: string }> }> = [];
    const orderedConnections = [...connectionStore.connections].sort((left, right) => {
      const priority = (conn: ConnectionConfig) => {
        if (conn.id === connectionStore.activeConnectionId) return 0;
        if (connectionStore.connectedIds.has(conn.id)) return 1;
        return 2;
      };
      return priority(left) - priority(right);
    });
    for (const conn of orderedConnections) {
      // Connection scope: unselected connections contribute neither results nor queries.
      if (!quickOpenScopeIncludes(conn.id)) continue;
      // Quick-open searches the live session and its cache. It must never turn a
      // search keystroke into an implicit connection attempt.
      if (!connectionStore.connectedIds.has(conn.id)) continue;
      if (REMOTE_SEARCH_UNSUPPORTED_TYPES.has(conn.db_type)) continue;
      const databases = new Map<string, { database: string; catalog?: string }>();
      const addDatabase = (database: string) => databases.set(JSON.stringify(["", database]), { database });
      collectConnectionDatabases(connectionStore.treeNodes, conn.id, databases);
      if (conn.database?.trim()) addDatabase(conn.database.trim());
      for (const database of conn.visible_databases ?? []) {
        if (database.trim()) addDatabase(database.trim());
      }
      for (const database of conn.attached_databases ?? []) {
        if (database.name.trim()) addDatabase(database.name.trim());
      }
      const defaultDatabase = resolveDefaultDatabase(
        conn,
        [...databases.values()].filter((context) => !context.catalog).map((context) => context.database),
      );
      if (defaultDatabase) addDatabase(defaultDatabase);
      const matchingDatabases = [...databases.values()].filter(({ database }) => {
        if (!matchesQuickSearchContext({ connectionName: conn.name, database }, query)) return false;
        // Apply the database-as-schema alias before the global context budget;
        // otherwise a matching ninth database can be truncated before the
        // schema filter is resolved.
        return !query.filters.schema || !databaseIsSearchSchema(conn) || database.toLocaleLowerCase().includes(query.filters.schema.toLocaleLowerCase());
      });
      if (matchingDatabases.length > 0) databasesByConnection.push({ conn, databases: matchingDatabases });
    }

    const contexts: RemoteSearchContext[] = [];
    // Keep every cache-visible database until schema filters have been resolved.
    // The request budget is applied after that resolution so a matching schema in
    // a later database cannot be discarded before it is discovered.
    for (let databaseIndex = 0; ; databaseIndex++) {
      let added = false;
      for (const { conn, databases } of databasesByConnection) {
        const database = databases[databaseIndex];
        if (!database) continue;
        contexts.push({ conn, ...database });
        added = true;
      }
      if (!added) break;
    }
    return contexts;
  }

  async function resolveRemoteSchemaContexts(contexts: RemoteSearchContext[], query: QuickSearchQuery, generation: number): Promise<RemoteSearchContext[]> {
    const schemaFilter = query.filters.schema?.toLocaleLowerCase();
    if (!schemaFilter) return contexts.slice(0, REMOTE_SEARCH_MAX_REQUESTS);
    const groups = await Promise.all(
      contexts.map(async (context) => {
        const { conn, database } = context;
        if (databaseIsSearchSchema(conn)) {
          // These engines use the database (or attached database name) as the
          // navigable namespace. Their catalog builders do not expose a
          // general schema list, so filtering must happen at the context level.
          return database.toLocaleLowerCase().includes(schemaFilter) ? [context] : [];
        }
        if (!usesSqlCatalogStructureSearch(conn.db_type)) return [context];
        const acquired = await acquireRemoteRequestSlot(generation);
        if (!acquired) return [];
        try {
          if (generation !== remoteSearchGeneration || !connectionStore.connectedIds.has(conn.id)) return [];
          // Resolve the substring filter to exact names before asking a catalog to
          // apply its per-request limit. Schema listing uses the store's cache and
          // does not call ensureConnected.
          const schemas = await connectionStore.listCompletionSchemas(conn.id, database);
          if (generation !== remoteSearchGeneration || !connectionStore.connectedIds.has(conn.id)) return [];
          return [...new Set(schemas)].filter((schema) => schema.toLocaleLowerCase().includes(schemaFilter)).map((schema) => ({ ...context, schema }));
        } catch {
          return [];
        } finally {
          releaseRemoteRequestSlot();
        }
      }),
    );
    const scoped: RemoteSearchContext[] = [];
    for (let index = 0; scoped.length < REMOTE_SEARCH_MAX_REQUESTS; index++) {
      let added = false;
      for (const group of groups) {
        if (!group[index]) continue;
        scoped.push(group[index]!);
        added = true;
        if (scoped.length >= REMOTE_SEARCH_MAX_REQUESTS) break;
      }
      if (!added) break;
    }
    return scoped;
  }

  async function acquireRemoteRequestSlot(generation: number): Promise<boolean> {
    if (generation !== remoteSearchGeneration) return false;
    if (activeRemoteRequests < REMOTE_SEARCH_CONCURRENCY) {
      activeRemoteRequests++;
      return true;
    }
    return new Promise<boolean>((resolve) => remoteRequestWaiters.push({ generation, resolve }));
  }

  function cancelStaleRemoteRequestWaiters(generation: number): void {
    for (let index = remoteRequestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = remoteRequestWaiters[index]!;
      if (waiter.generation === generation) continue;
      remoteRequestWaiters.splice(index, 1);
      waiter.resolve(false);
    }
  }

  function releaseRemoteRequestSlot(): void {
    let next = remoteRequestWaiters.shift();
    while (next && next.generation !== remoteSearchGeneration) {
      next.resolve(false);
      next = remoteRequestWaiters.shift();
    }
    if (next) next.resolve(true);
    else activeRemoteRequests--;
  }

  async function acquireRemoteStructureRequestSlot(generation: number): Promise<boolean> {
    if (generation !== remoteSearchGeneration) return false;
    if (activeRemoteStructureRequests < REMOTE_STRUCTURE_SEARCH_CONCURRENCY) {
      activeRemoteStructureRequests += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => remoteStructureRequestWaiters.push({ generation, resolve }));
  }

  function releaseRemoteStructureRequestSlot(): void {
    let next = remoteStructureRequestWaiters.shift();
    while (next && next.generation !== remoteSearchGeneration) {
      next.resolve(false);
      next = remoteStructureRequestWaiters.shift();
    }
    if (next) next.resolve(true);
    else activeRemoteStructureRequests--;
  }

  function cancelStaleRemoteStructureRequestWaiters(generation: number): void {
    for (let index = remoteStructureRequestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = remoteStructureRequestWaiters[index]!;
      if (waiter.generation === generation) continue;
      remoteStructureRequestWaiters.splice(index, 1);
      waiter.resolve(false);
    }
  }

  function remoteStructureItem(hit: DatabaseStructureSearchHit, conn: ConnectionConfig, database: string): QuickOpenItem {
    const schema = connectionObjectTreeNodeSchema(conn, database, hit.schema || undefined);
    const tableName = hit.tableName;
    const normalizedTableType = (hit.tableType || "").toUpperCase().replaceAll(" ", "_");
    const isView = normalizedTableType === "VIEW" || normalizedTableType === "MATERIALIZED_VIEW";
    const type = hit.columnName ? "column" : isView ? (normalizedTableType.toLowerCase() as "view" | "materialized_view") : "table";
    const comment = hit.columnName ? hit.columnComment : hit.tableComment;
    const catalog = hit.catalog;
    const context = `${conn.name}${catalog ? ` / ${catalog}` : ""} / ${database}${schema ? ` / ${schema}` : ""} / ${tableName}`;
    return {
      id: JSON.stringify(["structure", conn.id, catalog ?? "", database, schema ?? "", tableName, type, hit.columnName ?? null]),
      type,
      label: hit.columnName || tableName,
      description: `${context}${comment ? ` · ${comment}` : ""}`,
      connectionId: conn.id,
      database,
      catalog,
      schema,
      schemaNamespace: databaseIsSearchSchema(conn) ? database : undefined,
      tableName,
      ...(hit.columnName ? { columnName: hit.columnName, columnComment: hit.columnComment } : { objectName: tableName, tableComment: hit.tableComment }),
      tableType: hit.tableType || "TABLE",
      connectionName: conn.name,
      searchText: `${conn.name} ${catalog || ""} ${database} ${schema || ""} ${tableName} ${hit.columnName || ""} ${hit.columnComment || ""} ${hit.tableComment || ""}`,
      source: "remote",
    };
  }

  async function runRemoteStructureSearch(query: string, generation: number, conn: ConnectionConfig, database: string, index: number, schema?: string, catalog?: string): Promise<QuickOpenItem[]> {
    const usesSqlCatalog = usesSqlCatalogStructureSearch(conn.db_type);
    const usesDocumentCatalog = usesDocumentStructureSearch(conn.db_type);
    if ((!usesSqlCatalog && !usesDocumentCatalog) || !supportsDatabaseStructureSearchFromManifest(conn.db_type, conn.driver_profile)) return [];
    if (usesSqlCatalog && (typeof api.buildDatabaseStructureSearchSql !== "function" || typeof api.executeQuery !== "function")) return [];
    if (usesDocumentCatalog && (typeof connectionStore.listCompletionColumns !== "function" || typeof connectionStore.listCompletionTables !== "function")) return [];
    const acquired = await acquireRemoteStructureRequestSlot(generation);
    if (!acquired) return [];
    if (generation !== remoteSearchGeneration || !connectionStore.connectedIds.has(conn.id)) {
      releaseRemoteStructureRequestSlot();
      return [];
    }
    const executionId = `quick-open-structure-${generation}-${index}`;
    activeRemoteExecutionIds.add(executionId);
    try {
      const hits = await runDatabaseStructureSearch({
        connectionId: conn.id,
        databaseType: conn.db_type,
        driverProfile: conn.driver_profile,
        database,
        catalog,
        // A configured SQLite attachment is an exact namespace, even when its
        // alias resembles a filename. Keep it distinct from legacy DB paths.
        schema: schema ?? (conn.db_type === "sqlite" && conn.attached_databases?.some((attachment) => attachment.name === database) ? database : undefined),
        term: query,
        limit: REMOTE_SEARCH_RESULTS_PER_REQUEST,
        executionId,
        shouldAbort: () => generation !== remoteSearchGeneration || !connectionStore.connectedIds.has(conn.id),
        listTables: async (schema) => {
          if (!usesDocumentCatalog || !connectionStore.connectedIds.has(conn.id)) return [];
          const tables = await connectionStore.listCompletionTables(conn.id, database, "", REMOTE_SEARCH_RESULTS_PER_REQUEST, schema, true, undefined, catalog, { activateConnection: false, allowConnection: false });
          return tables.map((table) => ({ name: table.name, table_type: table.type || "TABLE" }));
        },
        getColumns: async (schema, table) => {
          if (!usesDocumentCatalog || !connectionStore.connectedIds.has(conn.id)) return [];
          const columns = await connectionStore.listCompletionColumns(conn.id, database, table, schema, undefined, undefined, { activateConnection: false });
          return columns.map((column) => ({
            name: column.name,
            data_type: column.dataType || "",
            is_nullable: column.isNullable ?? true,
            column_default: null,
            is_primary_key: false,
            extra: null,
            comment: column.comment ?? null,
            numeric_precision: null,
            numeric_scale: null,
            character_maximum_length: null,
          }));
        },
        executeQuery: async (sql, id) => api.executeQuery(conn.id, database, sql, undefined, id, { maxRows: REMOTE_SEARCH_RESULTS_PER_REQUEST * 2, ...(catalog ? { catalog } : {}) }),
      });
      if (generation !== remoteSearchGeneration) return [];
      return hits.map((hit) => remoteStructureItem(hit, conn, database));
    } catch {
      return [];
    } finally {
      activeRemoteExecutionIds.delete(executionId);
      releaseRemoteStructureRequestSlot();
    }
  }

  async function runRemoteSearch(query: string, structureQuery: string, generation: number, contexts: RemoteSearchContext[]): Promise<void> {
    const groups = contexts.map(() => [] as QuickOpenItem[]);
    const structureGroups = contexts.map(() => [] as QuickOpenItem[]);
    const publish = () => {
      if (generation !== remoteSearchGeneration) return;
      // Each request is bounded; keep its candidates until matching and deduplication
      // so table completion cannot crowd fields or comment hits out of another category.
      remoteItems.value = [...groups.flat(), ...structureGroups.flat()];
    };
    await Promise.all(
      contexts.map(async ({ conn, database, schema, catalog }, index) => {
        const acquired = await acquireRemoteRequestSlot(generation);
        if (!acquired) return;
        // A newer query may supersede queued work before it reaches the metadata API.
        if (generation !== remoteSearchGeneration) {
          releaseRemoteRequestSlot();
          return;
        }
        try {
          try {
            if (!connectionStore.connectedIds.has(conn.id)) return;
            const tables = await connectionStore.listCompletionTables(conn.id, database, query, REMOTE_SEARCH_RESULTS_PER_REQUEST, schema, !schema, undefined, catalog, { activateConnection: false, allowConnection: false });
            if (generation !== remoteSearchGeneration) return;
            groups[index] = tables.slice(0, REMOTE_SEARCH_RESULTS_PER_REQUEST).map((table) => remoteTableItem(table, conn, database, catalog));
            publish();
          } catch {
            // The structure catalog can still answer when table completion fails.
          }
        } finally {
          // Release the table-search slot before the supplemental structure query
          // so a slow catalog lookup cannot delay the next table result wave.
          releaseRemoteRequestSlot();
        }
        if (generation !== remoteSearchGeneration || !connectionStore.connectedIds.has(conn.id)) return;
        structureGroups[index] = await runRemoteStructureSearch(structureQuery, generation, conn, database, index, schema, catalog);
        publish();
      }),
    );
  }

  /**
   * Reload external SQL files when folder paths or folder contents change.
   * `sqlFileFoldersVersion` is bumped by SqlFilePanel on add/remove/refresh.
   */
  watch(sqlFileFoldersVersion, () => {
    sqlFilesLoadGeneration++;
    sqlFilesLoaded = false;
    sqlFileItems.value = [];
    void loadExternalSqlFiles();
  });

  /**
   * Invalidate in-flight remote work and schedule a fresh search for `rawQuery`.
   * Both the query watcher and the scope watcher funnel through here: bumping the
   * generation keeps stale responses from landing, and the debounce coalesces bursts.
   */
  function cancelSearch(): void {
    remoteSearchGeneration += 1;
    contentSearchGeneration += 1;
    cancelActiveContentSearch();
    if (remoteSearchTimer) clearTimeout(remoteSearchTimer);
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    remoteSearchTimer = undefined;
    contentSearchTimer = undefined;
    for (const executionId of activeRemoteExecutionIds) {
      if (typeof api.cancelQuery === "function") void api.cancelQuery(executionId).catch(() => undefined);
    }
    cancelStaleRemoteRequestWaiters(remoteSearchGeneration);
    cancelStaleRemoteStructureRequestWaiters(remoteSearchGeneration);
    activeRemoteExecutionIds.clear();
    remoteItems.value = [];
    clearContentResults();
  }

  function scheduleRemoteSearch(rawQuery: string): void {
    selectedIndex.value = 0;
    const generation = ++remoteSearchGeneration;
    for (const executionId of activeRemoteExecutionIds) {
      if (typeof api.cancelQuery === "function") void api.cancelQuery(executionId).catch(() => undefined);
    }
    cancelStaleRemoteRequestWaiters(generation);
    cancelStaleRemoteStructureRequestWaiters(generation);
    if (remoteSearchTimer) clearTimeout(remoteSearchTimer);
    remoteSearchTimer = undefined;
    remoteItems.value = [];

    if (options.enabled?.value === false) return;
    const parsedQuery = parseQuickSearchQuery(rawQuery);
    const normalizedQuery = parsedQuery.text.trim() || parsedQuery.filters.comment || "";
    const structureQuery = parsedQuery.filters.comment || normalizedQuery;
    if (Math.max(normalizedQuery.length, structureQuery.length) < REMOTE_SEARCH_MIN_QUERY_LENGTH) return;
    const contexts = remoteSearchContexts(parsedQuery);
    if (contexts.length === 0) return;

    remoteSearchTimer = setTimeout(() => {
      remoteSearchTimer = undefined;
      void resolveRemoteSchemaContexts(contexts, parsedQuery, generation).then((scopedContexts) => {
        if (generation === remoteSearchGeneration) return runRemoteSearch(normalizedQuery, structureQuery, generation, scopedContexts);
      });
    }, REMOTE_SEARCH_DEBOUNCE_MS);
  }

  watch(
    searchQuery,
    (query) => {
      const normalizedQuery = query.trim();

      // Ensure external SQL files are loaded when the user starts searching
      if (normalizedQuery.length > 0 && !sqlFilesLoaded && !sqlFilesLoadingPromise) {
        void loadExternalSqlFiles();
      }
      if (normalizedQuery.length > 0) {
        void loadPluginWorkbenches();
      }

      scheduleRemoteSearch(query);
    },
    { flush: "sync" },
  );

  // Changing the connection scope re-runs the current query immediately, without retyping.
  watch(quickOpenScopeIds, () => {
    scheduleRemoteSearch(searchQuery.value);
  });

  const matchingItems = computed((): MatchedItem[] => {
    if (!searchQuery.value.trim()) {
      // Show live tree items, last-known offline metadata, and a limited set of recent files.
      return [...searchableMetadataItems.value, ...sqlLibraryRecentItems.value, ...sqlFileRecentItems.value, ...(extraItems?.value ?? [])].map((item) => ({
        ...item,
        matchScore: Infinity,
        matchIndices: [],
      }));
    }

    const matched: MatchedItem[] = [];
    const parsedQuery = parseQuickSearchQuery(searchQuery.value);
    const queryText = parsedQuery.text;

    const seen = new Set<string>();
    // When searching, include ALL SQL library files and external SQL files.
    // Explicit filters are evaluated before ranking, so a structured query cannot
    // accidentally match a similarly named object from another database.
    for (const entry of quickSearchIndex.value.entries) {
      const item = entry.result;
      const key = quickOpenItemKey(item);
      if (seen.has(key)) continue;
      if (!matchesQuickSearchQuery(item, parsedQuery)) continue;

      const labelMatch = matchQuickOpenText(queryText, item.label);
      const fields = entry.fields;
      const metadataMatches = [fields.comment, fields.context, fields.path, item.searchText]
        .filter(Boolean)
        .map((value) => matchQuickSearchField(queryText, value))
        .filter((value): value is NonNullable<typeof value> => value !== null);
      const metadataMatch = metadataMatches.sort((left, right) => left.score - right.score)[0] || null;
      const result = labelMatch ?? metadataMatch;
      if (result) {
        seen.add(key);
        matched.push({
          ...item,
          matchScore: result.score + (labelMatch ? 0 : 1000),
          matchIndices: labelMatch?.indices ?? [],
        });
      }
    }

    // Keep the DataGrip-style result sections stable, then rank within each
    // section. This prevents one exact file match from splitting the object list.
    const categoryOrder = (item: QuickOpenItem): number => {
      if (item.type === "sql_file" || item.type === "sql_library_file" || item.type === "content_match") return 1;
      if (item.type === "plugin_command" || item.type === "plugin_workbench") return 2;
      return 0;
    };
    // Sort by category, score, and type (connections > databases > tables > other objects for equal scores)
    matched.sort((a, b) => {
      const categoryDifference = categoryOrder(a) - categoryOrder(b);
      if (categoryDifference !== 0) return categoryDifference;
      if (a.matchScore !== b.matchScore) {
        return a.matchScore - b.matchScore; // Lower scores (better matches) come first
      }

      const typeOrder = {
        connection: 0,
        plugin_workbench: 1,
        database: 2,
        schema: 3,
        table: 4,
        column: 5,
        view: 6,
        materialized_view: 7,
        procedure: 8,
        function: 9,
        sequence: 10,
        package: 11,
        "package-body": 12,
        sql_library_file: 13,
        sql_file: 14,
        content_match: 15,
        plugin_command: 16,
      };
      const typeDifference = typeOrder[a.type] - typeOrder[b.type];
      if (typeDifference !== 0) return typeDifference;
      const lengthDifference = a.label.length - b.label.length;
      if (lengthDifference !== 0) return lengthDifference;
      return a.label.localeCompare(b.label);
    });

    // Limit ranked remote matches per category, after filters and deduplication.
    // Category switching reads this same snapshot and never needs another query.
    const remoteCounts = new Map<QuickSearchCategory, number>();
    return matched.filter((item) => {
      if (item.source !== "remote") return true;
      const category = quickSearchCategory(item);
      const count = remoteCounts.get(category) ?? 0;
      if (count >= REMOTE_SEARCH_MAX_RESULTS_PER_CATEGORY) return false;
      remoteCounts.set(category, count + 1);
      return true;
    });
  });

  const filteredItems = computed((): MatchedItem[] => {
    const category = options.category?.value ?? "all";
    const items = category === "all" ? matchingItems.value : matchingItems.value.filter((item) => quickSearchCategory(item) === category);
    return searchQuery.value.trim() ? items.slice(0, QUICK_OPEN_MAX_RESULTS) : items;
  });

  const homeItems = computed<QuickOpenItem[]>(() => {
    const activeConnectionId = connectionStore.activeConnectionId;
    // Resolve history against the complete current file index, not its top-20
    // presentation slice. Library files may have been renamed, rebound or deleted.
    const allHomeCandidates = [...searchableMetadataItems.value, ...sqlLibraryAllItems.value, ...sqlFileItems.value, ...(extraItems?.value ?? [])];
    const candidateById = new Map(allHomeCandidates.map((item) => [item.id, item]));
    const recentItems = recentQuickOpenEntries.value
      .filter((entry) => {
        const currentItem = candidateById.get(entry.id);
        if (currentItem) return !currentItem.connectionId || quickOpenScopeIncludes(currentItem.connectionId);
        if (entry.item.type === "plugin_command" || entry.item.type === "plugin_workbench" || entry.item.type === "sql_library_file") return false;
        if (entry.item.connectionId && !quickOpenScopeIncludes(entry.item.connectionId)) return false;
        return !entry.item.connectionId || connectionStore.connections.some((connection) => connection.id === entry.item.connectionId);
      })
      .map((entry) => candidateById.get(entry.id) || entry.item);
    const activeObjects = activeConnectionId ? searchableMetadataItems.value.filter((item) => item.connectionId === activeConnectionId && item.type !== "connection").slice(0, 8) : [];
    const connectedConnections = allItems.value.filter((item) => item.type === "connection" && item.connectionId && connectionStore.connectedIds.has(item.connectionId));
    const candidates = [...recentItems, ...activeObjects, ...sqlLibraryRecentItems.value, ...sqlFileRecentItems.value, ...connectedConnections, ...allItems.value.filter((item) => item.type === "connection")];
    const seen = new Set<string>();
    return candidates
      .filter((item) => {
        const key = quickOpenItemKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, RECENT_QUICK_OPEN_LIMIT);
  });

  const selectedItem = computed((): MatchedItem | null => {
    if (selectedIndex.value < 0 || selectedIndex.value >= filteredItems.value.length) {
      return null;
    }
    return filteredItems.value[selectedIndex.value];
  });

  const contentSelectedItem = computed((): MatchedItem | null => {
    if (!contentMode.value) return null;
    if (selectedIndex.value < 0 || selectedIndex.value >= selectableContentItems.value.length) return null;
    return selectableContentItems.value[selectedIndex.value];
  });

  function selectNext(): void {
    const length = contentMode.value ? selectableContentItems.value.length : filteredItems.value.length;
    if (selectedIndex.value < length - 1) {
      selectedIndex.value++;
    }
  }

  function selectPrevious(): void {
    if (selectedIndex.value > 0) {
      selectedIndex.value--;
    }
  }

  function resetSelection(): void {
    selectedIndex.value = 0;
  }

  function setQuery(query: string): void {
    searchQuery.value = query;
    resetSelection();
  }

  // Content search: debounced full-text search fired from the shared query.
  watch(
    searchQuery,
    (query) => {
      selectedIndex.value = 0;
      const generation = ++contentSearchGeneration;
      cancelActiveContentSearch();
      if (contentSearchTimer) clearTimeout(contentSearchTimer);
      contentSearchTimer = undefined;
      if (!contentMode.value) {
        clearContentResults();
        return;
      }
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        clearContentResults();
        return;
      }
      contentSearchError.value = null;
      contentSearchTimer = setTimeout(() => {
        contentSearchTimer = undefined;
        void runContentSearch(normalizedQuery, generation);
      }, CONTENT_SEARCH_DEBOUNCE_MS);
    },
    { flush: "sync" },
  );

  // Re-run the current content search when search roots or extensions change.
  watch(globalSearchSettingsVersion, () => {
    if (contentMode.value && searchQuery.value.trim()) {
      const generation = ++contentSearchGeneration;
      void runContentSearch(searchQuery.value.trim(), generation);
    }
  });

  watch(sqlFileFoldersVersion, () => {
    if (contentMode.value && searchQuery.value.trim()) {
      const generation = ++contentSearchGeneration;
      void runContentSearch(searchQuery.value.trim(), generation);
    }
  });

  onScopeDispose(() => {
    persistedMetadataDisposed = true;
    persistedMetadataLoadGeneration += 1;
    persistedMetadataConnectionSignature = "";
    cancelSearch();
  }, true);

  return {
    searchQuery,
    matchingItems,
    filteredItems,
    homeItems,
    selectedIndex,
    selectedItem,
    contentMode,
    contentSearching,
    contentSearchError,
    contentGroups,
    contentSelectedItem,
    setContentMode,
    retryContentSearch,
    cancelSearch,
    selectNext,
    selectPrevious,
    resetSelection,
    setQuery,
    recordRecentItem,
    loadExternalSqlFiles,
    loadPluginWorkbenches,
    // Connection scope: empty = all connections.
    scopeConnectionIds: quickOpenScopeIds,
    scopeActive: computed(() => isQuickOpenScopeActive()),
    setScopeConnectionIds: setQuickOpenScopeIds,
  };
}
