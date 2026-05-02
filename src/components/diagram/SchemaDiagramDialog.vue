<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/tauri";
import type { DatabaseType } from "@/types/database";
import {
  buildDiagramRelationships,
  filterDiagramTables,
  layoutDiagramTables,
  type DiagramPosition,
  type DiagramRelationship,
  type DiagramTable,
} from "@/lib/erDiagram";
import { buildEngineeringDiagram } from "@/lib/engineeringDiagram";
import {
  buildEngineeringDiagramSvg,
  buildTableDiagramSvg,
  diagramSvgFileName,
} from "@/lib/diagramSvgExport";
import {
  clampDiagramZoom,
  zoomFromGestureScale,
  zoomFromWheelDelta,
} from "@/lib/diagramZoom";
import {
  Download, KeyRound, Link2, Loader2, Maximize2, Network, RefreshCw, Search, Table2,
  ZoomIn, ZoomOut,
} from "lucide-vue-next";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  focusTableName?: string;
}>();

const SQL_TYPES: DatabaseType[] = ["mysql", "postgres", "sqlite", "sqlserver", "oracle", "redshift"];
const SCHEMA_AWARE_TYPES: DatabaseType[] = ["postgres", "sqlserver", "oracle", "redshift"];
const CARD_WIDTH = 270;
const COLUMN_ROW_HEIGHT = 24;
const CARD_HEADER_HEIGHT = 44;
const CARD_BOTTOM_PADDING = 12;
const MAX_VISIBLE_COLUMNS = 9;
const METADATA_BATCH_SIZE = 4;
const ROUTE_PADDING = 56;
const ROUTE_BLOCK_MARGIN = 18;

const connectionId = ref("");
const database = ref("");
const schema = ref("");
const databases = ref<string[]>([]);
const schemas = ref<string[]>([]);
const tables = ref<DiagramTable[]>([]);
const tableSearch = ref("");
const loadingDatabases = ref(false);
const loadingSchemas = ref(false);
const loadingDiagram = ref(false);
const loadedTableCount = ref(0);
const totalTableCount = ref(0);
const failedTableCount = ref(0);
const positions = ref<Record<string, DiagramPosition>>({});
const showAllTables = ref(false);
const diagramViewport = ref<HTMLDivElement | null>(null);
const diagramMode = ref<"table" | "engineering">("table");
const zoom = ref(1);
const gestureStartZoom = ref(1);
const dragging = ref<{
  table: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
} | null>(null);

const sqlConnections = computed(() =>
  store.connections.filter((connection) => SQL_TYPES.includes(connection.db_type)),
);

const selectedConnection = computed(() =>
  connectionId.value ? store.getConfig(connectionId.value) : undefined,
);

const isSchemaAware = computed(() =>
  !!selectedConnection.value && SCHEMA_AWARE_TYPES.includes(selectedConnection.value.db_type),
);

const allRelationships = computed(() => buildDiagramRelationships(tables.value));

const relatedTableNames = computed(() => {
  const focus = props.focusTableName;
  const names = new Set<string>();
  if (!focus) return names;
  names.add(focus);
  for (const relationship of allRelationships.value) {
    if (relationship.sourceTable === focus) names.add(relationship.targetTable);
    if (relationship.targetTable === focus) names.add(relationship.sourceTable);
  }
  return names;
});

const visibleTables = computed(() => {
  const filtered = filterDiagramTables(tables.value, tableSearch.value);
  if (props.focusTableName && !showAllTables.value && !tableSearch.value.trim()) {
    return filtered.filter((table) => relatedTableNames.value.has(table.name));
  }
  return filtered;
});

const visibleTableMap = computed(() =>
  new Map(visibleTables.value.map((table) => [table.name, table])),
);

const visibleRelationships = computed(() =>
  buildDiagramRelationships(visibleTables.value),
);

const diagramReady = computed(() =>
  !!connectionId.value && !!database.value && (!isSchemaAware.value || !!schema.value),
);

const loadingText = computed(() =>
  totalTableCount.value > 0
    ? t("diagram.loadingProgress", { loaded: loadedTableCount.value, total: totalTableCount.value })
    : t("diagram.loading"),
);

