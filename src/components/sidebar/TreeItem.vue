<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Database, Table, Columns3, Eye, ChevronRight, ChevronDown,
  Loader2, FolderOpen, Trash2, TerminalSquare, RefreshCw,
  Copy, TableProperties, Key, Link, Zap, ListTree, Pencil, Plug, Unplug,
  Pin, ArrowRightLeft, Download, FileCode, Network,
} from "lucide-vue-next";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import type { TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/tauri";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

const props = defineProps<{
  node: TreeNode;
  depth: number;
}>();

const sqlFileUnsupportedTypes = new Set(["redis", "mongodb", "elasticsearch"]);
const diagramSupportedTypes = new Set(["mysql", "postgres", "sqlite", "sqlserver", "oracle", "redshift"]);

function quoteIdent(name: string): string {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return config?.db_type === "mysql"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

function getIconInfo(node: TreeNode): { icon: any; colorClass: string } | null {
  switch (node.type) {
    case "connection":
      return null;
    case "database":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "column":
      return { icon: Columns3, colorClass: "text-muted-foreground" };
    case "group-columns":
      return { icon: ListTree, colorClass: "text-green-400" };
    case "group-indexes":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-fkeys":
      return { icon: Link, colorClass: "text-blue-400" };
    case "group-triggers":
      return { icon: Zap, colorClass: "text-orange-400" };
    case "index":
      return { icon: Key, colorClass: "text-amber-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "mongo-db":
      return { icon: Database, colorClass: "text-green-500" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}

const leafTypes: Set<TreeNodeType> = new Set(["column", "index", "fkey", "trigger", "redis-db", "mongo-collection"]);
const groupTypes: Set<TreeNodeType> = new Set(["group-columns", "group-indexes", "group-fkeys", "group-triggers"]);
const pinnableTypes: Set<TreeNodeType> = new Set([
  "database",
  "schema",
  "table",
  "view",
  "redis-db",
  "mongo-db",
  "mongo-collection",
]);

function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

async function toggle() {
  const node = props.node;
  if (node.isLoading) return;
  if (node.isExpanded) { node.isExpanded = false; return; }

  try {
  if (node.type === "connection" && node.connectionId) {
    const config = connectionStore.getConfig(node.connectionId);
    if (config?.db_type === "redis") {
      await connectionStore.loadRedisDatabases(node.connectionId);
    } else if (config?.db_type === "mongodb" || config?.db_type === "elasticsearch") {
      await connectionStore.loadMongoDatabases(node.connectionId);
    } else {
      await connectionStore.loadDatabases(node.connectionId);
    }
  } else if (node.type === "redis-db" && node.connectionId && node.database) {
    const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "Redis"}:db${node.database}`;
    queryStore.createTab(node.connectionId, node.database, tabTitle, "redis");
  } else if (node.type === "mongo-db" && node.connectionId && node.database) {
    await connectionStore.loadMongoCollections(node.connectionId, node.database);
  } else if (node.type === "mongo-collection" && node.connectionId && node.database) {
    const tabTitle = `${node.database}.${node.label}`;
    const tab = queryStore.createTab(node.connectionId, node.database, tabTitle, "mongo");
    queryStore.updateSql(tab, node.label);
  } else if (node.type === "database" && node.connectionId && node.database) {
    const config = connectionStore.getConfig(node.connectionId);
    if (config?.db_type === "postgres" || config?.db_type === "sqlserver") {
      await connectionStore.loadSchemas(node.connectionId, node.database);
    } else {
      await connectionStore.loadTables(node.connectionId, node.database);
    }
  } else if (node.type === "schema" && node.connectionId && node.database && node.schema) {
    await connectionStore.loadTables(node.connectionId, node.database, node.schema);
  } else if ((node.type === "table" || node.type === "view") && node.connectionId && node.database) {
    await connectionStore.loadTableGroups(node.connectionId, node.database, node.label, node.schema);
  } else if (node.type === "group-columns" && node.connectionId && node.database && node.tableName) {
    await connectionStore.loadColumns(node.connectionId, node.database, node.tableName, node.schema);
  } else if (node.type === "group-indexes" && node.connectionId && node.database && node.tableName) {
    await connectionStore.loadIndexes(node.connectionId, node.database, node.tableName, node.schema);
  } else if (node.type === "group-fkeys" && node.connectionId && node.database && node.tableName) {
    await connectionStore.loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema);
  } else if (node.type === "group-triggers" && node.connectionId && node.database && node.tableName) {
    await connectionStore.loadTriggers(node.connectionId, node.database, node.tableName, node.schema);
  }
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
  }
}

function onClick() {
  const node = props.node;
  if (node.type === "table" || node.type === "view") {
    openData();
    toggle();
  } else if (node.type === "redis-db") {
    toggle();
  } else if (node.type === "mongo-collection") {
    toggle();
  } else if (canExpand) {
    toggle();
  }
}

async function openData() {
  const node = props.node;
  if (!(node.type === "table" || node.type === "view") || !node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  const tabId = queryStore.createTab(node.connectionId, node.database, node.label, "data");
  queryStore.setExecuting(tabId, true);

  try {
    await connectionStore.ensureConnected(node.connectionId);
    if (!config) throw new Error("Connection config not found");

    const qualifiedName = (config.db_type === "postgres" || config.db_type === "oracle" || config.db_type === "sqlserver") && node.schema
      ? `${quoteIdent(node.schema)}.${quoteIdent(node.label)}`
      : quoteIdent(node.label);

    const querySchema = node.schema || node.database;
    const columns = await api.getColumns(node.connectionId, node.database, querySchema, node.label);
    const pks = columns.filter((c) => c.is_primary_key).map((c) => c.name);
    const order = pks.length ? ` ORDER BY ${pks.map((pk) => `${quoteIdent(pk)} ASC`).join(", ")}` : "";
    let sql: string;
    if (config.db_type === "oracle") {
      sql = `SELECT * FROM ${qualifiedName}${order} FETCH FIRST 100 ROWS ONLY`;
    } else if (config.db_type === "sqlserver") {
      sql = `SELECT TOP 100 * FROM ${qualifiedName}${order}`;
    } else {
      sql = `SELECT * FROM ${qualifiedName}${order} LIMIT 100;`;
    }
    queryStore.updateSql(tabId, sql);
    queryStore.setTableMeta(tabId, {
      schema: node.schema,
      tableName: node.label,
      columns,
      primaryKeys: pks,
    });

    await queryStore.executeTabSql(tabId, sql);
  } catch (e: any) {
    queryStore.setErrorResult(tabId, e);
  }
}

async function newQuery() {
  const node = props.node;
  if (!node.connectionId) return;
  await connectionStore.ensureConnected(node.connectionId);
  connectionStore.activeConnectionId = node.connectionId;
  queryStore.createTab(node.connectionId, node.database || "", undefined, "query");
}

async function refresh() {
  const node = props.node;
  node.isExpanded = false;
  node.children = [];
  await toggle();
}

const showDeleteConfirm = ref(false);

function deleteConnection() {
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  const node = props.node;
  if (node.connectionId) {
    try {
      await connectionStore.disconnect(node.connectionId);
      await connectionStore.removeConnection(node.connectionId);
    } catch (e: any) {
      toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
    }
  }
}

function copyName() {
  navigator.clipboard.writeText(props.node.label);
}

async function exportStructure() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const ddl = await api.getTableDdl(node.connectionId, node.database, node.schema || node.database, node.label);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: `${node.label}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (path) await writeTextFile(path, ddl + "\n");
  } catch (e: any) {
    console.error("Export structure failed:", e);
  }
}

async function exportData(format: "csv" | "json" | "sql") {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return;

  try {
    await connectionStore.ensureConnected(node.connectionId);
    const qualifiedName = (config.db_type === "postgres" || config.db_type === "oracle" || config.db_type === "sqlserver") && node.schema
      ? `${quoteIdent(node.schema)}.${quoteIdent(node.label)}`
      : quoteIdent(node.label);
    const result = await api.executeQuery(node.connectionId, node.database, `SELECT * FROM ${qualifiedName}`);

    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    let content: string;
    let ext: string;

    if (format === "csv") {
      ext = "csv";
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header = result.columns.map(esc).join(",");
      const body = result.rows.map((row) => row.map((c) => esc(c === null ? "" : String(c))).join(",")).join("\n");
      content = `${header}\n${body}`;
    } else if (format === "json") {
      ext = "json";
      const data = result.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });
      content = JSON.stringify(data, null, 2);
    } else {
      ext = "sql";
      const cols = result.columns.map((c) => quoteIdent(c)).join(", ");
      const lines = result.rows.map((row) => {
        const vals = row.map((v) => {
          if (v === null) return "NULL";
          if (typeof v === "number" || typeof v === "boolean") return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        }).join(", ");
        return `INSERT INTO ${qualifiedName} (${cols}) VALUES (${vals});`;
      });
      content = lines.join("\n");
    }

    const path = await save({ defaultPath: `${node.label}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (path) await writeTextFile(path, content);
  } catch (e: any) {
    console.error("Export data failed:", e);
  }
}

function editConnection() {
  if (props.node.connectionId) {
    connectionStore.startEditing(props.node.connectionId);
  }
}

function disconnectConnection() {
  if (props.node.connectionId) {
    connectionStore.disconnect(props.node.connectionId);
    props.node.isExpanded = false;
    props.node.children = [];
  }
}

function openTransfer() {
  if (props.node.connectionId) {
    connectionStore.transferSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}

function openSchemaDiff() {
  if (props.node.connectionId) {
    connectionStore.schemaDiffSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}

function openSqlFileExecution() {
  if (props.node.connectionId) {
    connectionStore.sqlFileSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}

function openDiagram() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.diagramSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.type === "table" ? node.label : undefined,
  };
}

const canExpand = !leafTypes.has(props.node.type);
const canPin = computed(() => pinnableTypes.has(props.node.type));
const canOpenSqlFileExecution = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return !!config && !sqlFileUnsupportedTypes.has(config.db_type);
});
const canOpenDiagram = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return !!props.node.database && !!config && diagramSupportedTypes.has(config.db_type);
});
const isPinned = computed(() => props.node.pinned || connectionStore.isTreeNodePinned(props.node.id));
const hasTypeMenu = computed(() => {
  const t = props.node.type;
  return t === "connection" || t === "database" || t === "schema" || t === "table" || t === "view" || isGroupLabel(props.node);
});
const columnComment = computed(() => props.node.type === "column" && props.node.meta && "comment" in props.node.meta ? (props.node.meta as any).comment : null);
const paddingLeft = `${props.depth * 16 + 8}px`;
const isConnected = computed(() =>
  props.node.type === "connection" && !!props.node.connectionId && connectionStore.connectedIds.has(props.node.connectionId)
);

function connectionIconType(connectionId?: string) {
  const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
  return config?.driver_profile || config?.db_type || "postgres";
}

const connectionColor = computed(() => {
  const connectionId = props.node.connectionId;
  return connectionId ? connectionStore.getConfig(connectionId)?.color || "" : "";
});

const CHILDREN_PAGE_SIZE = 100;
const displayLimit = ref(CHILDREN_PAGE_SIZE);

const visibleChildren = computed(() => {
  if (!props.node.children) return [];
  return props.node.children.slice(0, displayLimit.value);
});

const hasMoreChildren = computed(() => (props.node.children?.length ?? 0) > displayLimit.value);

const remainingCount = computed(() =>
  (props.node.children?.length ?? 0) - displayLimit.value
);

function togglePin() {
  connectionStore.toggleTreeNodePin(props.node.id);
}

async function showMore() {
  if ((props.node.children?.length ?? 0) > displayLimit.value) {
    displayLimit.value += CHILDREN_PAGE_SIZE;
  }
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div>
        <div
          class="group flex min-w-0 items-center gap-1.5 py-1 px-2 rounded-sm cursor-pointer hover:bg-accent transition-colors"
          :style="{ paddingLeft }"
          @click="onClick"
        >
          <template v-if="canExpand">
            <Loader2 v-if="node.isLoading" class="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground" />
            <ChevronDown v-else-if="node.isExpanded" class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <ChevronRight v-else class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          </template>
          <span v-else class="w-3.5 h-3.5 shrink-0" />
          <DatabaseIcon v-if="node.type === 'connection'" :db-type="connectionIconType(node.connectionId)" class="w-3.5 h-3.5 shrink-0" />
          <component v-else :is="getIconInfo(node)?.icon || Database" class="w-3.5 h-3.5 shrink-0" :class="getIconInfo(node)?.colorClass" />
          <span v-if="node.type === 'connection'" class="h-3 w-1.5 rounded-full shrink-0" :style="{ backgroundColor: connectionColor || '#9ca3af' }" />
          <span class="min-w-0 flex-1 truncate">{{ isGroupLabel(node) ? t(node.label) : node.label }}</span>
          <span v-if="columnComment" class="truncate text-muted-foreground/60 text-[10px] max-w-[40%]">{{ columnComment }}</span>
          <span v-if="node.type === 'connection' && node.connectionId && connectionStore.connectedIds.has(node.connectionId)" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <button
            v-if="canPin"
            class="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground focus:opacity-100"
            :class="isPinned ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'"
            :title="isPinned ? t('contextMenu.unpin') : t('contextMenu.pin')"
            @click.stop="togglePin"
          >
            <Pin class="w-3 h-3" :class="{ 'fill-current': isPinned }" />
          </button>
        </div>
        <template v-if="node.isExpanded && node.children">
          <TreeItem v-for="child in visibleChildren" :key="child.id" :node="child" :depth="depth + 1" />
          <div
            v-if="hasMoreChildren"
            class="flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-accent text-xs text-muted-foreground"
            :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
            @click="showMore"
          >
            <Loader2 v-if="node.isLoading" class="w-3 h-3 shrink-0 animate-spin" />
            <span>{{ t('sidebar.showMore', { count: Math.min(CHILDREN_PAGE_SIZE, remainingCount) }) }}</span>
          </div>
        </template>
      </div>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-auto min-w-36">
      <ContextMenuItem v-if="canPin" @click="togglePin">
        <Pin class="w-4 h-4" :class="{ 'fill-current': isPinned }" />
        {{ isPinned ? t('contextMenu.unpin') : t('contextMenu.pin') }}
      </ContextMenuItem>
      <ContextMenuSeparator v-if="canPin && hasTypeMenu" />

      <template v-if="node.type === 'connection'">
        <ContextMenuItem v-if="!isConnected" @click="toggle">
          <Plug class="w-4 h-4" /> {{ t('contextMenu.openConnection') }}
        </ContextMenuItem>
        <ContextMenuItem v-else @click="disconnectConnection">
          <Unplug class="w-4 h-4" /> {{ t('contextMenu.closeConnection') }}
        </ContextMenuItem>
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t('contextMenu.newQuery') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenSqlFileExecution" @click="openSqlFileExecution">
          <FileCode class="w-4 h-4" /> {{ t('sqlFile.title') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t('contextMenu.refreshChildren') }}
        </ContextMenuItem>
        <ContextMenuItem @click="editConnection">
          <Pencil class="w-4 h-4" /> {{ t('contextMenu.editConnection') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem class="text-destructive" @click="deleteConnection">
          <Trash2 class="w-4 h-4" /> {{ t('contextMenu.deleteConnection') }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'database' || node.type === 'schema'">
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t('contextMenu.newQuery') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenSqlFileExecution" @click="openSqlFileExecution">
          <FileCode class="w-4 h-4" /> {{ t('sqlFile.title') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenDiagram" @click="openDiagram">
          <Network class="w-4 h-4" /> {{ t('diagram.open') }}
        </ContextMenuItem>
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t('contextMenu.refreshChildren') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @click="openTransfer">
          <ArrowRightLeft class="w-4 h-4" /> {{ t('transfer.dataTransfer') }}
        </ContextMenuItem>
        <ContextMenuItem @click="openSchemaDiff">
          <ArrowRightLeft class="w-4 h-4" /> {{ t('diff.title') }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'table' || node.type === 'view'">
        <ContextMenuItem @click="openData">
          <TableProperties class="w-4 h-4" /> {{ t('contextMenu.viewData') }}
        </ContextMenuItem>
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t('contextMenu.newQuery') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenDiagram" @click="openDiagram">
          <Network class="w-4 h-4" /> {{ t('diagram.open') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Download class="w-4 h-4" /> {{ t('contextMenu.exportData') }}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem @click="exportData('csv')">CSV</ContextMenuItem>
            <ContextMenuItem @click="exportData('json')">JSON</ContextMenuItem>
            <ContextMenuItem @click="exportData('sql')">SQL INSERT</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem @click="exportStructure">
          <FileCode class="w-4 h-4" /> {{ t('contextMenu.exportStructure') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t('contextMenu.refreshChildren') }}
        </ContextMenuItem>
      </template>

      <template v-if="isGroupLabel(node)">
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t('contextMenu.refreshChildren') }}
        </ContextMenuItem>
      </template>

      <ContextMenuSeparator v-if="hasTypeMenu" />
      <ContextMenuItem @click="copyName">
        <Copy class="w-4 h-4" /> {{ t('contextMenu.copyName') }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>

  <Dialog v-model:open="showDeleteConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t('contextMenu.confirmDeleteTitle') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('contextMenu.confirmDeleteMessage', { name: node.label }) }}</p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteConfirm = false">{{ t('dangerDialog.cancel') }}</Button>
        <Button variant="destructive" @click="showDeleteConfirm = false; confirmDelete()">{{ t('contextMenu.deleteConnection') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
