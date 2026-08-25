<script setup lang="ts">
// 表信息面板（DDL/字段/索引/外键/触发器），由对象浏览器内嵌侧栏与分离子窗口共用。
// 数据直接走后端 API（子窗口与主窗口共享同一 Rust 后端）；
// 分离/合并交互与工具栏面板一致：内嵌态可拖拽/点击分离，子窗口态可合并回主窗口。
import { computed, ref, watch, type Component } from "vue";
import { Code2, Copy, KeyRound, Link2, ListTree, Loader2, PictureInPicture2, PencilRuler, RotateCcw, Search, TableProperties, WrapText, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import DetachedWindowControls from "@/components/layout/DetachedWindowControls.vue";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useToast } from "@/composables/useToast";
import { usePanelDetachDrag } from "@/composables/usePanelDetachDrag";
import { useSettingsStore } from "@/stores/settingsStore";
import * as api from "@/lib/backend/api";
import { loadObjectDdl, type ObjectDdlRequest } from "@/lib/metadata/objectDdlCache";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { translateBackendError } from "@/i18n/backend-errors";
import { copyToClipboard } from "@/lib/common/clipboard";
import { isMacOS } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { getDetachedPanelFromLocation } from "@/lib/detached/detachedPanel";
import { effectiveDatabaseTypeForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { supportsTableStructureEditing } from "@/lib/database/databaseFeatureSupport";
import { filterObjectBrowserTableColumns } from "@/lib/table/objectBrowserTableInfo";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";
import { gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, ObjectSourceKind, TableInfoTab, TriggerInfo } from "@/types/database";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  catalog?: string;
  /** 对象浏览器当前选择的 schema（tableSchema 缺省时的回退）。 */
  fallbackSchema?: string;
  tableName: string;
  /** 表自身的 schema（ObjectBrowserRow.schema），可能为空。 */
  tableSchema?: string;
  /** ObjectBrowserRow.type（TABLE/VIEW/MATERIALIZED_VIEW 等）。 */
  tableType: string;
  /** 打开/换表时的初始页签，缺省沿用当前页签。 */
  initialTab?: TableInfoTab;
  /** 是否允许从当前宿主再次分离；对象浏览器独立窗口内禁用嵌套分离。 */
  detachable?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  /** 拖拽/点击面板头部分离为独立窗口（仅主窗口内嵌时触发）。 */
  detach: [position: { x: number; y: number }];
  /** 合并回主窗口（仅独立窗口模式显示）。 */
  dock: [];
  /** 打开表结构编辑器（内嵌态由对象浏览器处理，子窗口态转发主窗口）。 */
  openStructure: [payload: { tab: TableInfoTab }];
  /** 当前页签变化（内嵌态由对象浏览器记录，用于分离快照同步）。 */
  tabChange: [tab: TableInfoTab];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const settingsStore = useSettingsStore();

// 当前是否运行在独立子窗口中。
const isDetachedWindow = getDetachedPanelFromLocation() !== null;
const isMac = isMacOS();
const isDesktop = isTauriRuntime();

function onDetachClick(event: MouseEvent) {
  emit("detach", { x: event.screenX, y: event.screenY });
}

/** 独立窗口为无边框，双击面板头部切换最大化（双击按钮时忽略）。 */
async function onHeaderDblclick(event: MouseEvent) {
  if (!isDetachedWindow) return;
  if ((event.target as HTMLElement | null)?.closest("button")) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  } catch (error) {
    console.error("[detached-panel] toggle maximize failed", error);
  }
}

const { onHeaderPointerDown } = usePanelDetachDrag({
  isDetached: () => isDetachedWindow || props.detachable === false,
  title: () => `${t("grid.tableInfo")} - ${props.tableName}`,
  onDetach: (position) => emit("detach", position),
});

const tableInfoTab = ref<TableInfoTab>(props.initialTab ?? "ddl");
const tableColumns = ref<ColumnInfo[]>([]);
const tableColumnsLoading = ref(false);
const tableColumnsLoaded = ref(false);
const tableDdlContent = ref("");
const tableDdlLoading = ref(false);
const tableDdlLoaded = ref(false);
const tableIndexes = ref<IndexInfo[]>([]);
const tableIndexesLoading = ref(false);
const tableIndexesLoaded = ref(false);
const tableForeignKeys = ref<ForeignKeyInfo[]>([]);
const tableForeignKeysLoading = ref(false);
const tableForeignKeysLoaded = ref(false);
const tableTriggers = ref<TriggerInfo[]>([]);
const tableTriggersLoading = ref(false);
const tableTriggersLoaded = ref(false);
const tableInfoSearchQuery = ref("");
const tableInfoDdlPreRef = ref<HTMLPreElement | null>(null);
const sidePanelGuard = createSidePanelRequestGuard();

const effectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const tableMetadataCapabilities = computed(() => getTableMetadataCapabilities(effectiveDatabaseType.value));
const isGaussdbM = computed(() => effectiveDatabaseType.value === "gaussdb" && props.connection.driver_profile?.toLowerCase() === "gaussdb-m");
const tableStructureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const canOpenTableStructureEditor = computed(() => props.tableType === "TABLE" && supportsTableStructureEditing(tableStructureDatabaseType.value));

function gaussdbMColumnType(dataType: string): string {
  if (isGaussdbM.value) {
    return gaussdbMTypeDisplayName(dataType);
  }
  return dataType;
}

function toggleTableDdlWordWrap() {
  settingsStore.updateEditorSettings({
    tableDdlWordWrap: !settingsStore.editorSettings.tableDdlWordWrap,
  });
}

function tableDdlObjectType(type: string): ObjectSourceKind | undefined {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return type;
  return undefined;
}

/** 表信息请求使用的 schema：表自身 schema > 对象浏览器选择的 schema > 数据库名。 */
function tableInfoRequestSchema(): string {
  return props.tableSchema || props.fallbackSchema || props.database;
}

/** 构造对象元数据缓存请求（DDL 与字段/索引等 facet 共用同一缓存键空间）。 */
function tableMetadataRequest(): ObjectDdlRequest {
  return {
    connectionId: props.connection.id,
    database: props.database || "",
    schema: tableInfoRequestSchema(),
    tableName: props.tableName,
    objectType: tableDdlObjectType(props.tableType),
    catalog: props.catalog,
  };
}

type TableInfoTabItem = { id: TableInfoTab; label: string; icon: Component; count?: number };

const tableInfoTabs = computed<TableInfoTabItem[]>(() => {
  const tabs: TableInfoTabItem[] = [];
  if (tableMetadataCapabilities.value.ddl) {
    tabs.push({ id: "ddl", label: "DDL", icon: Code2 });
  }
  if (tableMetadataCapabilities.value.columns) {
    tabs.push({ id: "columns", label: t("grid.tableInfoColumns"), icon: ListTree, count: tableColumns.value.length });
  }
  if (tableMetadataCapabilities.value.indexes) {
    tabs.push({ id: "indexes", label: t("grid.tableInfoIndexes"), icon: KeyRound, count: tableIndexes.value.length });
  }
  if (tableMetadataCapabilities.value.foreignKeys) {
    tabs.push({ id: "foreignKeys", label: t("grid.tableInfoForeignKeys"), icon: Link2, count: tableForeignKeys.value.length });
  }
  if (tableMetadataCapabilities.value.triggers) {
    tabs.push({ id: "triggers", label: t("grid.tableInfoTriggers"), icon: RotateCcw, count: tableTriggers.value.length });
  }
  return tabs;
});

const tableInfoTabListStyle = computed(() => ({
  gridTemplateColumns: `repeat(${tableInfoTabs.value.length}, minmax(0, 1fr))`,
}));

const filteredTableColumns = computed(() => filterObjectBrowserTableColumns(tableColumns.value, tableInfoSearchQuery.value));

const filteredTableIndexes = computed(() => {
  if (!tableInfoSearchQuery.value) return tableIndexes.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableIndexes.value.filter((i) => i.name.toLowerCase().includes(q) || i.columns.some((c) => c.toLowerCase().includes(q)));
});

const filteredTableForeignKeys = computed(() => {
  if (!tableInfoSearchQuery.value) return tableForeignKeys.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableForeignKeys.value.filter((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q));
});

const filteredTableTriggers = computed(() => {
  if (!tableInfoSearchQuery.value) return tableTriggers.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableTriggers.value.filter((tr) => tr.name.toLowerCase().includes(q));
});

