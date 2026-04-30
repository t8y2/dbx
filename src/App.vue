<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { DatabaseZap, FilePlus2, Play, Loader2, X, Globe, Moon, Sun, Upload, Download, Plus, History, Server, Table2, Database, Search, ShieldCheck, Sparkles, Pin, AlignLeft, CloudDownload } from "lucide-vue-next";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import ConnectionTree from "@/components/sidebar/ConnectionTree.vue";
import ConnectionDialog from "@/components/connection/ConnectionDialog.vue";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import RedisKeyBrowser from "@/components/redis/RedisKeyBrowser.vue";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import MongoDocBrowser from "@/components/mongo/MongoDocBrowser.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import QueryHistory from "@/components/editor/QueryHistory.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import type { ConnectionConfig } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { setLocale, currentLocale, type Locale } from "@/i18n";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "@/lib/tauri";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import type { SqlFormatDialect } from "@/lib/sqlFormatter";
import { isCloseTabShortcut, isExecuteSqlShortcut } from "@/lib/keyboardShortcuts";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const historyStore = useHistoryStore();
const settingsStore = useSettingsStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();

const showConnectionDialog = ref(false);
const showHistory = ref(false);
const showUpdateDialog = ref(false);
const dangerSql = ref("");
const pendingDangerSql = ref("");
const selectedSql = ref("");
const formatSqlRequestId = ref(0);
const showDangerDialog = ref(false);
const databaseOptions = ref<Record<string, string[]>>({});
const loadingDatabaseOptions = ref<Record<string, boolean>>({});
const checkingUpdates = ref(false);
const updateInfo = ref<api.UpdateInfo | null>(null);
const updateCheckMessage = ref("");
const latestReleaseUrl = "https://github.com/t8y2/dbx/releases/latest";

const editConfig = computed(() => {
  const id = connectionStore.editingConnectionId;
  if (!id) return undefined;
  return connectionStore.getConfig(id);
});

watch(editConfig, (v) => {
  if (v) showConnectionDialog.value = true;
});

watch(showConnectionDialog, (v) => {
  if (!v) connectionStore.stopEditing();
});

function onConnectionConnectStarted(name: string) {
  toast(t("connection.connecting", { name }), 30000);
}

function onConnectionConnectSucceeded(name: string) {
  toast(t("connection.connectSuccess", { name }), 2000);
}

function onConnectionConnectFailed(message: string) {
  toast(t("connection.connectFailed", { message }), 5000);
}

const activeTab = computed(() =>
  queryStore.tabs.find((t) => t.id === queryStore.activeTabId)
);

const executableSql = computed(() => {
  const tab = activeTab.value;
  return tab ? resolveExecutableSql(tab.sql, selectedSql.value) : "";
});

watch(() => queryStore.activeTabId, () => {
  selectedSql.value = "";
  pendingDangerSql.value = "";
});

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

const activeSqlFormatDialect = computed<SqlFormatDialect>(() => {
  switch (activeConnection.value?.db_type) {
    case "mysql":
      return "mysql";
    case "postgres":
      return "postgres";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "sqlserver";
    default:
      return "generic";
  }
});

const editorDialect = computed<"mysql" | "postgres">(() =>
  activeConnection.value?.db_type === "postgres" ? "postgres" : "mysql"
);

const activeTabContext = computed(() => {
  const tab = activeTab.value;
  const connection = activeConnection.value;
  if (!tab || !connection) return [];

  const items = [
    connection.name,
    connectionDriverLabel(connection),
  ];

  if (tab.tableMeta?.tableName) {
    items.push(tab.tableMeta.schema
      ? `${tab.tableMeta.schema}.${tab.tableMeta.tableName}`
      : tab.tableMeta.tableName);
  }

  return items;
});

const activeDatabaseOptions = computed(() => {
  const connection = activeConnection.value;
  return connection ? databaseOptions.value[connection.id] ?? [] : [];
});

