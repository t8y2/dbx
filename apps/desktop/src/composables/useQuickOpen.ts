import { computed, ref, watch } from "vue";
import type { ConnectionConfig } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";
import { getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";

const REMOTE_SEARCH_DEBOUNCE_MS = 180;
const REMOTE_SEARCH_MIN_QUERY_LENGTH = 2;
const REMOTE_SEARCH_MAX_REQUESTS = 8;
const REMOTE_SEARCH_CONCURRENCY = 2;
const REMOTE_SEARCH_RESULTS_PER_REQUEST = 25;
const REMOTE_SEARCH_MAX_RESULTS = 100;
const QUICK_OPEN_MAX_RESULTS = 200;
const INITIAL_SQL_LIBRARY_LIMIT = 20;
const INITIAL_SQL_FILE_LIMIT = 20;

const REMOTE_SEARCH_UNSUPPORTED_TYPES = new Set<ConnectionConfig["db_type"]>(["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "neo4j", "influxdb", "etcd", "zookeeper", "mq", "nacos"]);

export interface QuickOpenItem {
  id: string;
  type: "connection" | "database" | "schema" | "table" | "view" | "materialized_view" | "procedure" | "function" | "sequence" | "package" | "package-body" | "sql_file" | "sql_library_file";
  label: string;
  description?: string;
  connectionId: string;
  database?: string;
  schema?: string;
  objectName?: string; // For non-table objects (views, procedures, functions, sequences, packages)
  tableName?: string; // Kept for backward compatibility
  connectionName?: string;
  searchText: string; // Lowercase text for searching
  filePath?: string; // For external SQL files
  sqlFileId?: string; // For saved SQL library files
}

/**
 * Fuzzy match function that checks if query matches text
 * Returns the matched indices for highlighting
 */
function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (!lowerQuery) return { score: Infinity, indices: [] };
  if (lowerText.includes(lowerQuery)) {
    // Exact substring match gets highest score
    const startIdx = lowerText.indexOf(lowerQuery);
    return {
      score: 1,
      indices: Array.from({ length: lowerQuery.length }, (_, i) => startIdx + i),
    };
  }

  // Fuzzy match: find all characters in order
  let queryIdx = 0;
  const indices: number[] = [];
  let score = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      indices.push(i);
      // Score based on proximity (consecutive chars score better)
      score += lastMatchIdx === i - 1 ? 2 : 1;
      lastMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx === lowerQuery.length) {
    return { score: score / lowerQuery.length, indices };
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

export function useQuickOpen() {
  const connectionStore = useConnectionStore();
  const savedSqlStore = useSavedSqlStore();
  const searchQuery = ref("");
  const selectedIndex = ref(0);
  const remoteItems = ref<QuickOpenItem[]>([]);
  const sqlFileItems = ref<QuickOpenItem[]>([]);
  let remoteSearchGeneration = 0;
  let remoteSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRemoteRequests = 0;
  const remoteRequestWaiters: Array<() => void> = [];
  let sqlFilesLoaded = false;
  let sqlFilesLoadingPromise: Promise<void> | null = null;
  let sqlFilesLoadGeneration = 0;

  function getConnectionLabel(connectionId: string): string {
    const conn = connectionStore.connections.find((c) => c.id === connectionId);
    return conn?.name || connectionId;
  }

  const sqlLibraryAllItems = computed<QuickOpenItem[]>(() => {
    const activeConnectionIds = new Set(connectionStore.connections.map((c) => c.id));
    const orphanedIds = savedSqlStore.orphanedFileIds(activeConnectionIds);
    return savedSqlStore.allFiles
      .filter((file) => !orphanedIds.has(file.id))
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
            const entries = await api.listSqlFilesInFolder(folderPath);
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
    return sqlFileItems.value.slice(0, INITIAL_SQL_FILE_LIMIT);
  });

  const allItems = computed((): QuickOpenItem[] => {
    const items: QuickOpenItem[] = [];
    const connections = connectionStore.connections;
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

  function processDatabaseTreeNodes(nodes: any[], conn: ConnectionConfig, items: QuickOpenItem[]): void {
    for (const node of nodes) {
      // Skip certain node types
      if (node.type === "group" || node.type === "linked-server-root") {
        if (node.children) {
          processDatabaseTreeNodes(node.children, conn, items);
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
        if (node.children) processDatabaseTreeNodes(node.children, conn, items);
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
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
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
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
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
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Procedure nodes
      if (node.type === "procedure" && node.database && node.label) {
        items.push({
          id: `proc-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "procedure",
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

      // Function nodes
      if (node.type === "function" && node.database && node.label) {
        items.push({
          id: `func-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "function",
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
          id: `pkg-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "package",
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

      // Package-body nodes
      if (node.type === "package-body" && node.database && node.label) {
        items.push({
          id: `pkgbody-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "package-body",
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

      // Process children recursively
      if (node.children) {
        processDatabaseTreeNodes(node.children, conn, items);
      }
    }
  }

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
    if (item.type === "table" || item.type === "view" || item.type === "materialized_view") {
      return `${item.connectionId}:${item.database ?? ""}:${item.schema ?? ""}:${item.tableName ?? item.objectName ?? item.label}`.toLowerCase();
    }
    return item.id.toLowerCase();
  }

  function remoteTableItem(table: SqlCompletionTable, conn: ConnectionConfig, database: string): QuickOpenItem {
    const type = table.type ?? "table";
    const prefix = type === "materialized_view" ? "mview" : type;
    return {
      id: `${prefix}-${conn.id}-${database}-${table.schema || ""}-${table.name}`,
      type,
      label: table.name,
      description: `${conn.name} / ${database}${table.schema ? " / " + table.schema : ""}`,
      connectionId: conn.id,
      database,
      schema: table.schema,
      ...(type === "table" ? { tableName: table.name } : { objectName: table.name }),
      connectionName: conn.name,
      searchText: `${conn.name} ${database} ${table.schema || ""} ${table.name}`,
    };
  }

  function collectConnectionDatabases(nodes: any[], connectionId: string, databases: Set<string>): void {
    for (const node of nodes) {
      if (node.connectionId === connectionId && node.type === "database" && node.database) {
        databases.add(node.database);
      }
      if (node.children) collectConnectionDatabases(node.children, connectionId, databases);
    }
  }

  function remoteSearchContexts(): Array<{ conn: ConnectionConfig; database: string }> {
    if (typeof connectionStore.listCompletionTables !== "function") return [];
    const connectedIds = connectionStore.connectedIds;
    if (!(connectedIds instanceof Set)) return [];

    const databasesByConnection: Array<{ conn: ConnectionConfig; databases: string[] }> = [];
    for (const conn of connectionStore.connections) {
      if (!connectedIds.has(conn.id) || REMOTE_SEARCH_UNSUPPORTED_TYPES.has(conn.db_type)) continue;
      const databases = new Set<string>();
      collectConnectionDatabases(connectionStore.treeNodes, conn.id, databases);
      if (conn.database?.trim()) databases.add(conn.database.trim());
      for (const database of conn.visible_databases ?? []) {
        if (database.trim()) databases.add(database.trim());
      }
      for (const database of conn.attached_databases ?? []) {
        if (database.name.trim()) databases.add(database.name.trim());
      }
      if (databases.size > 0) databasesByConnection.push({ conn, databases: [...databases] });
    }

    const contexts: Array<{ conn: ConnectionConfig; database: string }> = [];
    for (let databaseIndex = 0; contexts.length < REMOTE_SEARCH_MAX_REQUESTS; databaseIndex++) {
      let added = false;
      for (const { conn, databases } of databasesByConnection) {
        const database = databases[databaseIndex];
        if (!database) continue;
        contexts.push({ conn, database });
        added = true;
        if (contexts.length >= REMOTE_SEARCH_MAX_REQUESTS) break;
      }
      if (!added) break;
    }
    return contexts;
  }

  async function acquireRemoteRequestSlot(): Promise<void> {
    if (activeRemoteRequests < REMOTE_SEARCH_CONCURRENCY) {
      activeRemoteRequests++;
      return;
    }
    await new Promise<void>((resolve) => remoteRequestWaiters.push(resolve));
  }

  function releaseRemoteRequestSlot(): void {
    const next = remoteRequestWaiters.shift();
    if (next) next();
    else activeRemoteRequests--;
  }

  async function runRemoteSearch(query: string, generation: number, contexts: Array<{ conn: ConnectionConfig; database: string }>): Promise<void> {
    const groups = await Promise.all(
      contexts.map(async ({ conn, database }) => {
        await acquireRemoteRequestSlot();
        try {
          // A newer query may supersede queued work before it reaches the metadata API.
          if (generation !== remoteSearchGeneration) return [];
          const tables = await connectionStore.listCompletionTables(conn.id, database, query, REMOTE_SEARCH_RESULTS_PER_REQUEST, undefined, true);
          return tables.slice(0, REMOTE_SEARCH_RESULTS_PER_REQUEST).map((table) => remoteTableItem(table, conn, database));
        } catch {
          return [];
        } finally {
          releaseRemoteRequestSlot();
        }
      }),
    );

    if (generation !== remoteSearchGeneration) return;
    remoteItems.value = groups.flat().slice(0, REMOTE_SEARCH_MAX_RESULTS);
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

  watch(
    searchQuery,
    (query) => {
      const generation = ++remoteSearchGeneration;
      if (remoteSearchTimer) clearTimeout(remoteSearchTimer);
      remoteItems.value = [];

      const normalizedQuery = query.trim();

      // Ensure external SQL files are loaded when the user starts searching
      if (normalizedQuery.length > 0 && !sqlFilesLoaded && !sqlFilesLoadingPromise) {
        void loadExternalSqlFiles();
      }

      if (normalizedQuery.length < REMOTE_SEARCH_MIN_QUERY_LENGTH) return;
      const contexts = remoteSearchContexts();
      if (contexts.length === 0) return;

      remoteSearchTimer = setTimeout(() => {
        remoteSearchTimer = undefined;
        void runRemoteSearch(normalizedQuery, generation, contexts);
      }, REMOTE_SEARCH_DEBOUNCE_MS);
    },
    { flush: "sync" },
  );

  const filteredItems = computed((): MatchedItem[] => {
    if (!searchQuery.value.trim()) {
      // Show all tree items plus a limited set of recent SQL library files and external SQL files
      return [...allItems.value, ...sqlLibraryRecentItems.value, ...sqlFileRecentItems.value].map((item) => ({
        ...item,
        matchScore: Infinity,
        matchIndices: [],
      }));
    }

    const matched: MatchedItem[] = [];

    const seen = new Set<string>();
    // When searching, include ALL SQL library files and external SQL files
    for (const item of [...allItems.value, ...sqlLibraryAllItems.value, ...sqlFileItems.value, ...remoteItems.value]) {
      const key = quickOpenItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = fuzzyMatch(searchQuery.value, item.searchText);
      if (result) {
        matched.push({
          ...item,
          matchScore: result.score,
          matchIndices: result.indices,
        });
      }
    }

    // Sort by score and type (connections > databases > tables > other objects for equal scores)
    matched.sort((a, b) => {
      if (a.matchScore !== b.matchScore) {
        return a.matchScore - b.matchScore; // Lower scores (better matches) come first
      }

      const typeOrder = {
        connection: 0,
        database: 1,
        schema: 2,
        table: 3,
        view: 4,
        materialized_view: 5,
        procedure: 6,
        function: 7,
        sequence: 8,
        package: 9,
        "package-body": 10,
        sql_library_file: 11,
        sql_file: 12,
      };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    return matched.slice(0, QUICK_OPEN_MAX_RESULTS);
  });

  const selectedItem = computed((): MatchedItem | null => {
    if (selectedIndex.value < 0 || selectedIndex.value >= filteredItems.value.length) {
      return null;
    }
    return filteredItems.value[selectedIndex.value];
  });

  function selectNext(): void {
    if (selectedIndex.value < filteredItems.value.length - 1) {
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

  return {
    searchQuery,
    filteredItems,
    selectedIndex,
    selectedItem,
    selectNext,
    selectPrevious,
    resetSelection,
    setQuery,
    loadExternalSqlFiles,
  };
}