const filteredTableDdlContent = computed(() => {
  if (!tableDdlContent.value) return "";
  const html = highlight(tableDdlContent.value);
  if (!tableInfoSearchQuery.value) return html;
  const escaped = tableInfoSearchQuery.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  return html.replace(/>([^<]*)</g, (_, text) => {
    return `>${text.replace(regex, "<mark>$1</mark>")}<`;
  });
});

async function selectTableInfoTab(tab: TableInfoTab) {
  const nextTab = tableInfoTabs.value.some((item) => item.id === tab) ? tab : tableInfoTabs.value[0]?.id;
  if (!nextTab) return;
  tableInfoTab.value = nextTab;
  tableInfoSearchQuery.value = "";
  emit("tabChange", nextTab);
  if (nextTab === "ddl") await fetchTableDdl();
  else if (nextTab === "columns") await fetchTableColumns();
  else if (nextTab === "indexes") await fetchTableIndexes();
  else if (nextTab === "foreignKeys") await fetchTableForeignKeys();
  else if (nextTab === "triggers") await fetchTableTriggers();
}

async function fetchTableDdl(force = false) {
  if (tableDdlLoaded.value && !force) return;
  const epoch = sidePanelGuard.capture();
  tableDdlLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const { ddl } = await loadObjectDdl(tableMetadataRequest(), { force });
    if (sidePanelGuard.isStale(epoch)) return;
    tableDdlContent.value = ddl;
    loadedSuccessfully = true;
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableDdlContent.value = `-- Error: ${e?.message || e}`;
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableDdlLoaded.value = loadedSuccessfully;
      tableDdlLoading.value = false;
    }
  }
}

async function fetchTableColumns(force = false) {
  if (tableColumnsLoaded.value && !force) return;
  const epoch = sidePanelGuard.capture();
  tableColumnsLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest();
    const { value: columns } = await loadObjectMetadataFacet(request, "columns", () => api.getColumns(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog), { force });
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = columns;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableColumnsLoaded.value = loadedSuccessfully;
      tableColumnsLoading.value = false;
    }
  }
}

async function fetchTableIndexes(force = false) {
  if (tableIndexesLoaded.value && !force) return;
  const epoch = sidePanelGuard.capture();
  tableIndexesLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest();
    const { value: indexes } = await loadObjectMetadataFacet(request, "indexes", () => api.listIndexes(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog), { force });
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = indexes;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableIndexesLoaded.value = loadedSuccessfully;
      tableIndexesLoading.value = false;
    }
  }
}

async function fetchTableForeignKeys(force = false) {
  if (tableForeignKeysLoaded.value && !force) return;
  const epoch = sidePanelGuard.capture();
  tableForeignKeysLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest();
    const { value: fks } = await loadObjectMetadataFacet(request, "foreign-keys", () => api.listForeignKeys(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog), { force });
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = fks;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableForeignKeysLoaded.value = loadedSuccessfully;
      tableForeignKeysLoading.value = false;
    }
  }
}

async function fetchTableTriggers(force = false) {
  if (tableTriggersLoaded.value && !force) return;
  const epoch = sidePanelGuard.capture();
  tableTriggersLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest();
    const { value: triggers } = await loadObjectMetadataFacet(request, "triggers", () => api.listTriggers(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog), { force });
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = triggers;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableTriggersLoaded.value = loadedSuccessfully;
      tableTriggersLoading.value = false;
    }
  }
}

async function refreshActiveTableInfo() {
  sidePanelGuard.bump();

  if (tableInfoTab.value === "ddl") {
    tableDdlContent.value = "";
    tableDdlLoaded.value = false;
    await fetchTableDdl(true);
  } else if (tableInfoTab.value === "columns") {
    tableColumns.value = [];
    tableColumnsLoaded.value = false;
    await fetchTableColumns(true);
  } else if (tableInfoTab.value === "indexes") {
    tableIndexes.value = [];
    tableIndexesLoaded.value = false;
    await fetchTableIndexes(true);
  } else if (tableInfoTab.value === "foreignKeys") {
    tableForeignKeys.value = [];
    tableForeignKeysLoaded.value = false;
    await fetchTableForeignKeys(true);
  } else if (tableInfoTab.value === "triggers") {
    tableTriggers.value = [];
    tableTriggersLoaded.value = false;
    await fetchTableTriggers(true);
  }
}

function copyTableDdl() {
  void copyToClipboard(tableDdlContent.value);
  toast(t("grid.copyDdl"), 2000);
}

function onTableInfoDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = tableInfoDdlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

function openTableStructureEditor() {
  if (!canOpenTableStructureEditor.value) return;
  emit("openStructure", { tab: tableInfoTab.value });
}

// 换表（或连接上下文变化）时重置状态并按当前页签重新加载。
watch(
  () => [props.connection.id, props.database, props.catalog, props.fallbackSchema, props.tableName, props.tableSchema, props.tableType] as const,
  () => {
    sidePanelGuard.bump();
    tableColumns.value = [];
    tableDdlContent.value = "";
    tableIndexes.value = [];
    tableForeignKeys.value = [];
    tableTriggers.value = [];
    tableColumnsLoaded.value = false;
    tableDdlLoaded.value = false;
    tableIndexesLoaded.value = false;
    tableForeignKeysLoaded.value = false;
    tableTriggersLoaded.value = false;
    tableInfoSearchQuery.value = "";
    void selectTableInfoTab(tableInfoTab.value);
  },
  { immediate: true },
);

defineExpose({ selectTab: selectTableInfoTab, refresh: refreshActiveTableInfo });
</script>

<template>
  <div class="table-info-panel relative flex h-full min-h-0 flex-col bg-background">
    <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20 h-9" :class="{ 'pl-20': isDetachedWindow && isMac }" :data-tauri-drag-region="isDetachedWindow ? 'deep' : undefined" @pointerdown="onHeaderPointerDown" @dblclick="onHeaderDblclick">
      <TableProperties class="w-3.5 h-3.5 text-muted-foreground" />
      <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ tableName }}</span>
      <div v-if="tableInfoTab === 'ddl' && tableMetadataCapabilities.ddl" class="table-info-actions flex min-w-0 shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyTableDdl">
          <Copy class="w-3 h-3" />
          <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
        </Button>
        <Button variant="ghost" size="icon" class="h-6 w-6" :class="{ 'bg-accent': settingsStore.editorSettings.tableDdlWordWrap }" @click="toggleTableDdlWordWrap">
          <WrapText class="w-3 h-3" />
        </Button>
      </div>
      <Button v-if="canOpenTableStructureEditor" variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('contextMenu.editStructure')" :aria-label="t('contextMenu.editStructure')" @click="openTableStructureEditor">
        <PencilRuler class="w-3 h-3" />
        <span class="table-info-action-label">{{ t("contextMenu.editStructure") }}</span>
      </Button>
      <DetachedWindowControls v-if="isDetachedWindow && !isMac" />
      <Button v-if="isDetachedWindow" variant="ghost" size="icon" class="h-5 w-5" :title="t('panelDetach.dock')" @click="emit('dock')">
        <PictureInPicture2 class="h-3 w-3" />
      </Button>
      <Button v-else-if="isDesktop && detachable !== false" variant="ghost" size="icon" class="h-5 w-5" :title="t('panelDetach.detach')" @click="onDetachClick">
        <PictureInPicture2 class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
        <X class="w-3 h-3" />
      </Button>
    </div>
    <div class="grid border-b bg-background shrink-0" :style="tableInfoTabListStyle">
      <button
        v-for="tab in tableInfoTabs"
        :key="tab.id"
        class="h-9 min-w-0 px-1.5 text-[11px] border-b-2 transition-colors"
        :class="tableInfoTab === tab.id ? 'border-primary bg-gray-300/80 text-foreground dark:bg-gray-700/80' : 'border-transparent text-muted-foreground hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800/50'"
        :title="tab.label"
        @click="selectTableInfoTab(tab.id)"
      >
        <component :is="tab.icon" class="mx-auto h-3.5 w-3.5" />
        <span class="block truncate">{{ tab.label }}</span>
      </button>
    </div>
    <div class="px-2 py-1.5 border-b shrink-0 bg-background">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input v-model="tableInfoSearchQuery" :placeholder="t('grid.tableInfoSearch')" class="w-full h-7 pl-7 pr-6 text-xs bg-muted/50 rounded border border-border focus:outline-none focus:border-primary/50" @keydown.escape="tableInfoSearchQuery = ''" />
        <button v-if="tableInfoSearchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="tableInfoSearchQuery = ''">
          <X class="w-3 h-3" />
        </button>
      </div>
    </div>
    <div v-if="tableInfoTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableColumnsLoading" class="h-full flex items-center justify-center">
        <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="tableInfoSearchQuery && filteredTableColumns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoNoResults") }}
      </div>
      <table v-else class="w-full text-xs">
        <thead class="sticky top-0 bg-muted text-muted-foreground">
          <tr class="border-b">
            <th class="text-left text-nowrap font-medium px-3 py-2 w-8">#</th>
            <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
            <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
            <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
            <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("structureEditor.defaultValue") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(column, index) in filteredTableColumns" :key="column.name" class="border-b hover:bg-gray-200 dark:hover:bg-gray-800/30" :title="column.name">
            <td class="px-3 py-2 text-muted-foreground w-8">{{ index + 1 }}</td>
            <td class="px-3 py-2 font-medium">
              <span class="inline-flex items-center gap-1.5">
                <KeyRound v-if="column.is_primary_key" class="h-3 w-3 text-amber-500" />
                {{ column.name }}
              </span>
              <div v-if="column.comment" class="mt-0.5 text-[11px] text-muted-foreground truncate">
                {{ column.comment }}
              </div>
            </td>
            <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">{{ gaussdbMColumnType(column.data_type) }}</td>
            <td class="px-3 py-2">{{ column.is_nullable ? "YES" : "NO" }}</td>
            <td data-table-info-column-default class="max-w-56 px-3 py-2 font-mono text-[11px]" :class="{ 'text-muted-foreground/70': column.column_default == null }" :title="column.column_default ?? undefined">
              <span class="block max-w-56 truncate">{{ tableColumnDefaultDisplayValue(column.column_default) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="tableInfoTab === 'indexes'" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableIndexesLoading" class="h-full flex items-center justify-center">
        <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="tableInfoSearchQuery && filteredTableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoNoResults") }}
      </div>
      <div v-else-if="tableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoEmpty") }}
      </div>
      <div v-else class="divide-y">
        <div v-for="index in filteredTableIndexes" :key="index.name" class="p-3 text-xs">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium truncate">{{ index.name }}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
                <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">UNIQUE</span>
                <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ index.index_type }}</span>
              </div>
              <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
                {{ index.columns.join(", ") }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="tableInfoTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableForeignKeysLoading" class="h-full flex items-center justify-center">
        <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="tableInfoSearchQuery && filteredTableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoNoResults") }}
      </div>
      <div v-else-if="tableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoEmpty") }}
      </div>
      <div v-else class="divide-y">
        <div v-for="fk in filteredTableForeignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
          <div class="font-medium truncate">{{ fk.name }}</div>
          <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}</div>
        </div>
      </div>
    </div>
    <div v-else-if="tableInfoTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableTriggersLoading" class="h-full flex items-center justify-center">
        <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="tableInfoSearchQuery && filteredTableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoNoResults") }}
      </div>
      <div v-else-if="tableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ t("grid.tableInfoEmpty") }}
      </div>
      <div v-else class="divide-y">
        <div v-for="trigger in filteredTableTriggers" :key="trigger.name" class="p-3 text-xs">
          <div class="font-medium truncate">{{ trigger.name }}</div>
          <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
        </div>
      </div>
    </div>
    <pre
      v-else-if="tableInfoTab === 'ddl' && !tableDdlLoading"
      ref="tableInfoDdlPreRef"
      data-native-clipboard
      tabindex="0"
      class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text outline-none"
      :class="settingsStore.editorSettings.tableDdlWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
      v-html="filteredTableDdlContent"
      @keydown="onTableInfoDdlKeydown"
    ></pre>
    <div v-else class="flex-1 flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
  </div>
</template>

<style scoped>
/* 面板根节点作为 container，保证窄窗口/窄侧栏下操作按钮折叠为图标。 */
.table-info-panel {
  container-type: inline-size;
}

.ddl-code {
  container-type: inline-size;
}

.table-info-action-button {
  gap: 0.25rem;
  max-width: 8rem;
  overflow: hidden;
  transition:
    max-width 180ms ease,
    padding-inline 180ms ease;
}

.table-info-action-label {
  min-width: 0;
  max-width: 6rem;
  overflow: hidden;
  white-space: nowrap;
  opacity: 1;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

@container (max-width: 360px) {
  .table-info-action-button {
    width: 1.5rem;
    max-width: 1.5rem;
    padding-inline: 0;
  }

  .table-info-action-label {
    max-width: 0;
    opacity: 0;
  }
}
</style>