const activeDatabaseValue = computed(() => activeTab.value?.database || "");
const activeConnectionValue = computed(() => activeConnection.value?.id || "");
const connectionStats = computed(() => {
  const total = connectionStore.connections.length;
  const connected = connectionStore.connectedIds.size;
  const types = new Set(connectionStore.connections.map((connection) => connection.driver_profile || connection.db_type)).size;
  return { total, connected, types };
});

const recentConnections = computed(() => connectionStore.connections.slice(0, 5));

function connectionDisplayName(connectionId: string): string {
  return connectionStore.getConfig(connectionId)?.name || connectionId;
}

function connectionDriverLabel(connection?: ConnectionConfig): string {
  return connection?.driver_label || connection?.db_type.toUpperCase() || "";
}

function connectionIconType(connection?: ConnectionConfig): string {
  return connection?.driver_profile || connection?.db_type || "postgres";
}

function connectionColor(connectionId: string): string {
  return connectionStore.getConfig(connectionId)?.color || "";
}

function databaseDisplayName(database: string): string {
  const connection = activeConnection.value;
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  return database || t("editor.noDatabase");
}

function tabDisplayTitle(tab: typeof queryStore.tabs[number]): string {
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database);
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    return `${database} | ${tab.tableMeta.tableName}`;
  }
  if (tab.mode === "query") {
    return `${connectionDisplayName(tab.connectionId)} | ${database}`;
  }
  if (tab.mode === "mongo" && tab.sql) {
    return `${database} | ${tab.sql}`;
  }
  if (tab.mode === "redis") {
    return `${connectionDisplayName(tab.connectionId)} | ${database}`;
  }
  return tab.title;
}

function databaseDisplayNameForTab(connectionId: string, database: string): string {
  const connection = connectionStore.getConfig(connectionId);
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  return database || t("editor.noDatabase");
}

async function loadDatabaseOptions(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection || loadingDatabaseOptions.value[connectionId]) return;

  loadingDatabaseOptions.value[connectionId] = true;
  try {
    await connectionStore.ensureConnected(connectionId);
    if (connection.db_type === "redis") {
      const dbs = await api.redisListDatabases(connectionId);
      databaseOptions.value[connectionId] = dbs.map(String);
    } else if (connection.db_type === "mongodb") {
      databaseOptions.value[connectionId] = await api.mongoListDatabases(connectionId);
    } else {
      const dbs = await api.listDatabases(connectionId);
      databaseOptions.value[connectionId] = dbs.map((db) => db.name);
    }
  } finally {
    loadingDatabaseOptions.value[connectionId] = false;
  }
}

async function getDatabaseOptions(connectionId: string): Promise<string[]> {
  if (!databaseOptions.value[connectionId]) {
    await loadDatabaseOptions(connectionId);
  }
  return databaseOptions.value[connectionId] ?? [];
}

watch(activeConnection, (connection) => {
  if (connection && !databaseOptions.value[connection.id]) {
    loadDatabaseOptions(connection.id).catch(() => {});
  }
}, { immediate: true });

function onEditorUpdate(val: string) {
  if (queryStore.activeTabId) {
    queryStore.updateSql(queryStore.activeTabId, val);
  }
}

function onEditorSelectionChange(val: string) {
  selectedSql.value = val;
}

function formatActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  formatSqlRequestId.value++;
}

function onFormatSqlError() {
  toast(t("toolbar.formatSqlFailed"));
}

function newQuery() {
  if (!connectionStore.activeConnectionId) return;
  const conn = connectionStore.connections.find(
    (c) => c.id === connectionStore.activeConnectionId
  );
  if (!conn) return;
  queryStore.createTab(conn.id, conn.database || "");
}

async function openConnectionQuery(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  const options = await getDatabaseOptions(connectionId);
  const database = connection.database || options[0] || "";
  connectionStore.activeConnectionId = connectionId;
  queryStore.createTab(connectionId, database);
}