function connectionIconType(id: string) {
  const config = store.getConfig(id);
  return config?.driver_profile || config?.db_type || "mysql";
}

function tableHeight(table: DiagramTable): number {
  const visibleCount = Math.min(table.columns.length, MAX_VISIBLE_COLUMNS);
  const overflowHeight = table.columns.length > MAX_VISIBLE_COLUMNS ? 24 : 0;
  return CARD_HEADER_HEIGHT + visibleCount * COLUMN_ROW_HEIGHT + overflowHeight + CARD_BOTTOM_PADDING;
}

const canvasSize = computed(() => {
  let width = 960;
  let height = 540;
  for (const table of visibleTables.value) {
    const position = positions.value[table.name];
    if (!position) continue;
    width = Math.max(width, position.x + CARD_WIDTH + 80);
    height = Math.max(height, position.y + tableHeight(table) + 80);
  }
  return { width, height };
});

const engineeringDiagram = computed(() =>
  buildEngineeringDiagram(visibleTables.value, visibleRelationships.value, positions.value),
);

const activeCanvasSize = computed(() =>
  diagramMode.value === "engineering" ? engineeringDiagram.value.canvas : canvasSize.value,
);

function resetLayout() {
  const count = visibleTables.value.length;
  const columnsPerRow = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(count, 1)))));
  positions.value = layoutDiagramTables(visibleTables.value, {
    columnsPerRow,
    cardWidth: CARD_WIDTH,
    rowHeight: 240,
    gapX: 64,
    gapY: 44,
  });
}

function visibleColumns(table: DiagramTable) {
  return table.columns.slice(0, MAX_VISIBLE_COLUMNS);
}

function hiddenColumnCount(table: DiagramTable): number {
  return Math.max(0, table.columns.length - MAX_VISIBLE_COLUMNS);
}

function isForeignKeyColumn(table: DiagramTable, columnName: string): boolean {
  return table.foreignKeys.some((fk) => fk.column === columnName);
}

function relationshipTitle(relationship: DiagramRelationship): string {
  return `${relationship.sourceTable}.${relationship.sourceColumn} -> ${relationship.targetTable}.${relationship.targetColumn}`;
}

function columnAnchorY(tableName: string, columnName: string): number {
  const table = visibleTableMap.value.get(tableName);
  const position = positions.value[tableName];
  if (!table || !position) return 0;

  const index = table.columns.findIndex((column) => column.name === columnName);
  if (index < 0) return position.y + CARD_HEADER_HEIGHT / 2;
  const visibleIndex = Math.min(index, MAX_VISIBLE_COLUMNS - 1);
  return position.y + CARD_HEADER_HEIGHT + visibleIndex * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;
}