const DANGER_RE = /\b(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

function isDangerousSql(sql: string): boolean {
  return DANGER_RE.test(stripSqlComments(sql));
}

function tryExecute(sqlOverride?: string) {
  const tab = activeTab.value;
  const sql = sqlOverride ?? executableSql.value;
  if (!tab || !sql.trim()) return;
  if (isDangerousSql(sql)) {
    dangerSql.value = sql;
    pendingDangerSql.value = sql;
    showDangerDialog.value = true;
  } else {
    doExecute(sql);
  }
}

async function doExecute(sql = executableSql.value) {
  const tab = activeTab.value;
  if (!tab || !sql.trim()) return;
  const connName = connectionStore.getConfig(tab.connectionId)?.name || "";
  const start = Date.now();
  await queryStore.executeCurrentSql(sql);
  const elapsed = Date.now() - start;
  const success = !tab.result?.columns.includes("Error");
  historyStore.add({
    connection_name: connName,
    database: tab.database,
    sql,
    execution_time_ms: elapsed,
    success,
    error: success ? undefined : String(tab.result?.rows?.[0]?.[0] ?? ""),
  });
}

function onDangerConfirm() {
  const sql = pendingDangerSql.value || executableSql.value;
  pendingDangerSql.value = "";
  doExecute(sql);
}

function onHistoryRestore(sql: string) {
  if (queryStore.activeTabId) {
    queryStore.updateSql(queryStore.activeTabId, sql);
  }
}

function replaceActiveSql(sql: string) {
  const tab = activeTab.value;
  if (!tab) return;
  queryStore.updateSql(tab.id, sql);
}

function appendActiveSql(sql: string) {
  const tab = activeTab.value;
  if (!tab) return;
  const current = tab.sql.trimEnd();
  queryStore.updateSql(tab.id, current ? `${current}\n\n${sql}` : sql);
}

function changeActiveDatabase(database: any) {
  const tab = activeTab.value;
  if (!tab || typeof database !== "string") return;
  queryStore.updateDatabase(tab.id, database);
}

async function changeActiveConnection(connectionId: any) {
  const tab = activeTab.value;
  if (!tab || typeof connectionId !== "string") return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  const options = await getDatabaseOptions(connectionId);
  const database = connection.database || options[0] || "";
  queryStore.updateConnection(tab.id, connectionId, database);
  connectionStore.activeConnectionId = connectionId;
}

async function onExecuteSql(sql: string) {
  const tab = activeTab.value;
  if (!tab) return;
  await api.executeQuery(tab.connectionId, tab.database, sql);
}

async function onReloadData() {
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.mode === "data" && tab.tableMeta) {
    queryStore.updateSql(tab.id, buildTableSql(tab));
  }
  queryStore.executeCurrentTab();
}

type ActiveTab = NonNullable<typeof activeTab.value>;

function quoteIdent(tab: ActiveTab, name: string): string {
  const config = connectionStore.getConfig(tab.connectionId);
  return config?.db_type === "mysql"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTableName(tab: NonNullable<typeof activeTab.value>): string {
  const config = connectionStore.getConfig(tab.connectionId);
  if (!tab.tableMeta) return "";
  if ((config?.db_type === "postgres" || config?.db_type === "oracle" || config?.db_type === "sqlserver") && tab.tableMeta.schema) {
    return `${quoteIdent(tab, tab.tableMeta.schema)}.${quoteIdent(tab, tab.tableMeta.tableName)}`;
  }
  return quoteIdent(tab, tab.tableMeta.tableName);
}

function defaultOrderBy(tab: NonNullable<typeof activeTab.value>): string | undefined {
  const primaryKeys = tab.tableMeta?.primaryKeys ?? [];
  if (primaryKeys.length === 0) return undefined;
  return primaryKeys.map((pk) => `${quoteIdent(tab, pk)} ASC`).join(", ");
}

function buildTableSql(
  tab: NonNullable<typeof activeTab.value>,
  options: { orderBy?: string; limit?: number; offset?: number } = {},
): string {
  const config = connectionStore.getConfig(tab.connectionId);
  const limit = options.limit ?? 100;
  const orderBy = options.orderBy ?? defaultOrderBy(tab);
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";

  if (config?.db_type === "oracle") {
    const offset = options.offset ? ` OFFSET ${options.offset} ROWS` : "";
    return `SELECT * FROM ${qualifiedTableName(tab)}${order}${offset} FETCH FIRST ${limit} ROWS ONLY`;
  }

  if (config?.db_type === "sqlserver") {
    return `SELECT TOP ${limit} * FROM ${qualifiedTableName(tab)}${order}`;
  }

  const offset = options.offset ? ` OFFSET ${options.offset}` : "";
  return `SELECT * FROM ${qualifiedTableName(tab)}${order} LIMIT ${limit}${offset};`;
}

async function onPaginate(offset: number, limit: number) {
  const tab = activeTab.value;
  if (!tab?.tableMeta) return;
  const sql = buildTableSql(tab, { limit, offset });
  queryStore.updateSql(tab.id, sql);
  await queryStore.executeCurrentTab();
}

async function onSort(column: string, direction: "asc" | "desc" | null) {
  const tab = activeTab.value;
  if (!tab?.tableMeta) return;
  const orderBy = direction ? `${quoteIdent(tab, column)} ${direction.toUpperCase()}` : defaultOrderBy(tab);
  const sql = buildTableSql(tab, { orderBy });
  queryStore.updateSql(tab.id, sql);
  await queryStore.executeCurrentTab();
}

function toggleLocale() {
  const next: Locale = currentLocale() === "zh-CN" ? "en" : "zh-CN";
  setLocale(next);
}

const isDark = ref(localStorage.getItem("dbx-theme") === "dark");

function applyTheme() {
  document.documentElement.classList.toggle("dark", isDark.value);
  getCurrentWindow().setTheme(isDark.value ? "dark" as Theme : "light" as Theme);
}

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem("dbx-theme", isDark.value ? "dark" : "light");
  applyTheme();
}

import { open } from "@tauri-apps/plugin-shell";

function openGitHub() {
  open("https://github.com/t8y2/dbx");
}

async function checkUpdates(options: { silent?: boolean } = {}) {
  if (checkingUpdates.value) return;
  checkingUpdates.value = true;
  updateCheckMessage.value = "";
  try {
    const info = await api.checkForUpdates();
    updateInfo.value = info;
    if (info.update_available) {
      showUpdateDialog.value = true;
    } else if (!options.silent) {
      updateCheckMessage.value = t("updates.upToDate", { version: info.current_version });
      showUpdateDialog.value = true;
    }
  } catch (e: any) {
    if (!options.silent) {
      updateCheckMessage.value = formatUpdateError(String(e));
      showUpdateDialog.value = true;
    }
  } finally {
    checkingUpdates.value = false;
  }
}

function formatUpdateError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("403") || lower.includes("rate limit")) {
    return t("updates.rateLimited");
  }
  return t("updates.failed", { error: message });
}

function openLatestRelease() {
  const url = updateInfo.value?.release_url || latestReleaseUrl;
  open(url);
}

function isQueryEditorTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-query-editor-root]");
}

function handleKeydown(e: KeyboardEvent) {
  if (isCloseTabShortcut(e)) {
    e.preventDefault();
    if (queryStore.activeTabId) {
      queryStore.closeTab(queryStore.activeTabId);
    }
    return;
  }

  if (
    activeTab.value?.mode === "query"
    && isExecuteSqlShortcut(e)
    && isQueryEditorTarget(e.target)
  ) {
    e.preventDefault();
    e.stopPropagation();
    tryExecute();
  }
}

onMounted(() => {
  applyTheme();
  connectionStore.initFromDisk();
  settingsStore.initAiConfig();
  window.addEventListener("keydown", handleKeydown, true);
  setupFileDrop();
  checkUpdates({ silent: true });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, true);
});