interface TableRect {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiagramGestureEvent extends Event {
  scale?: number;
  clientX?: number;
  clientY?: number;
}

function getTableRect(tableName: string): TableRect | null {
  const table = visibleTableMap.value.get(tableName);
  const position = positions.value[tableName];
  if (!table || !position) return null;
  return {
    name: tableName,
    x: position.x,
    y: position.y,
    width: CARD_WIDTH,
    height: tableHeight(table),
  };
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.max(a1, b1) <= Math.min(a2, b2);
}

function routeSideX(rect: TableRect, routeX: number, offset = 0): number {
  if (routeX < rect.x) return rect.x - offset;
  return rect.x + rect.width + offset;
}

function tableRects(): TableRect[] {
  return visibleTables.value
    .map((table) => getTableRect(table.name))
    .filter((rect): rect is TableRect => rect !== null);
}

function isVerticalRouteBlocked(routeX: number, y1: number, y2: number, ignoredTables: Set<string>): boolean {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return tableRects().some((rect) =>
    !ignoredTables.has(rect.name) &&
    routeX >= rect.x - ROUTE_BLOCK_MARGIN &&
    routeX <= rect.x + rect.width + ROUTE_BLOCK_MARGIN &&
    rangesOverlap(top, bottom, rect.y - ROUTE_BLOCK_MARGIN, rect.y + rect.height + ROUTE_BLOCK_MARGIN)
  );
}

function isHorizontalRouteBlocked(y: number, x1: number, x2: number, ignoredTables: Set<string>): boolean {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  return tableRects().some((rect) =>
    !ignoredTables.has(rect.name) &&
    y >= rect.y - ROUTE_BLOCK_MARGIN &&
    y <= rect.y + rect.height + ROUTE_BLOCK_MARGIN &&
    rangesOverlap(left, right, rect.x - ROUTE_BLOCK_MARGIN, rect.x + rect.width + ROUTE_BLOCK_MARGIN)
  );
}

function candidateRouteXs(source: TableRect, target: TableRect): number[] {
  const candidates = new Set<number>();
  const sourceRight = source.x + source.width;
  const targetRight = target.x + target.width;
  const minLeft = Math.min(source.x, target.x);
  const maxRight = Math.max(sourceRight, targetRight);

  candidates.add(minLeft - ROUTE_PADDING);
  candidates.add(maxRight + ROUTE_PADDING);

  if (sourceRight + ROUTE_PADDING <= target.x) {
    candidates.add((sourceRight + target.x) / 2);
  }
  if (targetRight + ROUTE_PADDING <= source.x) {
    candidates.add((targetRight + source.x) / 2);
  }

  const columns = [...new Set(tableRects().map((rect) => rect.x))]
    .sort((left, right) => left - right);
  for (let index = 0; index < columns.length - 1; index++) {
    const leftRight = columns[index] + CARD_WIDTH;
    const rightLeft = columns[index + 1];
    if (rightLeft - leftRight >= ROUTE_PADDING) {
      candidates.add((leftRight + rightLeft) / 2);
    }
  }

  return [...candidates].sort((left, right) => {
    const leftSourceX = routeSideX(source, left);
    const leftTargetX = routeSideX(target, left);
    const rightSourceX = routeSideX(source, right);
    const rightTargetX = routeSideX(target, right);
    return (Math.abs(left - leftSourceX) + Math.abs(left - leftTargetX)) -
      (Math.abs(right - rightSourceX) + Math.abs(right - rightTargetX));
  });
}

function relationshipPath(relationship: DiagramRelationship): string {
  const source = getTableRect(relationship.sourceTable);
  const target = getTableRect(relationship.targetTable);
  if (!source || !target) return "";

  const y1 = columnAnchorY(relationship.sourceTable, relationship.sourceColumn);
  const y2 = columnAnchorY(relationship.targetTable, relationship.targetColumn);
  const ignoredTables = new Set([source.name, target.name]);
  const candidates = candidateRouteXs(source, target);

  const routeX = candidates.find((candidate) => {
    const x1 = routeSideX(source, candidate);
    const x2 = routeSideX(target, candidate);
    return !isVerticalRouteBlocked(candidate, y1, y2, ignoredTables) &&
      !isHorizontalRouteBlocked(y1, x1, candidate, ignoredTables) &&
      !isHorizontalRouteBlocked(y2, candidate, x2, ignoredTables);
  }) ?? candidates[0] ?? Math.max(source.x + source.width, target.x + target.width) + ROUTE_PADDING;

  const x1 = routeSideX(source, routeX, 2);
  const x2 = routeSideX(target, routeX, 2);
  return `M ${x1} ${y1} L ${routeX} ${y1} L ${routeX} ${y2} L ${x2} ${y2}`;
}

function engineeringEntityCenter(tableName: string): DiagramPosition {
  const entity = engineeringDiagram.value.entities.find((item) => item.name === tableName);
  return entity
    ? { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 }
    : { x: 0, y: 0 };
}

function engineeringAttributeCenter(attribute: { x: number; y: number; width: number; height: number }): DiagramPosition {
  return { x: attribute.x + attribute.width / 2, y: attribute.y + attribute.height / 2 };
}

function engineeringRelationshipCenter(relationship: { x: number; y: number; width: number; height: number }): DiagramPosition {
  return { x: relationship.x + relationship.width / 2, y: relationship.y + relationship.height / 2 };
}

function engineeringCardinalityPoint(from: DiagramPosition, to: DiagramPosition): DiagramPosition {
  return {
    x: from.x + (to.x - from.x) * 0.72,
    y: from.y + (to.y - from.y) * 0.72,
  };
}

async function loadDatabases(id: string) {
  if (!id) return;
  loadingDatabases.value = true;
  databases.value = [];
  try {
    await store.ensureConnected(id);
    const dbs = await api.listDatabases(id);
    databases.value = dbs.map((db) => db.name);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingDatabases.value = false;
  }
}

async function loadSchemas() {
  schemas.value = [];
  schema.value = "";
  if (!connectionId.value || !database.value) return;
  if (!isSchemaAware.value) {
    schema.value = database.value;
    return;
  }

  loadingSchemas.value = true;
  try {
    const names = await api.listSchemas(connectionId.value, database.value);
    schemas.value = names;
    schema.value = props.prefillSchema && names.includes(props.prefillSchema)
      ? props.prefillSchema
      : names.includes("public") ? "public" : (names[0] ?? "");
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingSchemas.value = false;
  }
}

async function setConnection(id: string) {
  connectionId.value = id;
  database.value = "";
  schema.value = "";
  tables.value = [];
  positions.value = {};
  await loadDatabases(id);
  if (databases.value.length === 1) {
    await setDatabase(databases.value[0]);
  }
}

async function setDatabase(value: string) {
  database.value = value;
  tables.value = [];
  positions.value = {};
  await loadSchemas();
  if (diagramReady.value) await loadDiagram();
}

async function setSchema(value: string) {
  schema.value = value;
  tables.value = [];
  positions.value = {};
  if (diagramReady.value) await loadDiagram();
}

async function loadTableDiagramData(tableName: string, querySchema: string): Promise<DiagramTable> {
  try {
    const [columns, foreignKeys] = await Promise.all([
      api.getColumns(connectionId.value, database.value, querySchema, tableName),
      api.listForeignKeys(connectionId.value, database.value, querySchema, tableName).catch(() => []),
    ]);
    return { name: tableName, columns, foreignKeys };
  } catch (e) {
    failedTableCount.value += 1;
    console.warn(`[diagram] failed to load table metadata: ${tableName}`, e);
    return { name: tableName, columns: [], foreignKeys: [] };
  }
}

async function loadDiagram() {
  if (!diagramReady.value) return;

  loadingDiagram.value = true;
  tables.value = [];
  positions.value = {};
  loadedTableCount.value = 0;
  totalTableCount.value = 0;
  failedTableCount.value = 0;
  try {
    await store.ensureConnected(connectionId.value);
    const querySchema = schema.value || database.value;
    const tableInfos = await api.listTables(connectionId.value, database.value, querySchema);
    const baseTables = tableInfos
      .filter((table) => table.table_type !== "VIEW")
      .sort((a, b) => a.name.localeCompare(b.name));
    totalTableCount.value = baseTables.length;

    const loadedTables: DiagramTable[] = [];
    for (let index = 0; index < baseTables.length; index += METADATA_BATCH_SIZE) {
      const batch = baseTables.slice(index, index + METADATA_BATCH_SIZE);
      const batchTables = await Promise.all(
        batch.map((table) => loadTableDiagramData(table.name, querySchema)),
      );
      loadedTables.push(...batchTables);
      loadedTableCount.value = loadedTables.length;
    }

    tables.value = loadedTables;
    showAllTables.value = false;
    await nextTick();
    resetLayout();
    if (failedTableCount.value > 0) {
      toast(t("diagram.partialError", { count: failedTableCount.value }), 5000);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingDiagram.value = false;
  }
}

async function initialize() {
  connectionId.value = "";
  database.value = "";
  schema.value = "";
  databases.value = [];
  schemas.value = [];
  tables.value = [];
  tableSearch.value = "";
  showAllTables.value = false;
  diagramMode.value = "table";
  zoom.value = 1;
  positions.value = {};
  loadedTableCount.value = 0;
  totalTableCount.value = 0;
  failedTableCount.value = 0;

  if (props.prefillConnectionId) {
    connectionId.value = props.prefillConnectionId;
    await loadDatabases(props.prefillConnectionId);
    const initialDatabase = props.prefillDatabase && databases.value.includes(props.prefillDatabase)
      ? props.prefillDatabase
      : (props.prefillDatabase || databases.value[0] || "");
    if (initialDatabase) await setDatabase(initialDatabase);
    return;
  }

  if (sqlConnections.value.length === 1) {
    await setConnection(sqlConnections.value[0].id);
  }
}

function applyZoomAt(nextZoom: number, clientX?: number, clientY?: number) {
  const viewport = diagramViewport.value;
  const previousZoom = zoom.value;
  if (!viewport || nextZoom === previousZoom) {
    zoom.value = nextZoom;
    return;
  }

  const rect = viewport.getBoundingClientRect();
  const originX = (clientX ?? rect.left + rect.width / 2) - rect.left;
  const originY = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const contentX = (viewport.scrollLeft + originX) / previousZoom;
  const contentY = (viewport.scrollTop + originY) / previousZoom;

  zoom.value = nextZoom;
  void nextTick(() => {
    viewport.scrollLeft = contentX * nextZoom - originX;
    viewport.scrollTop = contentY * nextZoom - originY;
  });
}

function zoomIn() {
  applyZoomAt(clampDiagramZoom(zoom.value + 0.1));
}

function zoomOut() {
  applyZoomAt(clampDiagramZoom(zoom.value - 0.1));
}

function resetZoomAndLayout() {
  zoom.value = 1;
  resetLayout();
}

function tableRelationshipPaths(): Record<string, string> {
  return Object.fromEntries(
    visibleRelationships.value.map((relationship) => [relationship.id, relationshipPath(relationship)]),
  );
}

function currentDiagramSvg(): string {
  if (diagramMode.value === "engineering") {
    return buildEngineeringDiagramSvg(engineeringDiagram.value);
  }

  return buildTableDiagramSvg({
    tables: visibleTables.value,
    relationships: visibleRelationships.value,
    positions: positions.value,
    relationshipPaths: tableRelationshipPaths(),
    canvas: canvasSize.value,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    maxVisibleColumns: MAX_VISIBLE_COLUMNS,
    cardBottomPadding: CARD_BOTTOM_PADDING,
    moreColumnsLabel: (count) => t("diagram.moreColumns", { count }),
  });
}

async function exportSvg() {
  try {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const scopeName = isSchemaAware.value && schema.value
      ? `${database.value}-${schema.value}`
      : database.value;
    const defaultPath = diagramSvgFileName(
      selectedConnection.value?.name ?? "",
      scopeName,
      diagramMode.value,
    );
    const path = await save({
      defaultPath,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!path) return;

    await writeTextFile(path, currentDiagramSvg());
    toast(t("diagram.exportedSvg"));
  } catch (e: any) {
    toast(t("diagram.exportSvgFailed", { message: e?.message || String(e) }), 5000);
  }
}

function onDiagramWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  applyZoomAt(zoomFromWheelDelta(zoom.value, event.deltaY), event.clientX, event.clientY);
}

function onDiagramGestureStart(event: DiagramGestureEvent) {
  event.preventDefault();
  gestureStartZoom.value = zoom.value;
}

function onDiagramGestureChange(event: DiagramGestureEvent) {
  if (typeof event.scale !== "number") return;
  event.preventDefault();
  applyZoomAt(zoomFromGestureScale(gestureStartZoom.value, event.scale), event.clientX, event.clientY);
}

function startDrag(table: string, event: MouseEvent) {
  event.preventDefault();
  const position = positions.value[table];
  if (!position) return;
  dragging.value = {
    table,
    startX: event.clientX,
    startY: event.clientY,
    originX: position.x,
    originY: position.y,
  };
  window.addEventListener("mousemove", onDrag);
  window.addEventListener("mouseup", stopDrag);
}

function onDrag(event: MouseEvent) {
  if (!dragging.value) return;
  const current = dragging.value;
  positions.value = {
    ...positions.value,
    [current.table]: {
      x: Math.max(16, current.originX + (event.clientX - current.startX) / zoom.value),
      y: Math.max(16, current.originY + (event.clientY - current.startY) / zoom.value),
    },
  };
}

function stopDrag() {
  dragging.value = null;
  window.removeEventListener("mousemove", onDrag);
  window.removeEventListener("mouseup", stopDrag);
}

watch(open, (value) => {
  if (value) void initialize();
});

watch(() => visibleTables.value.map((table) => table.name).join("\n"), () => {
  resetLayout();
});

onUnmounted(stopDrag);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="w-[94vw] max-w-[94vw] sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw] h-[86vh] max-h-[86vh] gap-0 p-0 overflow-hidden flex flex-col">
      <DialogHeader class="px-4 py-3 border-b">
        <DialogTitle class="flex items-center gap-2">
          <Network class="w-4 h-4" />
          {{ t('diagram.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex items-center gap-2 border-b px-3 py-2 shrink-0 overflow-x-auto">
        <Select :model-value="connectionId" @update:model-value="(value: any) => setConnection(String(value))">
          <SelectTrigger class="h-8 w-48 text-xs">
            <div v-if="connectionId" class="flex min-w-0 items-center gap-2">
              <DatabaseIcon :db-type="connectionIconType(connectionId)" class="w-3.5 h-3.5 shrink-0" />
              <span class="truncate">{{ selectedConnection?.name }}</span>
            </div>
            <SelectValue v-else :placeholder="t('diagram.selectConnection')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">
              <div class="flex items-center gap-2">
                <DatabaseIcon :db-type="connection.driver_profile || connection.db_type" class="w-3.5 h-3.5" />
                {{ connection.name }}
              </div>
            </SelectItem>
          </SelectContent>
        </Select>

        <Select :model-value="database" :disabled="!databases.length || loadingDatabases" @update:model-value="(value: any) => setDatabase(String(value))">
          <SelectTrigger class="h-8 w-44 text-xs">
            <SelectValue :placeholder="loadingDatabases ? t('common.loading') : t('diagram.selectDatabase')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="db in databases" :key="db" :value="db">{{ db }}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          v-if="isSchemaAware"
          :model-value="schema"
          :disabled="!schemas.length || loadingSchemas"
          @update:model-value="(value: any) => setSchema(String(value))"
        >
          <SelectTrigger class="h-8 w-40 text-xs">
            <SelectValue :placeholder="loadingSchemas ? t('common.loading') : t('diagram.selectSchema')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="name in schemas" :key="name" :value="name">{{ name }}</SelectItem>
          </SelectContent>
        </Select>

        <div class="relative min-w-40 flex-1">
          <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="tableSearch" class="h-8 pl-7 text-xs" :placeholder="t('diagram.searchTables')" />
        </div>

        <div class="flex h-8 shrink-0 items-center overflow-hidden rounded-md border bg-background">
          <Button
            variant="ghost"
            size="sm"
            class="h-8 rounded-none px-2 text-xs"
            :class="diagramMode === 'table' ? 'bg-accent' : ''"
            @click="diagramMode = 'table'"
          >
            <Table2 class="mr-1 h-3.5 w-3.5" />
            {{ t('diagram.tableMode') }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-8 rounded-none border-l px-2 text-xs"
            :class="diagramMode === 'engineering' ? 'bg-accent' : ''"
            @click="diagramMode = 'engineering'"
          >
            <Network class="mr-1 h-3.5 w-3.5" />
            {{ t('diagram.engineeringMode') }}
          </Button>
        </div>

        <Button
          v-if="focusTableName && tables.length > 0"
          variant="outline"
          size="sm"
          class="h-8 px-2 text-xs"
          @click="showAllTables = !showAllTables"
        >
          {{ showAllTables ? t('diagram.relatedTables') : t('diagram.allTables') }}
        </Button>

        <Badge variant="secondary" class="h-6 shrink-0">
          {{ t('diagram.tablesCount', { count: visibleTables.length }) }}
        </Badge>
        <Badge variant="secondary" class="h-6 shrink-0">
          {{ t('diagram.relationshipsCount', { count: visibleRelationships.length }) }}
        </Badge>

        <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="loadingDiagram || visibleTables.length === 0" :title="t('diagram.exportSvg')" @click="exportSvg">
          <Download class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="!diagramReady || loadingDiagram" :title="t('diagram.refresh')" @click="loadDiagram">
          <Loader2 v-if="loadingDiagram" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8" :title="t('diagram.zoomOut')" @click="zoomOut">
          <ZoomOut class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8" :title="t('diagram.zoomIn')" @click="zoomIn">
          <ZoomIn class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8" :title="t('diagram.resetLayout')" @click="resetZoomAndLayout">
          <Maximize2 class="h-4 w-4" />
        </Button>
      </div>

      <div class="flex-1 min-h-0 bg-muted/20">
        <div v-if="loadingDiagram" class="h-full flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {{ loadingText }}
        </div>
        <div v-else-if="!diagramReady" class="h-full flex items-center justify-center text-sm text-muted-foreground">
          {{ t('diagram.selectTarget') }}
        </div>
        <div v-else-if="tables.length === 0" class="h-full flex items-center justify-center text-sm text-muted-foreground">
          {{ t('diagram.empty') }}
        </div>
        <div v-else-if="visibleTables.length === 0" class="h-full flex items-center justify-center text-sm text-muted-foreground">
          {{ t('diagram.noMatches') }}
        </div>
        <div
          v-else
          ref="diagramViewport"
          class="h-full overflow-auto"
          @wheel="onDiagramWheel"
          @gesturestart="onDiagramGestureStart"
          @gesturechange="onDiagramGestureChange"
        >
          <div
          class="relative"
            :style="{ width: `${activeCanvasSize.width * zoom}px`, height: `${activeCanvasSize.height * zoom}px` }"
          >
            <div
              class="absolute left-0 top-0 origin-top-left"
              :style="{ width: `${activeCanvasSize.width}px`, height: `${activeCanvasSize.height}px`, transform: `scale(${zoom})` }"
            >
              <template v-if="diagramMode === 'table'">
              <svg class="absolute inset-0 h-full w-full overflow-visible pointer-events-none">
                <defs>
                  <marker id="diagram-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                    <path d="M 0 0 L 8 4 L 0 8 z" class="fill-primary/70" />
                  </marker>
                </defs>
                <path
                  v-for="relationship in visibleRelationships"
                  :key="relationship.id"
                  :d="relationshipPath(relationship)"
                  class="fill-none stroke-primary/55"
                  stroke-width="1.6"
                  marker-end="url(#diagram-arrow)"
                >
                  <title>{{ relationshipTitle(relationship) }}</title>
                </path>
              </svg>

              <div
                v-for="table in visibleTables"
                :key="table.name"
                class="absolute overflow-hidden rounded-md border bg-background shadow-sm"
                :class="table.name === focusTableName ? 'border-primary ring-1 ring-primary/30' : 'border-border'"
                :style="{
                  width: `${CARD_WIDTH}px`,
                  transform: `translate(${positions[table.name]?.x ?? 0}px, ${positions[table.name]?.y ?? 0}px)`,
                }"
              >
                <div
                  class="flex h-11 cursor-grab items-center gap-2 border-b bg-muted/40 px-3 active:cursor-grabbing"
                  @mousedown="startDrag(table.name, $event)"
                >
                  <Table2 class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ table.name }}</span>
                  <Badge variant="outline" class="h-5 px-1.5 text-[10px]">{{ table.columns.length }}</Badge>
                </div>
                <div>
                  <div
                    v-for="column in visibleColumns(table)"
                    :key="column.name"
                    class="flex h-6 items-center gap-1.5 border-b border-border/40 px-3 text-xs last:border-b-0"
                  >
                    <KeyRound v-if="column.is_primary_key" class="h-3 w-3 shrink-0 text-amber-500" />
                    <Link2 v-else-if="isForeignKeyColumn(table, column.name)" class="h-3 w-3 shrink-0 text-primary" />
                    <span v-else class="h-3 w-3 shrink-0" />
                    <span class="min-w-0 flex-1 truncate font-mono">{{ column.name }}</span>
                    <span class="max-w-24 truncate text-[10px] text-muted-foreground">{{ column.data_type }}</span>
                  </div>
                  <div v-if="hiddenColumnCount(table) > 0" class="h-6 px-3 text-xs leading-6 text-muted-foreground">
                    {{ t('diagram.moreColumns', { count: hiddenColumnCount(table) }) }}
                  </div>
                </div>
              </div>
              </template>

              <template v-else>
                <svg class="absolute inset-0 h-full w-full overflow-visible pointer-events-none">
                  <g class="stroke-foreground/70">
                    <line
                      v-for="attribute in engineeringDiagram.attributes"
                      :key="attribute.id"
                      :x1="engineeringEntityCenter(attribute.tableName).x"
                      :y1="engineeringEntityCenter(attribute.tableName).y"
                      :x2="engineeringAttributeCenter(attribute).x"
                      :y2="engineeringAttributeCenter(attribute).y"
                      stroke-width="1.2"
                    />
                    <template v-for="relationship in engineeringDiagram.relationships" :key="relationship.id">
                      <line
                        :x1="engineeringEntityCenter(relationship.sourceTable).x"
                        :y1="engineeringEntityCenter(relationship.sourceTable).y"
                        :x2="engineeringRelationshipCenter(relationship).x"
                        :y2="engineeringRelationshipCenter(relationship).y"
                        stroke-width="1.4"
                      />
                      <line
                        :x1="engineeringRelationshipCenter(relationship).x"
                        :y1="engineeringRelationshipCenter(relationship).y"
                        :x2="engineeringEntityCenter(relationship.targetTable).x"
                        :y2="engineeringEntityCenter(relationship.targetTable).y"
                        stroke-width="1.4"
                      />
                      <text
                        class="fill-foreground text-[13px] font-semibold"
                        :x="engineeringCardinalityPoint(engineeringRelationshipCenter(relationship), engineeringEntityCenter(relationship.sourceTable)).x"
                        :y="engineeringCardinalityPoint(engineeringRelationshipCenter(relationship), engineeringEntityCenter(relationship.sourceTable)).y"
                      >
                        {{ relationship.sourceCardinality }}
                      </text>
                      <text
                        class="fill-foreground text-[13px] font-semibold"
                        :x="engineeringCardinalityPoint(engineeringRelationshipCenter(relationship), engineeringEntityCenter(relationship.targetTable)).x"
                        :y="engineeringCardinalityPoint(engineeringRelationshipCenter(relationship), engineeringEntityCenter(relationship.targetTable)).y"
                      >
                        {{ relationship.targetCardinality }}
                      </text>
                    </template>
                  </g>
                </svg>

                <div
                  v-for="attribute in engineeringDiagram.attributes"
                  :key="attribute.id"
                  class="absolute flex items-center justify-center rounded-full border border-green-600/55 bg-green-100/80 px-3 text-center text-xs text-green-950 shadow-sm dark:bg-green-950/35 dark:text-green-100"
                  :class="attribute.primaryKey ? 'font-semibold underline underline-offset-2' : ''"
                  :title="`${attribute.tableName}.${attribute.columnName}: ${attribute.dataType}`"
                  :style="{
                    width: `${attribute.width}px`,
                    height: `${attribute.height}px`,
                    transform: `translate(${attribute.x}px, ${attribute.y}px)`,
                  }"
                >
                  <span class="truncate">{{ attribute.label }}</span>
                </div>

                <div
                  v-for="relationship in engineeringDiagram.relationships"
                  :key="relationship.id"
                  class="absolute flex items-center justify-center text-center text-xs font-medium text-red-950 dark:text-red-100"
                  :style="{
                    width: `${relationship.width}px`,
                    height: `${relationship.height}px`,
                    transform: `translate(${relationship.x}px, ${relationship.y}px)`,
                  }"
                  :title="`${relationship.sourceTable} -> ${relationship.targetTable}`"
                >
                  <div class="absolute inset-0 border border-red-500/70 bg-red-100/80 dark:bg-red-950/35" style="clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" />
                  <span class="relative max-w-[70px] truncate">{{ relationship.label }}</span>
                </div>

                <div
                  v-for="entity in engineeringDiagram.entities"
                  :key="entity.id"
                  class="absolute flex items-center justify-center border border-blue-500/70 bg-blue-100/80 px-3 text-center text-sm font-semibold text-blue-950 shadow-sm dark:bg-blue-950/35 dark:text-blue-100"
                  :class="entity.name === focusTableName ? 'ring-2 ring-primary/40' : ''"
                  :style="{
                    width: `${entity.width}px`,
                    height: `${entity.height}px`,
                    transform: `translate(${entity.x}px, ${entity.y}px)`,
                  }"
                >
                  <span class="truncate">{{ entity.name }}</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