const DB_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".duckdb"];

function getDbType(path: string): "sqlite" | "duckdb" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".duckdb")) return "duckdb";
  if (DB_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "sqlite";
  return null;
}

async function setupFileDrop() {
  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    for (const path of event.payload.paths) {
      const dbType = getDbType(path);
      if (!dbType) continue;
      const name = path.split("/").pop()?.split("\\").pop() || path;
      const config: ConnectionConfig = {
        id: crypto.randomUUID(),
        name,
        db_type: dbType,
        driver_profile: dbType,
        driver_label: dbType === "duckdb" ? "DuckDB" : "SQLite",
        url_params: "",
        host: path,
        port: 0,
        username: "",
        password: "",
      };
      connectionStore.addConnection(config);
      connectionStore.connect(config);
      toast(t("welcome.fileOpened", { name }));
    }
  });
}
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <!-- Toolbar -->
      <div class="h-10 flex items-center gap-1 px-2 border-b bg-muted/30 shrink-0">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="showConnectionDialog = true">
              <DatabaseZap class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('toolbar.newConnection') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="newQuery" :disabled="!connectionStore.activeConnectionId">
              <FilePlus2 class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('toolbar.newQuery') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="h-7 w-7"
              :disabled="!activeTab || activeTab.isExecuting"
              @click="tryExecute()"
            >
              <Loader2 v-if="activeTab?.isExecuting" class="h-4 w-4 animate-spin" />
              <Play v-else class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('toolbar.executeShortcut') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="h-7 w-7"
              :disabled="!activeTab || activeTab.mode !== 'query' || activeTab.isExecuting || !activeTab.sql.trim()"
              @click="formatActiveSql"
            >
              <AlignLeft class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('toolbar.formatSql') }}</TooltipContent>
        </Tooltip>

        <div class="flex-1" />

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="checkingUpdates" @click="checkUpdates()">
              <Loader2 v-if="checkingUpdates" class="h-4 w-4 animate-spin" />
              <CloudDownload v-else class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('updates.check') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :class="{ 'bg-accent': showHistory }" @click="showHistory = !showHistory">
              <History class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('history.title') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="toggleTheme">
              <Moon v-if="!isDark" class="h-4 w-4" />
              <Sun v-else class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ isDark ? 'Light' : 'Dark' }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="toggleLocale">
              <Globe class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('common.language') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="openGitHub">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.627 0 12 0z"/></svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>
      </div>

      <!-- Main Content -->
      <div class="flex-1 flex min-h-0">
      <Splitpanes class="flex-1 min-h-0 min-w-0">
        <!-- Sidebar -->
        <Pane :size="20" :min-size="10" :max-size="40">
          <div class="h-full flex flex-col overflow-hidden">
            <div class="h-8 flex items-center px-3 text-xs font-medium text-muted-foreground border-b bg-muted/20">
              {{ t('sidebar.connections') }}
              <span class="flex-1" />
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="ghost" size="icon" class="h-5 w-5" @click="connectionStore.importConnectionsFromFile()">
                    <Upload class="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t('sidebar.import') }}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="ghost" size="icon" class="h-5 w-5" @click="connectionStore.exportConnectionsToFile()">
                    <Download class="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t('sidebar.export') }}</TooltipContent>
              </Tooltip>
            </div>
            <div class="flex-1 overflow-y-auto">
              <ConnectionTree />
            </div>
          </div>
        </Pane>

        <!-- Editor + Results -->
        <Pane :size="80">
          <div class="h-full flex flex-col min-w-0">
          <!-- Tabs Bar -->
          <div v-if="queryStore.tabs.length > 0" class="h-8 flex items-center border-b bg-muted/20 overflow-x-auto shrink-0">
            <ContextMenu
              v-for="tab in queryStore.tabs"
              :key="tab.id"
            >
              <ContextMenuTrigger as-child>
                <div
                  class="group flex min-w-0 items-center gap-1 px-3 h-full text-xs cursor-pointer border-r hover:bg-accent transition-colors whitespace-nowrap"
                  :class="{ 'bg-background font-medium': tab.id === queryStore.activeTabId }"
                  @click="queryStore.activeTabId = tab.id"
                >
                  <span v-if="connectionColor(tab.connectionId)" class="h-4 w-1 rounded-full shrink-0" :style="{ backgroundColor: connectionColor(tab.connectionId) }" />
                  <span class="min-w-0 truncate">{{ tabDisplayTitle(tab) }}</span>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <button
                        class="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground focus:opacity-100"
                        :class="tab.pinned ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'"
                        @click.stop="queryStore.togglePinnedTab(tab.id)"
                      >
                        <Pin class="h-3 w-3" :class="{ 'fill-current': tab.pinned }" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{{ tab.pinned ? t('contextMenu.unpin') : t('contextMenu.pin') }}</TooltipContent>
                  </Tooltip>
                  <button
                    class="rounded hover:bg-muted-foreground/20 p-0.5"
                    @click.stop="queryStore.closeTab(tab.id)"
                  >
                    <X class="h-3 w-3" />
                  </button>
                </div>
              </ContextMenuTrigger>

              <ContextMenuContent class="w-44">
                <ContextMenuItem @click="queryStore.togglePinnedTab(tab.id)">
                  <Pin class="w-3.5 h-3.5 mr-2" :class="{ 'fill-current': tab.pinned }" />
                  {{ tab.pinned ? t('contextMenu.unpin') : t('contextMenu.pin') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @click="queryStore.closeTab(tab.id)">
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeTab') }}
                </ContextMenuItem>
                <ContextMenuItem
                  :disabled="queryStore.tabs.length <= 1"
                  @click="queryStore.closeOtherTabs(tab.id)"
                >
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeOtherTabs') }}
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" @click="queryStore.closeAllTabs">
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeAllTabs') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>

          <!-- Editor Panel -->
          <div v-if="activeTab" class="flex flex-col flex-1 min-h-0">
            <div v-if="activeTab.mode === 'query'" class="h-8 shrink-0 border-b bg-background/80 px-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Server class="h-3.5 w-3.5 shrink-0" />
              <span v-if="activeConnection?.color" class="h-4 w-1 rounded-full shrink-0" :style="{ backgroundColor: activeConnection.color }" />
              <Select
                :model-value="activeConnectionValue"
                @update:model-value="changeActiveConnection"
              >
                <SelectTrigger class="h-6 w-auto max-w-48 border-0 bg-transparent px-1 text-xs font-medium text-foreground shadow-none focus:ring-0">
                  <SelectValue :placeholder="t('editor.selectConnection')">
                    {{ connectionDisplayName(activeConnectionValue) }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="connection in connectionStore.connections"
                    :key="connection.id"
                    :value="connection.id"
                  >
                    <div class="flex items-center gap-2">
                      <span v-if="connection.color" class="h-3.5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color }" />
                      <span>{{ connection.name }}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <span class="text-muted-foreground/50">/</span>
              <span class="shrink-0">{{ connectionDriverLabel(activeConnection) }}</span>
              <span class="text-muted-foreground/50">/</span>
              <Select
                :model-value="activeDatabaseValue"
                @update:model-value="changeActiveDatabase"
                @update:open="(open: boolean) => { if (open && activeConnection) loadDatabaseOptions(activeConnection.id).catch(() => {}) }"
              >
                <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
                  <SelectValue :placeholder="loadingDatabaseOptions[activeConnection?.id || ''] ? t('common.loading') : t('editor.selectDatabase')">
                    {{ databaseDisplayName(activeDatabaseValue) }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="database in activeDatabaseOptions"
                    :key="database"
                    :value="database"
                  >
                    {{ databaseDisplayName(database) }}
                  </SelectItem>
                  <SelectItem v-if="!activeDatabaseOptions.length && activeDatabaseValue" :value="activeDatabaseValue">
                    {{ databaseDisplayName(activeDatabaseValue) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <template v-for="item in activeTabContext.slice(2)" :key="item">
                <span class="text-muted-foreground/50">/</span>
                <span class="min-w-0 truncate">{{ item }}</span>
              </template>
              <span class="flex-1" />
              <div v-if="activeTab.tableMeta" class="flex min-w-0 items-center gap-1">
                <Table2 class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ activeTab.tableMeta.columns.length }} {{ t('tree.columns') }}</span>
              </div>
            </div>
            <!-- Query mode: editor + results -->
            <template v-if="activeTab.mode === 'query'">
              <Splitpanes horizontal class="flex-1">
                <Pane :size="40" :min-size="15">
                  <div class="h-full flex flex-col">
                    <QueryEditor
                      class="flex-1"
                      :model-value="activeTab.sql"
                      :dialect="editorDialect"
                      :format-dialect="activeSqlFormatDialect"
                      :format-request-id="formatSqlRequestId"
                      @update:model-value="onEditorUpdate"
                      @selection-change="onEditorSelectionChange"
                      @format-error="onFormatSqlError"
                      @execute="tryExecute"
                    />
                  </div>
                </Pane>
                <Pane :size="60" :min-size="20">
                  <div class="h-full flex flex-col">
                    <AiAssistant
                      :tab="activeTab"
                      :connection="activeConnection"
                      @replace-sql="replaceActiveSql"
                      @append-sql="appendActiveSql"
                    />
                    <DataGrid v-if="activeTab.result" :key="activeTab.id" class="flex-1 min-h-0" :result="activeTab.result" :sql="activeTab.lastExecutedSql || activeTab.sql" />
                    <div v-else class="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm">
                      {{ t('editor.pressToExecute') }}
                    </div>
                  </div>
                </Pane>
              </Splitpanes>
            </template>

            <!-- Data mode: full-height grid -->
            <template v-else-if="activeTab.mode === 'data'">
              <div class="flex-1 min-h-0">
                <DataGrid
                  v-if="activeTab.result"
                  :key="activeTab.id"
                  :result="activeTab.result"
                  :sql="activeTab.sql"
                  :editable="!!activeTab.tableMeta?.primaryKeys?.length"
                  :database-type="activeConnection?.db_type"
                  :connection-id="activeTab.connectionId"
                  :database="activeTab.database"
                  :table-meta="activeTab.tableMeta"
                  :on-execute-sql="onExecuteSql"
                  @reload="onReloadData"
                  @paginate="onPaginate"
                  @sort="onSort"
                />
                <div v-else-if="activeTab.isExecuting" class="h-full flex items-center justify-center text-muted-foreground text-sm">
                  <Loader2 class="h-5 w-5 animate-spin mr-2" /> {{ t('common.loading') }}
                </div>
              </div>
            </template>

            <!-- Redis mode: key browser -->
            <template v-else-if="activeTab.mode === 'redis'">
              <div class="flex-1 min-h-0">
                <RedisKeyBrowser
                  :key="activeTab.id"
                  :connection-id="activeTab.connectionId"
                  :db="Number(activeTab.database)"
                />
              </div>
            </template>

            <!-- MongoDB mode: document browser -->
            <template v-else-if="activeTab.mode === 'mongo'">
              <div class="flex-1 min-h-0">
                <MongoDocBrowser
                  :key="activeTab.id"
                  :connection-id="activeTab.connectionId"
                  :database="activeTab.database"
                  :collection="activeTab.sql"
                />
              </div>
            </template>
          </div>

          <!-- Empty State -->
          <div v-else class="flex-1 overflow-auto bg-background">
            <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center gap-6 px-8 py-10">
              <div class="grid grid-cols-3 gap-3">
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Database class="h-3.5 w-3.5" /> {{ t('welcome.connections') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.total }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck class="h-3.5 w-3.5" /> {{ t('welcome.connected') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.connected }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles class="h-3.5 w-3.5" /> {{ t('welcome.databaseTypes') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.types }}</div>
                </div>
              </div>

              <div class="grid grid-cols-[1.2fr_0.8fr] gap-4">
                <div class="rounded-lg border">
                  <div class="flex items-center justify-between border-b px-4 py-3">
                    <div class="text-sm font-medium">{{ t('welcome.quickConnections') }}</div>
                  </div>
                  <div class="divide-y">
                    <button
                      v-for="connection in recentConnections"
                      :key="connection.id"
                      class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                      @click="openConnectionQuery(connection.id)"
                    >
                      <DatabaseIcon :db-type="connectionIconType(connection)" class="h-4 w-4" />
                      <span v-if="connection.color" class="h-5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color }" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium">{{ connection.name }}</div>
                        <div class="truncate text-xs text-muted-foreground">
                          {{ connectionDriverLabel(connection) }} · {{ connection.host || connection.database || 'local' }}{{ connection.port ? ':' + connection.port : '' }}
                        </div>
                      </div>
                      <FilePlus2 class="h-4 w-4 text-muted-foreground" />
                    </button>
                    <div v-if="recentConnections.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
                      {{ t('sidebar.noConnections') }}
                    </div>
                  </div>
                </div>

                <div class="rounded-lg border">
                  <div class="border-b px-4 py-3">
                    <div class="text-sm font-medium">{{ t('welcome.shortcuts') }}</div>
                  </div>
                  <div class="grid gap-1 p-2">
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="showConnectionDialog = true">
                      <Plus class="h-4 w-4" /> {{ t('toolbar.newConnection') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" :disabled="!connectionStore.activeConnectionId" @click="newQuery">
                      <FilePlus2 class="h-4 w-4" /> {{ t('toolbar.newQuery') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="showHistory = true">
                      <History class="h-4 w-4" /> {{ t('history.title') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="connectionStore.importConnectionsFromFile()">
                      <Upload class="h-4 w-4" /> {{ t('sidebar.import') }}
                    </button>
                    <div class="mt-2 rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                      <Search class="mr-1 inline h-3.5 w-3.5" />
                      {{ t('welcome.tip') }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </Pane>
      </Splitpanes>

      <!-- History Panel (fixed width, outside Splitpanes) -->
      <div v-if="showHistory" class="w-72 h-full shrink-0 border-l bg-background">
        <QueryHistory @restore="onHistoryRestore" @close="showHistory = false" />
      </div>
      </div>

      <ConnectionDialog
        v-model:open="showConnectionDialog"
        :edit-config="editConfig"
        @connect-started="onConnectionConnectStarted"
        @connect-succeeded="onConnectionConnectSucceeded"
        @connect-failed="onConnectionConnectFailed"
      />
      <DangerConfirmDialog v-model:open="showDangerDialog" :sql="dangerSql" @confirm="onDangerConfirm" />
      <Dialog v-model:open="showUpdateDialog">
        <DialogContent class="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{{ updateInfo?.update_available ? t('updates.availableTitle') : t('updates.title') }}</DialogTitle>
          </DialogHeader>
          <div class="space-y-3 text-sm">
            <p v-if="updateInfo?.update_available">
              {{ t('updates.availableMessage', { current: updateInfo.current_version, latest: updateInfo.latest_version }) }}
            </p>
            <p v-else class="text-muted-foreground">
              {{ updateCheckMessage || t('updates.upToDate', { version: updateInfo?.current_version || '' }) }}
            </p>
            <div v-if="updateInfo?.update_available && updateInfo.release_notes" class="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
              {{ updateInfo.release_notes }}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="showUpdateDialog = false">{{ t('dangerDialog.cancel') }}</Button>
            <Button v-if="updateInfo?.update_available || updateCheckMessage" @click="openLatestRelease">{{ t('updates.openRelease') }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- Global Toast -->
      <Transition name="toast">
        <div v-if="toastVisible" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg">
          {{ toastMessage }}
        </div>
      </Transition>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from, .toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
