<script lang="ts">
// Reopening a cached closure also reuses its namespace choices, avoiding discovery requests.
const diagramNamespaceSnapshots = new Map<string, { databases: string[]; schemas: string[]; defaultSchema: string }>();
</script>

<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VueFlow, useVueFlow, type NodeChange, type EdgeChange, type NodeDragEvent, type EdgeMouseEvent, type NodeMouseEvent, type NodeTypesObject, type EdgeTypesObject, type ViewportTransform } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import { useConnectionStore } from "@/stores/connectionStore";
import { useGraphStore } from "@/lib/diagram/graph-store";
import * as api from "@/lib/backend/api";
import { loadFocusedDiagram, diagramIdentityKey, diagramIndexes, type FocusedDiagramLoadRequest } from "@/lib/diagram/diagramMetadataLoader";
import { focusedDiagramCacheKey, getFocusedDiagramCache, loadFocusedDiagramCached } from "@/lib/diagram/diagramMetadataCache";
import { saveFocusedDiagramState } from "@/lib/diagram/draft-storage";
import { DIAGRAM_SQL_TYPES, isSchemaAware as isSchemaAwareDatabase } from "@/lib/database/databaseCapabilities";
import { databaseOptionsForConnection, fetchNamespaceOptionsForConnection } from "@/composables/useDatabaseOptions";
import { buildDiagramJoinSql, buildDiagramRelationships, diagramTableId, filterDiagramTables, mergeRelationshipsWithInferred, normalizeCustomDiagramRelationship, type CustomDiagramRelationship, type DiagramPosition, type DiagramTable, isDraftTable, needsDiagramSync } from "@/lib/diagram/erDiagram";
import { createDraftTable } from "@/lib/diagram/draft-table";
import { cardinalityPairFromChoice } from "@/lib/diagram/cardinality";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import { supportsTableStructureEditing } from "@/lib/database/databaseFeatureSupport";
import { loadDraftTables, saveDraftTables, loadPersistedLayers, savePersistedLayers, loadPersistedPositions, savePersistedPositions, hasUsablePersistedPositions, loadLiveTablePatches, saveLiveTablePatches, applyLiveTablePatches } from "@/lib/diagram/draft-storage";
import type { InspectorTarget } from "@/types/diagram";
import DiagramInspector from "./DiagramInspector.vue";
import DiagramSyncDialog from "./DiagramSyncDialog.vue";
import CreateDraftTableDialog from "./CreateDraftTableDialog.vue";
import { buildEngineeringDiagram, buildEngineeringDiagramConnections, sliceEngineeringDiagramForViewport, type EngineeringDiagramViewport } from "@/lib/diagram/engineeringDiagram";
import { buildEngineeringDiagramSvg, buildTableDiagramSvg, buildTableRelationshipPolylines, computeTableDiagramCanvas } from "@/lib/export/diagramSvgExport";
import { pointsToSvgPath } from "@/lib/diagram/edge-obstacle-router";
import { buildDiagramDbml, buildDiagramJson, buildDiagramMermaid, diagramExportFileName, svgToPngBlob, type DiagramExportFormat } from "@/lib/export/diagramFormats";
import { saveDiagramBinaryExport, saveDiagramTextExport } from "@/lib/export/saveDiagramExport";
import { inferRelationships, filterByStorage } from "@/lib/diagram/match-engine";
import { loadMatchConfirms, saveMatchConfirms, loadMatchIgnores, saveMatchIgnores, isAutoMatchEnabled } from "@/lib/diagram/match-storage";
import { toVueFlowNodes, toVueFlowEdges, toDiagramEdges, toVueFlowLayerNodes, toAbsolutePosition, isTableCanvasVisible } from "@/lib/diagram/vue-flow-adapter";
import { CARD_WIDTH, CARD_HEADER_HEIGHT, COLUMN_ROW_HEIGHT, CARD_BOTTOM_PADDING, GAP_X, GAP_Y, MARGIN, LAYER_CONTENT_PADDING, LAYER_HEADER_HEIGHT, DIAGRAM_HOVERED_EDGE_KEY, DIAGRAM_EDGE_OBSTACLES_KEY, diagramTableCardHeight } from "@/lib/diagram/diagram-constants";
import { sizeLayerToFit, findLayerAtPoint, placeNewLayer } from "@/lib/diagram/size-layer";
import { computeLtrAutoLayout } from "@/lib/diagram/ltr-auto-layout";
import { computeLayoutWithLayers } from "@/lib/diagram/elk-layout";
import type { ObstacleRect, Point } from "@/lib/diagram/edge-obstacle-router";
import type { DiagramNode, DiagramEdge, MatchResult, LayerLayoutMode, HistorySnapshot } from "@/types/diagram";
import { ChevronDown, ChevronRight, Loader2, Network, Plus, Trash2, X } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import TableNode from "./TableNode.vue";
import LayerNode from "./LayerNode.vue";
import RelationshipEdge from "./RelationshipEdge.vue";
import MatchPanel from "./MatchPanel.vue";
import DiagramToolbar from "./DiagramToolbar.vue";
import LayerPanel from "./LayerPanel.vue";
import ResizerHandle from "./ResizerHandle.vue";
import ZoomControls from "./ZoomControls.vue";
import { useLayerStore } from "@/lib/diagram/layer-store";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();
const graphStore = useGraphStore();
const layerStore = useLayerStore();
const { nodes, edges, applyNodeChanges, applyEdgeChanges, setNodes, setEdges, zoomIn: vfZoomIn, zoomOut: vfZoomOut, fitView, getViewport, setViewport } = useVueFlow();

const diagramPaneRef = ref<HTMLElement | null>(null);
const engineeringViewportRef = ref<HTMLElement | null>(null);
const edgeWaypoints = ref<Record<string, Point[]>>({});
const edgeHandleHints = ref<Record<string, { sourceHandle?: string; targetHandle?: string }>>({});
const highlightEdgeId = ref<string | null>(null);
provide(DIAGRAM_HOVERED_EDGE_KEY, highlightEdgeId);

function clearWaypointsForTables(tableIds: string[]) {
  if (tableIds.length === 0) return;
  const idSet = new Set(tableIds);
  edgeWaypoints.value = Object.fromEntries(
    Object.entries(edgeWaypoints.value).filter(([edgeId]) => {
      const rel = visibleRelationships.value.find((r) => r.id === edgeId);
      if (!rel) return false;
      return !idSet.has(rel.sourceTable) && !idSet.has(rel.targetTable);
    }),
  );
  edgeHandleHints.value = Object.fromEntries(Object.entries(edgeHandleHints.value).filter(([edgeId]) => edgeWaypoints.value[edgeId]));
}

function diagramPaneWidth(): number {
  const w = diagramPaneRef.value?.clientWidth;
  if (w && w > 0) return w;
  if (typeof window !== "undefined") {
    const fallback = window.innerWidth - 360;
    return fallback > 0 ? fallback : 1400;
  }
  return 1400;
}

function handleNodesChange(changes: NodeChange[]) {
  applyNodeChanges(changes);
  for (const change of changes) {
    if (change.type === "position" && change.position) {
      const absolute = toAbsolutePosition(change.id, change.position, layerStore.layers);
      const layerNode = layerStore.layers.find((l) => l.id === change.id);
      if (layerNode) {
        layerNode.position = { ...change.position };
        for (const tableName of layerNode.tableNames) {
          const child = nodes.value.find((n) => n.id === tableName);
          if (child) {
            positions.value[tableName] = {
              x: change.position.x + child.position.x,
              y: change.position.y + child.position.y,
            };
          }
        }
      } else {
        positions.value[change.id] = absolute;
      }
    }
  }
}

function handleEdgesChange(changes: EdgeChange[]) {
  applyEdgeChanges(changes);
}

function tableHeightsMap(): Record<string, number> {
  const heights: Record<string, number> = {};
  for (const table of tables.value) {
    const h = tableHeight(table);
    heights[table.name] = h;
    const key = getTableKey(table);
    heights[key] = h;
  }
  return heights;
}

function deepCloneJson<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function captureHistorySnapshot(): HistorySnapshot {
  const diagramNodes = visibleTables.value.map((table) => ({
    id: getTableKey(table),
    type: "table",
    position: positions.value[getTableKey(table)] || { x: 0, y: 0 },
    data: { table },
  }));
  return {
    nodes: deepCloneJson(diagramNodes),
    edges: deepCloneJson(toDiagramEdges(toVueFlowEdges(visibleRelationships.value, positions.value))),
    positions: deepCloneJson(positions.value),
    layers: layerStore.toJSON(),
    tables: deepCloneJson(tables.value),
    customRelationships: deepCloneJson(customRelationships.value),
    edgeWaypoints: deepCloneJson(edgeWaypoints.value),
    edgeHandleHints: deepCloneJson(edgeHandleHints.value),
    matchConfirms: [...matchConfirms.value],
    matchIgnores: [...matchIgnores.value],
  };
}

function recordHistory() {
  graphStore.pushHistory(captureHistorySnapshot());
}

function syncGraphStoreFromPositions() {
  const diagramNodes = visibleTables.value.map((table) => ({
    id: getTableKey(table),
    type: "table",
    position: positions.value[getTableKey(table)] || { x: 0, y: 0 },
    data: { table },
  }));
  graphStore.setNodes(diagramNodes);
  graphStore.setEdges(toDiagramEdges(toVueFlowEdges(visibleRelationships.value, positions.value)));
}

function applyHistorySnapshot(snapshot: HistorySnapshot) {
  positions.value = deepCloneJson(snapshot.positions);
  layerStore.loadLayers(deepCloneJson(snapshot.layers));
  tables.value = deepCloneJson(snapshot.tables ?? []);
  customRelationships.value = deepCloneJson(snapshot.customRelationships);
  edgeWaypoints.value = deepCloneJson(snapshot.edgeWaypoints);
  edgeHandleHints.value = deepCloneJson(snapshot.edgeHandleHints ?? {});
  matchConfirms.value = [...(snapshot.matchConfirms ?? [])];
  matchIgnores.value = [...(snapshot.matchIgnores ?? [])];
  graphStore.setNodes(deepCloneJson(snapshot.nodes));
  graphStore.setEdges(deepCloneJson(snapshot.edges));
  const restoreTarget = inspectorTarget.value;
  if (restoreTarget?.kind === "table" && !tables.value.some((t) => t.name === restoreTarget.tableName)) {
    inspectorTarget.value = null;
  } else if (restoreTarget?.kind === "edge") {
    const edgeId = restoreTarget.edgeId;
    const edgeExists = customRelationships.value.some((r) => r.id === edgeId) || matchResult.value.relationships.some((r) => r.id === edgeId) || snapshot.edges.some((e) => e.id === edgeId);
    if (!edgeExists) inspectorTarget.value = null;
  }
  saveCustomRelationships();
  saveMatchData();
  persistDraftAndLayers();
  refreshMatchResult();
  fitAllFreeLayers();
  syncVueFlowNodes();
}

function handleUndo() {
  const restored = graphStore.undo(captureHistorySnapshot());
  if (restored) applyHistorySnapshot(restored);
}

function handleRedo() {
  const restored = graphStore.redo(captureHistorySnapshot());
  if (restored) applyHistorySnapshot(restored);
}

function canLayoutLayer(layer: { tableNames: string[] }): boolean {
  return loadedDiagramScope.value !== "focused" || layer.tableNames.every((name) => tables.value.some((table) => getTableKey(table) === name || (table.name === name && table.schema === selectedSchemas.value[0])));
}

function fitAllFreeLayers() {
  const heights = tableHeightsMap();
  for (const layer of layerStore.layers) {
    if (canLayoutLayer(layer) && (layer.layoutMode ?? "auto") === "free") {
      sizeLayerToFit(layer, positions.value, heights);
    }
  }
}

/** Resize every layer box to contain its tables (used after membership changes). */
function fitAllLayers() {
  const heights = tableHeightsMap();
  for (const layer of layerStore.layers) {
    if (canLayoutLayer(layer)) sizeLayerToFit(layer, positions.value, heights);
  }
}

function handleNodeDragStart() {
  recordHistory();
}

async function handleNodeDragStop(event: NodeDragEvent) {
  const node = event.node;
  if (!node) return;

  // Layer drag: geometry already updated in handleNodesChange
  if (node.type === "layer") {
    const layer = layerStore.layers.find((l) => l.id === node.id);
    clearWaypointsForTables(layer?.tableNames ?? []);
    syncGraphStoreFromPositions();
    syncVueFlowNodes();
    persistDraftAndLayers();
    return;
  }

  const absolute = toAbsolutePosition(node.id, node.position, layerStore.layers);
  positions.value[node.id] = absolute;

  const currentLayer = layerStore.getLayerByTable(node.id);
  const hitLayer = findLayerAtPoint(absolute, layerStore.layers, undefined);

  if (hitLayer && hitLayer.id !== currentLayer?.id) {
    layerStore.moveTableToLayer(node.id, hitLayer.id);
  } else if (!hitLayer && currentLayer) {
    layerStore.removeTableFromLayer(currentLayer.id, node.id);
  }

  fitAllFreeLayers();
  const membership = layerStore.getLayerByTable(node.id);
  if (membership) {
    sizeLayerToFit(membership, positions.value, tableHeightsMap());
  }
  if (currentLayer && currentLayer.id !== membership?.id) {
    sizeLayerToFit(currentLayer, positions.value, tableHeightsMap());
  }

  clearWaypointsForTables([node.id]);
  syncGraphStoreFromPositions();
  syncVueFlowNodes();
  persistDraftAndLayers();
}

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillCatalog?: string;
  focusTableName?: string;
  focusTableNames?: string[];
}>();

const emit = defineEmits<{
  "open-target": [
    value: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
    },
  ];
}>();

const METADATA_BATCH_SIZE = 4;
const LARGE_TABLE_DIAGRAM_THRESHOLD = 200;
const LARGE_ENGINEERING_DIAGRAM_THRESHOLD = 2_000;
const ENGINEERING_VIEWPORT_OVERSCAN = 800;

const connectionId = ref("");
const database = ref("");
const schema = ref("");
const selectedSchemas = ref<string[]>([]);
const databases = ref<string[]>([]);
const schemas = ref<string[]>([]);
const tables = ref<DiagramTable[]>([]);
const customRelationships = ref<CustomDiagramRelationship[]>([]);
const tableSearch = ref("");
const loadingDatabases = ref(false);
const loadingSchemas = ref(false);
const loadingDiagram = ref(false);
const showRefreshConfirm = ref(false);
const loadedTableCount = ref(0);
const totalTableCount = ref(0);
const failedTableCount = ref(0);
const positions = ref<Record<string, DiagramPosition>>({});
const showAllTables = ref(false);
type DiagramLoadMode = "focused" | "full";
const loadedDiagramScope = ref<DiagramLoadMode>("full");
let persistedTableSnapshot: DiagramTable[] = [];
let diagramLoadGeneration = 0;
let initializationGeneration = 0;
let namespaceGeneration = 0;
const focusedRoots = computed(() => {
  const names = props.focusTableNames?.length ? props.focusTableNames : props.focusTableName ? [props.focusTableName] : [];
  return names.filter((name) => name.trim()).map((name) => ({ name, schema: selectedSchemas.value[0] || schema.value || database.value }));
});
const diagramMode = ref<"table" | "engineering">("table");

const FIT_VIEW_OPTIONS = { padding: 0.15, duration: 150, minZoom: 0.05, maxZoom: 2 } as const;

/** Vue Flow fitView — no-op in engineering mode (Vue Flow unmounted). */
function fitDiagramView() {
  if (diagramMode.value !== "table") return;
  void fitView({ ...FIT_VIEW_OPTIONS });
}

async function setDiagramMode(mode: "table" | "engineering") {
  if (diagramMode.value === mode) return;
  diagramMode.value = mode;
  // Keep positions / fullscreen; only re-fit when returning to table view
  if (mode === "table") {
    await nextTick();
    fitDiagramView();
  } else {
    await nextTick();
    syncEngineeringViewport();
  }
}

const showMatchPanel = ref(false);
const showLayersPanel = ref(true);
const showManualAdd = ref(false);
const showCreateTableDialog = ref(false);
const showSyncDialog = ref(false);
const inspectorTarget = ref<InspectorTarget>(null);

function syncHighlightEdgeId() {
  highlightEdgeId.value = inspectorTarget.value?.kind === "edge" ? inspectorTarget.value.edgeId : null;
}

function handleEdgeClick(event: EdgeMouseEvent) {
  showMatchPanel.value = false;
  inspectorTarget.value = { kind: "edge", edgeId: event.edge.id };
  syncHighlightEdgeId();
}

function handlePaneClick() {
  inspectorTarget.value = null;
  syncHighlightEdgeId();
}

const matchResult = ref<MatchResult>({ relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } });
const matchConfirms = ref<string[]>([]);
const matchIgnores = ref<string[]>([]);
const relationshipDraft = ref({
  name: "",
  sourceTable: "",
  sourceColumn: "",
  targetTable: "",
  targetColumn: "",
  cardinality: "many-to-one" as "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many",
});

const nodeTypes = {
  table: markRaw(TableNode),
  layer: markRaw(LayerNode),
} as NodeTypesObject;
const edgeTypes = {
  relationship: markRaw(RelationshipEdge),
} as EdgeTypesObject;

const leftPanelWidth = ref(224);
const rightPanelWidth = ref(360);
const MIN_LEFT_WIDTH = 120;
const MAX_LEFT_WIDTH = 400;
const MIN_RIGHT_WIDTH = 200;
const MAX_RIGHT_WIDTH = 500;

function handleLeftResize(delta: number) {
  const newWidth = leftPanelWidth.value + delta;
  leftPanelWidth.value = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, newWidth));
}

function handleRightResize(delta: number) {
  const newWidth = rightPanelWidth.value - delta;
  rightPanelWidth.value = Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, newWidth));
}

const sqlConnections = computed(() => store.connections.filter((connection) => DIAGRAM_SQL_TYPES.has(connection.db_type)));

const selectedConnection = computed(() => (connectionId.value ? store.getConfig(connectionId.value) : undefined));

const isSchemaAware = computed(() => isSchemaAwareDatabase(selectedConnection.value?.db_type));

const isAllSchemasSelected = computed(() => isSchemaAware.value && schemas.value.length > 0 && schemas.value.every((s) => selectedSchemas.value.includes(s)));

const isMultiSchema = computed(() => new Set(tables.value.map((table) => table.schema ?? "")).size > 1 || (isSchemaAware.value && (selectedSchemas.value.length > 1 || isAllSchemasSelected.value)));

const tableNameCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const table of tables.value) counts.set(table.name, (counts.get(table.name) ?? 0) + 1);
  return counts;
});

function getTableKey(table: { name: string; schema?: string }): string {
  return diagramTableId(table, isMultiSchema.value);
}

function canUseUnqualifiedTableName(table: DiagramTable): boolean {
  return tableNameCounts.value.get(table.name) === 1 && (loadedDiagramScope.value !== "focused" || !table.schema || table.schema === selectedSchemas.value[0]);
}

const effectiveSchemaKey = computed(() => {
  // Non-schema-aware drivers historically persisted with the database name
  // in this slot (loadSchemas assigned schema = database); keep legacy keys.
  if (!isSchemaAware.value) return database.value;
  if (isAllSchemasSelected.value) return "__all__";
  if (selectedSchemas.value.length === 1) return selectedSchemas.value[0];
  if (selectedSchemas.value.length > 1) return selectedSchemas.value.slice().sort().join(",");
  return schema.value || "";
});

const tableMap = computed(() => {
  const map = new Map<string, DiagramTable>();
  for (const table of tables.value) {
    map.set(getTableKey(table), table);
    if (!map.has(table.name)) {
      map.set(table.name, table);
    }
  }
  return map;
});

const visibleTables = computed(() => {
  const filtered = filterDiagramTables(
    tables.value.filter((table) => !table.pendingDrop),
    tableSearch.value,
  );
  return filtered;
});

const visibleRelationships = computed(() => {
  const baseRelationships = buildDiagramRelationships(visibleTables.value, customRelationships.value, isMultiSchema.value);
  if (!isAutoMatchEnabled()) return baseRelationships;

  const visibleTableKeys = new Set(visibleTables.value.map((t) => getTableKey(t)));
  const visibleTableNames = new Set(visibleTables.value.map((t) => t.name));
  // Inferred relationships carry plain table names; map them to composite node ids in multi-schema mode
  const inferredVisible = matchResult.value.relationships
    .filter((r) => (visibleTableKeys.has(r.sourceTable) || visibleTableNames.has(r.sourceTable)) && (visibleTableKeys.has(r.targetTable) || visibleTableNames.has(r.targetTable)))
    .map((r) => {
      const source = tableMap.value.get(r.sourceTable);
      const target = tableMap.value.get(r.targetTable);
      if (!source && !target) return r;
      return {
        ...r,
        sourceTable: source ? getTableKey(source) : r.sourceTable,
        targetTable: target ? getTableKey(target) : r.targetTable,
      };
    });

  return mergeRelationshipsWithInferred(baseRelationships, inferredVisible);
});

/** Tables/edges currently drawn on the canvas (excludes members of hidden layers). */
const canvasVisibleTables = computed(() => visibleTables.value.filter((table) => isTableCanvasVisible(getTableKey(table), layerStore.layers) || isTableCanvasVisible(table.name, layerStore.layers)));

const canvasVisibleRelationships = computed(() => visibleRelationships.value.filter((rel) => isTableCanvasVisible(rel.sourceTable, layerStore.layers) && isTableCanvasVisible(rel.targetTable, layerStore.layers)));

const edgeObstacles = computed<ObstacleRect[]>(() => {
  const rects: ObstacleRect[] = [];
  for (const table of canvasVisibleTables.value) {
    const key = getTableKey(table);
    const pos = positions.value[key] || positions.value[table.name];
    if (!pos) continue;
    rects.push({
      id: key,
      kind: "table",
      x: pos.x,
      y: pos.y,
      width: CARD_WIDTH,
      height: tableHeight(table),
    });
  }
  for (const layer of layerStore.layers) {
    if (!layer.visible || !layer.position) continue;
    rects.push({
      id: layer.id,
      kind: "layer",
      x: layer.position.x,
      y: layer.position.y,
      width: layer.width || 240,
      height: layer.height || 52,
      tableNames: [...layer.tableNames],
    });
  }
  return rects;
});
provide(DIAGRAM_EDGE_OBSTACLES_KEY, edgeObstacles);

const diagramReady = computed(() => !!connectionId.value && !!database.value && (!isSchemaAware.value || selectedSchemas.value.length > 0));

const showRightPanel = computed(() => diagramReady.value && (showMatchPanel.value || !!inspectorTarget.value));

const loadingText = computed(() => (totalTableCount.value > 0 ? t("diagram.loadingProgress", { loaded: loadedTableCount.value, total: totalTableCount.value }) : t("diagram.loading")));

const sourceColumns = computed(() => tableMap.value.get(relationshipDraft.value.sourceTable)?.columns ?? []);

const targetColumns = computed(() => tableMap.value.get(relationshipDraft.value.targetTable)?.columns ?? []);

const generatedJoinSql = computed(() => buildDiagramJoinSql(visibleRelationships.value));

const customRelationshipCount = computed(() => customRelationships.value.length);

const matchRelationshipCount = computed(() => matchResult.value.relationships.length);

function tableHeight(table: DiagramTable): number {
  // Includes the rendered table/column comment lines so canvas bounds, layers,
  // edge routing and auto layout match the card height.
  return diagramTableCardHeight(table);
}

const canvasSize = computed(() => {
  let width = 960;
  let height = 540;
  for (const table of canvasVisibleTables.value) {
    const key = getTableKey(table);
    const position = positions.value[key] || positions.value[table.name];
    if (!position) continue;
    width = Math.max(width, position.x + CARD_WIDTH + 80);
    height = Math.max(height, position.y + tableHeight(table) + 80);
  }
  return { width, height };
});

const engineeringDiagram = computed(() => buildEngineeringDiagram(visibleTables.value, visibleRelationships.value, positions.value));
const engineeringConnections = computed(() => buildEngineeringDiagramConnections(engineeringDiagram.value));
const virtualizeTableDiagram = computed(() => visibleTables.value.length > LARGE_TABLE_DIAGRAM_THRESHOLD);
const virtualizeEngineeringDiagram = computed(() => engineeringDiagram.value.entities.length + engineeringDiagram.value.attributes.length + engineeringDiagram.value.relationships.length > LARGE_ENGINEERING_DIAGRAM_THRESHOLD);
const engineeringViewport = ref<EngineeringDiagramViewport>({
  left: -ENGINEERING_VIEWPORT_OVERSCAN,
  top: -ENGINEERING_VIEWPORT_OVERSCAN,
  right: 1920 + ENGINEERING_VIEWPORT_OVERSCAN,
  bottom: 1080 + ENGINEERING_VIEWPORT_OVERSCAN,
});
const engineeringRenderSlice = computed(() => {
  const diagram = engineeringDiagram.value;
  const connections = engineeringConnections.value;
  if (!virtualizeEngineeringDiagram.value) {
    return {
      entities: diagram.entities,
      attributes: diagram.attributes,
      relationships: diagram.relationships,
      ...connections,
    };
  }
  return sliceEngineeringDiagramForViewport(diagram, connections, engineeringViewport.value);
});

const activeCanvasSize = computed(() => (diagramMode.value === "engineering" ? engineeringDiagram.value.canvas : canvasSize.value));

let engineeringViewportFrame: number | null = null;
let engineeringResizeObserver: ResizeObserver | null = null;

function syncEngineeringViewport() {
  engineeringViewportFrame = null;
  const viewport = engineeringViewportRef.value;
  if (!viewport) return;
  engineeringViewport.value = {
    left: viewport.scrollLeft - ENGINEERING_VIEWPORT_OVERSCAN,
    top: viewport.scrollTop - ENGINEERING_VIEWPORT_OVERSCAN,
    right: viewport.scrollLeft + viewport.clientWidth + ENGINEERING_VIEWPORT_OVERSCAN,
    bottom: viewport.scrollTop + viewport.clientHeight + ENGINEERING_VIEWPORT_OVERSCAN,
  };
}

function scheduleEngineeringViewportSync() {
  if (engineeringViewportFrame !== null) return;
  engineeringViewportFrame = window.requestAnimationFrame(syncEngineeringViewport);
}

function handleAddLayer() {
  recordHistory();
  const placement = placeNewLayer(layerStore.layers, positions.value, tableHeightsMap());
  layerStore.addLayer(undefined, placement.position, {
    width: placement.width,
    height: placement.height,
  });
  persistDraftAndLayers();
  syncVueFlowNodes();
}

function handleLayerChanged() {
  fitAllLayers();
  persistDraftAndLayers();
  syncVueFlowNodes();
}

async function applyAutoLayout(options?: { skipHistory?: boolean }) {
  const generation = diagramLoadGeneration;
  await nextTick();
  if (!open.value || generation !== diagramLoadGeneration) return;
  const layoutTables = canvasVisibleTables.value;
  if (layoutTables.length === 0) return;

  if (!options?.skipHistory) recordHistory();

  const diagramNodes: DiagramNode[] = layoutTables.map((table) => {
    const key = getTableKey(table);
    return {
      id: key,
      type: "table",
      position: positions.value[key] || positions.value[table.name] ? { ...(positions.value[key] || positions.value[table.name]) } : { x: 0, y: 0 },
      data: { table },
    };
  });
  const diagramEdges: DiagramEdge[] = canvasVisibleRelationships.value.map((rel) => ({
    id: rel.id,
    source: rel.sourceTable,
    target: rel.targetTable,
    data: { relationship: rel },
  }));

  // Only pass visible layers into ELK so hidden layers are not reflowed
  const layoutLayers = layerStore.layers.filter((l) => l.visible && canLayoutLayer(l));
  const result = await computeLayoutWithLayers(diagramNodes, diagramEdges, layoutLayers);
  if (!open.value || generation !== diagramLoadGeneration) return;

  // Freeze positions for tables in hidden layers
  const nextPositions: Record<string, DiagramPosition> = { ...positions.value };
  for (const node of result.nodes) {
    nextPositions[node.id] = { ...node.position };
  }
  positions.value = nextPositions;

  for (const layout of result.layerLayouts) {
    const layer = layerStore.layers.find((l) => l.id === layout.layerId);
    if (!layer) continue;
    layer.position = { x: layout.x, y: layout.y };
    layer.width = layout.width;
    layer.height = layout.height;
  }

  const canvasEdgeIds = new Set(canvasVisibleRelationships.value.map((r) => r.id));
  const nextWaypoints: Record<string, Point[]> = {};
  const nextHandleHints: Record<string, { sourceHandle?: string; targetHandle?: string }> = {};
  // Keep waypoints for edges that touch hidden tables
  for (const [id, wp] of Object.entries(edgeWaypoints.value)) {
    if (!canvasEdgeIds.has(id)) nextWaypoints[id] = wp;
  }
  for (const [id, hint] of Object.entries(edgeHandleHints.value)) {
    if (!canvasEdgeIds.has(id)) nextHandleHints[id] = hint;
  }
  for (const edge of result.edges) {
    if (edge.waypoints && edge.waypoints.length >= 2) {
      nextWaypoints[edge.id] = edge.waypoints.map((p) => ({ x: p.x, y: p.y }));
    }
    if (edge.sourceHandle || edge.targetHandle) {
      nextHandleHints[edge.id] = {
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      };
    }
  }
  edgeWaypoints.value = nextWaypoints;
  edgeHandleHints.value = nextHandleHints;

  // Only size free layers; do not move auto-laid-out tables (would invalidate waypoints)
  fitAllFreeLayers();
  syncVueFlowNodes();
  await nextTick();
  fitDiagramView();
  persistDraftAndLayers();
}

async function handleFocusLayer(layerId: string) {
  const layer = layerStore.layers.find((l) => l.id === layerId);
  if (!layer) return;
  layerStore.setActiveLayer(layerId);
  if (!layer.visible) {
    toast(t("diagram.layerHiddenCannotFocus"), 3000);
    return;
  }
  if (diagramMode.value !== "table") return;
  await nextTick();
  const nodeIds = [layerId, ...layer.tableNames];
  void fitView({ nodes: nodeIds, ...FIT_VIEW_OPTIONS });
}

async function handleLayerLayoutModeChanged(payload: { layerId: string; layoutMode: LayerLayoutMode }) {
  recordHistory();
  layerStore.setLayoutMode(payload.layerId, payload.layoutMode);
  if (payload.layoutMode === "auto") {
    await applyAutoLayout({ skipHistory: true });
  } else {
    const layer = layerStore.layers.find((l) => l.id === payload.layerId);
    if (layer) {
      sizeLayerToFit(layer, positions.value, tableHeightsMap());
    }
    syncVueFlowNodes();
  }
}

function openTableData(tableName: string) {
  const table = tables.value.find((t) => getTableKey(t) === tableName || t.name === tableName);
  if (table && isDraftTable(table)) {
    openInspectorForTable(tableName);
    return;
  }
  if (!connectionId.value || !database.value || !tableName) return;
  emit("open-target", {
    connectionId: connectionId.value,
    database: database.value,
    schema: isSchemaAware.value ? table?.schema || schema.value || undefined : undefined,
    tableName: table?.name || tableName,
    tableType: "TABLE",
  });
}

const draftTableCount = computed(() => tables.value.filter(needsDiagramSync).length);
const structureCapabilities = computed(() => getTableStructureCapabilities(selectedConnection.value?.db_type));
const canCreateDraftTable = computed(() => structureCapabilities.value.createTable);
const canSyncStructure = computed(() => supportsTableStructureEditing(selectedConnection.value?.db_type));

function persistDraftAndLayers() {
  if (!connectionId.value || !database.value) return;
  const schemaKey = effectiveSchemaKey.value;
  if (loadedDiagramScope.value === "focused") {
    saveFocusedDiagramState(tables.value, persistedTableSnapshot, positions.value, layerStore.toJSON(), connectionId.value, database.value, schemaKey, selectedSchemas.value[0]);
    persistedTableSnapshot = deepCloneJson(tables.value);
    return;
  }
  saveDraftTables(tables.value, connectionId.value, database.value, schemaKey);
  saveLiveTablePatches(tables.value, connectionId.value, database.value, schemaKey);
  savePersistedLayers(layerStore.toJSON(), connectionId.value, database.value, schemaKey);
  savePersistedPositions(positions.value, connectionId.value, database.value, schemaKey);
}

function openInspectorForTable(tableName: string) {
  showMatchPanel.value = false;
  inspectorTarget.value = { kind: "table", tableName };
  syncHighlightEdgeId();
}

function handleNodeClick(event: NodeMouseEvent) {
  if (event.node.type === "layer") return;
  openInspectorForTable(event.node.id);
}

function handleCreateDraftTable(payload: { name: string; layerId: string | null; withDefaultId: boolean }) {
  if (!canCreateDraftTable.value) return;
  recordHistory();
  const draft = createDraftTable(payload.name, { withDefaultId: payload.withDefaultId, databaseType: selectedConnection.value?.db_type });
  draft.schema = selectedSchemas.value[0] || schema.value || undefined;
  tables.value = [...tables.value, draft];
  const targetLayerId = payload.layerId || layerStore.activeLayerId;
  const targetLayer = targetLayerId ? layerStore.layers.find((l) => l.id === targetLayerId) : undefined;

  let x: number;
  let y: number;
  if (targetLayer?.position) {
    const memberPositions = targetLayer.tableNames.map((name) => positions.value[name]).filter((pos): pos is DiagramPosition => !!pos);
    const heights = tableHeightsMap();
    if (memberPositions.length === 0) {
      x = targetLayer.position.x + LAYER_CONTENT_PADDING;
      y = targetLayer.position.y + LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING;
    } else {
      let maxBottom = targetLayer.position.y + LAYER_HEADER_HEIGHT;
      let leftMost = targetLayer.position.x + LAYER_CONTENT_PADDING;
      for (const name of targetLayer.tableNames) {
        const pos = positions.value[name];
        if (!pos) continue;
        leftMost = Math.min(leftMost, pos.x);
        maxBottom = Math.max(maxBottom, pos.y + (heights[name] ?? 120));
      }
      x = leftMost;
      y = maxBottom + GAP_Y / 2;
    }
  } else {
    x = MARGIN + (Object.keys(positions.value).length % 3) * (CARD_WIDTH + GAP_X);
    y = MARGIN + Math.floor(Object.keys(positions.value).length / 3) * 200;
  }

  const draftKey = getTableKey(draft);
  positions.value = { ...positions.value, [draftKey]: { x, y }, [draft.name]: { x, y } };
  if (targetLayerId) {
    layerStore.addTableToLayer(targetLayerId, draftKey);
    const layer = layerStore.layers.find((l) => l.id === targetLayerId);
    if (layer) sizeLayerToFit(layer, positions.value, tableHeightsMap());
  }
  persistDraftAndLayers();
  syncVueFlowNodes();
  openInspectorForTable(draftKey);
}

function handleInspectorUpdateTable(next: DiagramTable) {
  recordHistory();
  const targetName = inspectorTarget.value?.kind === "table" ? inspectorTarget.value.tableName : next.name;
  // inspectorTarget may hold the composite canvas node id (`schema.table`) in multi-schema mode
  const oldTable = tables.value.find((t) => t.name === targetName || getTableKey(t) === targetName);
  if (!oldTable) return;
  const oldKey = getTableKey(oldTable);
  const oldName = oldTable.name;

  // Accurately update ONLY the matched table instance, avoiding unintentional overwrite of same-name tables in other schemas
  tables.value = tables.value.map((t) => (t === oldTable || getTableKey(t) === oldKey ? next : t));
  if (oldName !== next.name) {
    const newKey = getTableKey(next);
    const pos = positions.value[oldKey] || positions.value[oldName];
    const nextPositions = { ...positions.value };
    delete nextPositions[oldKey];
    delete nextPositions[oldName];
    if (pos) {
      nextPositions[newKey] = pos;
      nextPositions[next.name] = pos;
    }
    positions.value = nextPositions;
    for (const layer of layerStore.layers) {
      let modified = false;
      for (const key of [oldKey, oldName]) {
        const idx = layer.tableNames.indexOf(key);
        if (idx >= 0) {
          layer.tableNames[idx] = newKey;
          modified = true;
        }
      }
      if (modified) {
        sizeLayerToFit(layer, positions.value, tableHeightsMap());
      }
    }
    const oldCandidateNames = new Set([oldName, oldKey]);
    customRelationships.value = customRelationships.value.map((r) => ({
      ...r,
      sourceTable: oldCandidateNames.has(r.sourceTable) ? newKey : r.sourceTable,
      targetTable: oldCandidateNames.has(r.targetTable) ? newKey : r.targetTable,
    }));
    saveCustomRelationships();
    inspectorTarget.value = { kind: "table", tableName: newKey };
  }
  persistDraftAndLayers();
  const layer = layerStore.getLayerByTable(next.name) || layerStore.getLayerByTable(getTableKey(next));
  if (layer) sizeLayerToFit(layer, positions.value, tableHeightsMap());
  syncVueFlowNodes();
}

function handleDeleteDraftTable(tableName: string) {
  recordHistory();
  const deletedTable = tables.value.find((table) => getTableKey(table) === tableName || table.name === tableName);
  if (!deletedTable) return;
  const targetKey = getTableKey(deletedTable);
  const rawName = deletedTable.name;
  const isUniqueName = tables.value.filter((t) => t.name === rawName).length === 1;

  // Accurately filter out ONLY the deleted table by reference or canonical composite key
  tables.value = tables.value.filter((t) => t !== deletedTable && getTableKey(t) !== targetKey);

  const nextPositions = { ...positions.value };
  delete nextPositions[targetKey];
  delete nextPositions[tableName];
  if (!isMultiSchema.value || isUniqueName) {
    delete nextPositions[rawName];
  }
  positions.value = nextPositions;

  const targetNamesToClean = (!isMultiSchema.value || isUniqueName) && rawName !== targetKey ? [targetKey, rawName] : [targetKey];

  for (const layer of layerStore.layers) {
    let modified = false;
    for (const name of targetNamesToClean) {
      if (layer.tableNames.includes(name)) {
        layerStore.removeTableFromLayer(layer.id, name);
        modified = true;
      }
    }
    if (modified) {
      sizeLayerToFit(layer, positions.value, tableHeightsMap());
    }
  }

  const removeRelSet = new Set(targetNamesToClean);
  customRelationships.value = customRelationships.value.filter((r) => !removeRelSet.has(r.sourceTable) && !removeRelSet.has(r.targetTable));
  saveCustomRelationships();

  if (inspectorTarget.value?.kind === "table" && (inspectorTarget.value.tableName === targetKey || inspectorTarget.value.tableName === tableName)) {
    inspectorTarget.value = null;
  }

  persistDraftAndLayers();
  syncVueFlowNodes();
}

function handleDeleteLiveTable(tableName: string) {
  recordHistory();
  const deletedTable = tables.value.find((table) => getTableKey(table) === tableName || table.name === tableName);
  if (!deletedTable) return;
  const targetKey = getTableKey(deletedTable);
  const rawName = deletedTable.name;
  const isUniqueName = tables.value.filter((t) => t.name === rawName).length === 1;

  // Mark strictly the matched table as pendingDrop
  tables.value = tables.value.map((table) => {
    if ((table !== deletedTable && getTableKey(table) !== targetKey) || isDraftTable(table)) return table;
    return {
      ...table,
      pendingDrop: true,
      pendingColumnNames: undefined,
      droppedColumnNames: undefined,
    };
  });

  const targetNamesToClean = (!isMultiSchema.value || isUniqueName) && rawName !== targetKey ? [targetKey, rawName] : [targetKey];

  for (const layer of layerStore.layers) {
    let modified = false;
    for (const name of targetNamesToClean) {
      if (layer.tableNames.includes(name)) {
        layerStore.removeTableFromLayer(layer.id, name);
        modified = true;
      }
    }
    if (modified) {
      sizeLayerToFit(layer, positions.value, tableHeightsMap());
    }
  }

  const removeRelSet = new Set(targetNamesToClean);
  customRelationships.value = customRelationships.value.filter((r) => !removeRelSet.has(r.sourceTable) && !removeRelSet.has(r.targetTable));
  saveCustomRelationships();

  if (inspectorTarget.value?.kind === "table" && (inspectorTarget.value.tableName === targetKey || inspectorTarget.value.tableName === tableName)) {
    inspectorTarget.value = null;
  }

  persistDraftAndLayers();
  syncVueFlowNodes();
}

function deleteTableFromDiagram(tableName: string) {
  const table = tables.value.find((t) => t.name === tableName || getTableKey(t) === tableName);
  if (!table || table.pendingDrop) return;
  if (isDraftTable(table)) {
    handleDeleteDraftTable(tableName);
    return;
  }
  handleDeleteLiveTable(tableName);
}

function handleInspectorRemoveRelationship(id: string) {
  recordHistory();
  customRelationships.value = customRelationships.value.filter((r) => r.id !== id);
  matchConfirms.value = matchConfirms.value.filter((x) => x !== id);
  if (!matchIgnores.value.includes(id)) matchIgnores.value = [...matchIgnores.value, id];
  saveCustomRelationships();
  saveMatchData();
  refreshMatchResult();
  if (inspectorTarget.value?.kind === "edge" && inspectorTarget.value.edgeId === id) {
    inspectorTarget.value = null;
  }
  syncHighlightEdgeId();
  syncVueFlowNodes();
}

async function handleSyncedDraftTables(_names: string[]) {
  toast(t("diagram.syncToDatabase"), 2000);
  await loadDiagram({ force: true });
}

function syncVueFlowNodes() {
  const heights = tableHeightsMap();
  const tableNodes = toVueFlowNodes(visibleTables.value, positions.value, isMultiSchema.value);
  const layerNodes = toVueFlowLayerNodes(layerStore.layers);
  const vueEdges = toVueFlowEdges(visibleRelationships.value, positions.value, edgeWaypoints.value, heights, edgeHandleHints.value);
  setNodes([...layerNodes, ...tableNodes]);
  setEdges(vueEdges);
}

function relationshipStorageKey(): string {
  if (!connectionId.value || !database.value) return "";
  return ["dbx", "diagram", "relationships", "v1", connectionId.value, database.value, effectiveSchemaKey.value].join(":");
}

function isStoredRelationship(value: unknown): value is CustomDiagramRelationship {
  const relationship = value as Partial<CustomDiagramRelationship>;
  return (
    typeof relationship?.id === "string" &&
    typeof relationship.name === "string" &&
    typeof relationship.sourceTable === "string" &&
    typeof relationship.sourceColumn === "string" &&
    typeof relationship.targetTable === "string" &&
    typeof relationship.targetColumn === "string" &&
    (relationship.sourceCardinality === "1" || relationship.sourceCardinality === "N") &&
    (relationship.targetCardinality === "1" || relationship.targetCardinality === "N")
  );
}

function loadCustomRelationships() {
  const key = relationshipStorageKey();
  if (!key || typeof localStorage === "undefined") {
    customRelationships.value = [];
    return;
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    customRelationships.value = Array.isArray(parsed) ? parsed.filter(isStoredRelationship) : [];
  } catch {
    customRelationships.value = [];
  }
}

function saveCustomRelationships() {
  const key = relationshipStorageKey();
  if (!key || typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(customRelationships.value));
}

function loadMatchData() {
  if (!connectionId.value || !database.value) return;
  const querySchema = effectiveSchemaKey.value || database.value;
  matchConfirms.value = loadMatchConfirms(connectionId.value, database.value, querySchema);
  matchIgnores.value = loadMatchIgnores(connectionId.value, database.value, querySchema);

  if (isAutoMatchEnabled() && tables.value.length > 0) {
    const inferred = inferRelationships(tables.value);
    matchResult.value = filterByStorage(inferred, matchConfirms.value, matchIgnores.value);
  }
}

function saveMatchData() {
  if (!connectionId.value || !database.value) return;
  const querySchema = effectiveSchemaKey.value || database.value;
  saveMatchConfirms(matchConfirms.value, connectionId.value, database.value, querySchema);
  saveMatchIgnores(matchIgnores.value, connectionId.value, database.value, querySchema);
}

function promoteInferredToCustom(inferred: { sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string }, cardinality: { sourceCardinality: "1" | "N"; targetCardinality: "1" | "N" }) {
  const relationship = normalizeCustomDiagramRelationship({
    name: defaultRelationshipName({
      sourceTable: inferred.sourceTable,
      sourceColumn: inferred.sourceColumn,
      targetTable: inferred.targetTable,
      targetColumn: inferred.targetColumn,
      ...cardinality,
    }),
    sourceTable: inferred.sourceTable,
    sourceColumn: inferred.sourceColumn,
    targetTable: inferred.targetTable,
    targetColumn: inferred.targetColumn,
    ...cardinality,
  });

  const alreadyExists = customRelationships.value.some((item) => item.sourceTable === relationship.sourceTable && item.sourceColumn === relationship.sourceColumn && item.targetTable === relationship.targetTable && item.targetColumn === relationship.targetColumn);
  if (alreadyExists) return;

  customRelationships.value = [...customRelationships.value, relationship];
  saveCustomRelationships();
}

function findInferredById(id: string) {
  return matchResult.value.relationships.find((r) => r.id === id) || matchResult.value.conflicts.find((r) => r.id === id) || matchResult.value.pending.find((r) => r.id === id);
}

function confirmMatch(payload: { id: string; sourceCardinality: "1" | "N"; targetCardinality: "1" | "N" }) {
  recordHistory();
  const inferred = findInferredById(payload.id);
  if (inferred) {
    promoteInferredToCustom(inferred, {
      sourceCardinality: payload.sourceCardinality,
      targetCardinality: payload.targetCardinality,
    });
  }
  if (!matchConfirms.value.includes(payload.id)) {
    matchConfirms.value = [...matchConfirms.value, payload.id];
  }
  matchIgnores.value = matchIgnores.value.filter((i) => i !== payload.id);
  saveMatchData();
  refreshMatchResult();
  syncVueFlowNodes();
}

function ignoreMatch(id: string) {
  recordHistory();
  if (!matchIgnores.value.includes(id)) {
    matchIgnores.value = [...matchIgnores.value, id];
  }
  matchConfirms.value = matchConfirms.value.filter((i) => i !== id);
  saveMatchData();
  refreshMatchResult();
  syncVueFlowNodes();
}

function confirmAllMatches(payload: Array<{ id: string; sourceCardinality: "1" | "N"; targetCardinality: "1" | "N" }>) {
  if (payload.length === 0) return;
  recordHistory();
  for (const item of payload) {
    const inferred = findInferredById(item.id);
    if (inferred) {
      promoteInferredToCustom(inferred, {
        sourceCardinality: item.sourceCardinality,
        targetCardinality: item.targetCardinality,
      });
    }
  }
  const pendingIds = payload.map((r) => r.id);
  matchConfirms.value = [...new Set([...matchConfirms.value, ...pendingIds])];
  matchIgnores.value = matchIgnores.value.filter((id) => !pendingIds.includes(id));
  saveMatchData();
  refreshMatchResult();
  syncVueFlowNodes();
}

function ignoreAllMatches() {
  const pendingIds = matchResult.value.pending.map((r) => r.id);
  if (pendingIds.length === 0) return;
  recordHistory();
  matchIgnores.value = [...new Set([...matchIgnores.value, ...pendingIds])];
  matchConfirms.value = matchConfirms.value.filter((id) => !pendingIds.includes(id));
  saveMatchData();
  refreshMatchResult();
  syncVueFlowNodes();
}

function clearAllMatches() {
  if (matchConfirms.value.length === 0 && matchIgnores.value.length === 0) return;
  recordHistory();
  matchConfirms.value = [];
  matchIgnores.value = [];
  saveMatchData();
  refreshMatchResult();
  syncVueFlowNodes();
}

function refreshMatchResult() {
  if (isAutoMatchEnabled() && tables.value.length > 0) {
    const inferred = inferRelationships(tables.value);
    matchResult.value = filterByStorage(inferred, matchConfirms.value, matchIgnores.value);
  }
}

function handleToggleMatchPanel() {
  showMatchPanel.value = !showMatchPanel.value;
  if (showMatchPanel.value) {
    inspectorTarget.value = null;
    syncHighlightEdgeId();
    updateRelationshipDraftDefaults();
    refreshMatchResult();
    syncVueFlowNodes();
  }
}

function defaultRelationshipName(relationship: Omit<CustomDiagramRelationship, "id" | "name">): string {
  return `${relationship.sourceTable}_${relationship.sourceColumn}_${relationship.targetTable}_${relationship.targetColumn}`;
}

function relationshipCardinality(): Pick<CustomDiagramRelationship, "sourceCardinality" | "targetCardinality"> {
  return cardinalityPairFromChoice(relationshipDraft.value.cardinality);
}

function updateRelationshipDraftDefaults() {
  const availableTables = tables.value.filter((table) => table.columns.length > 0);
  if (availableTables.length === 0) return;

  if (!tableMap.value.has(relationshipDraft.value.sourceTable)) {
    relationshipDraft.value.sourceTable = availableTables[0].name;
  }
  if (!tableMap.value.has(relationshipDraft.value.targetTable)) {
    relationshipDraft.value.targetTable = availableTables[1]?.name ?? availableTables[0].name;
  }
  if (!sourceColumns.value.some((column) => column.name === relationshipDraft.value.sourceColumn)) {
    relationshipDraft.value.sourceColumn = sourceColumns.value[0]?.name ?? "";
  }
  if (!targetColumns.value.some((column) => column.name === relationshipDraft.value.targetColumn)) {
    relationshipDraft.value.targetColumn = targetColumns.value[0]?.name ?? "";
  }
}

function addCustomRelationship() {
  updateRelationshipDraftDefaults();
  const { sourceTable, sourceColumn, targetTable, targetColumn } = relationshipDraft.value;
  if (!sourceTable || !sourceColumn || !targetTable || !targetColumn) {
    toast(t("diagram.relationshipIncomplete"), 3000);
    return;
  }
  if (sourceTable === targetTable && sourceColumn === targetColumn) {
    toast(t("diagram.relationshipSelfInvalid"), 3000);
    return;
  }

  const cardinality = relationshipCardinality();
  const relationship = normalizeCustomDiagramRelationship({
    name: relationshipDraft.value.name.trim() || defaultRelationshipName({ sourceTable, sourceColumn, targetTable, targetColumn, ...cardinality }),
    sourceTable,
    sourceColumn,
    targetTable,
    targetColumn,
    ...cardinality,
  });

  if (customRelationships.value.some((item) => item.id === relationship.id)) {
    toast(t("diagram.relationshipExists"), 3000);
    return;
  }

  recordHistory();
  customRelationships.value = [...customRelationships.value, relationship];
  relationshipDraft.value.name = "";
  saveCustomRelationships();
  syncVueFlowNodes();
  toast(t("diagram.relationshipAdded"), 2000);
}

function removeCustomRelationship(id: string) {
  recordHistory();
  customRelationships.value = customRelationships.value.filter((relationship) => relationship.id !== id);
  saveCustomRelationships();
  syncVueFlowNodes();
}

function updateCustomRelationship(oldId: string, patch: Omit<CustomDiagramRelationship, "id"> & { id?: string }) {
  if (patch.sourceTable === patch.targetTable && patch.sourceColumn === patch.targetColumn) {
    toast(t("diagram.relationshipSelfInvalid"), 3000);
    return;
  }
  const next = normalizeCustomDiagramRelationship({
    ...patch,
    name: patch.name.trim() || defaultRelationshipName(patch),
  });
  const duplicate = customRelationships.value.some((item) => item.id !== oldId && item.id === next.id);
  if (duplicate) {
    toast(t("diagram.relationshipExists"), 3000);
    return;
  }
  recordHistory();
  customRelationships.value = customRelationships.value.filter((relationship) => relationship.id !== oldId).concat(next);
  if (edgeWaypoints.value[oldId]) {
    const points = edgeWaypoints.value[oldId];
    const { [oldId]: _, ...rest } = edgeWaypoints.value;
    edgeWaypoints.value = { ...rest, [next.id]: points };
  }
  saveCustomRelationships();
  syncVueFlowNodes();
  inspectorTarget.value = { kind: "edge", edgeId: next.id };
  syncHighlightEdgeId();
  toast(t("diagram.relationshipUpdated"), 2000);
}

function handleInspectorSaveRelationship(payload: Omit<CustomDiagramRelationship, "id"> & { id?: string }) {
  const currentId = inspectorTarget.value?.kind === "edge" ? inspectorTarget.value.edgeId : null;
  if (!currentId) return;
  updateCustomRelationship(payload.id || currentId, payload);
}

function handleInspectorConfirmRelationship(payload: { id: string; sourceCardinality: "1" | "N"; targetCardinality: "1" | "N" }) {
  confirmMatch(payload);
  inspectorTarget.value = null;
  syncHighlightEdgeId();
}

function handleInspectorIgnoreRelationship(id: string) {
  ignoreMatch(id);
  inspectorTarget.value = null;
  syncHighlightEdgeId();
}

async function copyJoinSql() {
  if (!generatedJoinSql.value.trim()) {
    toast(t("diagram.noJoinSql"), 3000);
    return;
  }
  try {
    await copyToClipboard(generatedJoinSql.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function loadDatabases(id: string) {
  if (!id) return;
  const generation = namespaceGeneration;
  const active = () => open.value && generation === namespaceGeneration && id === connectionId.value;
  loadingDatabases.value = true;
  databases.value = [];
  try {
    await store.ensureConnected(id);
    if (!active()) return;
    const config = store.getConfig(id);
    const names =
      config?.db_type === "dameng"
        ? await fetchNamespaceOptionsForConnection(id, config)
        : databaseOptionsForConnection(
            (await api.listDatabases(id)).map((db) => db.name),
            config,
          );
    if (active()) databases.value = names;
  } catch (error: any) {
    if (active()) toast(error?.message || String(error), 5000);
  } finally {
    if (active()) loadingDatabases.value = false;
  }
}

async function loadSchemas() {
  schemas.value = [];
  schema.value = "";
  selectedSchemas.value = [];
  if (!connectionId.value || !database.value) return;
  if (!isSchemaAware.value) {
    schema.value = database.value;
    selectedSchemas.value = [database.value];
    return;
  }
  const id = connectionId.value;
  const db = database.value;
  const catalog = props.prefillCatalog;
  const generation = namespaceGeneration;
  const active = () => open.value && generation === namespaceGeneration && id === connectionId.value && db === database.value && catalog === props.prefillCatalog;
  loadingSchemas.value = true;
  try {
    const names = await api.listSchemas(id, db);
    if (!active()) return;
    schemas.value = names;
    const defaultSchema = props.prefillSchema && names.includes(props.prefillSchema) ? props.prefillSchema : names.includes("public") ? "public" : (names[0] ?? "");
    schema.value = defaultSchema;
    selectedSchemas.value = defaultSchema ? [defaultSchema] : [];
  } catch (error: any) {
    if (active()) toast(error?.message || String(error), 5000);
  } finally {
    if (active()) loadingSchemas.value = false;
  }
}

async function setConnection(id: string) {
  namespaceGeneration++;
  connectionId.value = id;
  database.value = "";
  schema.value = "";
  selectedSchemas.value = [];
  tables.value = [];
  persistedTableSnapshot = [];
  customRelationships.value = [];
  positions.value = {};
  matchConfirms.value = [];
  matchIgnores.value = [];
  matchResult.value = { relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } };
  const generation = namespaceGeneration;
  await loadDatabases(id);
  if (!open.value || generation !== namespaceGeneration || id !== connectionId.value) return;
  if (databases.value.length === 1) {
    await setDatabase(databases.value[0]);
  }
}

async function setDatabase(value: string) {
  namespaceGeneration++;
  database.value = value;
  tables.value = [];
  persistedTableSnapshot = [];
  selectedSchemas.value = [];
  customRelationships.value = [];
  positions.value = {};
  matchConfirms.value = [];
  matchIgnores.value = [];
  matchResult.value = { relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } };
  const id = connectionId.value;
  const generation = namespaceGeneration;
  await loadSchemas();
  if (!open.value || generation !== namespaceGeneration || id !== connectionId.value || value !== database.value) return;
  diagramNamespaceSnapshots.set(JSON.stringify([id, value, props.prefillCatalog]), { databases: [...databases.value], schemas: [...schemas.value], defaultSchema: schema.value });
  if (diagramReady.value) await loadDiagram();
}

async function setSchema(value: string) {
  namespaceGeneration++;
  schema.value = value;
  selectedSchemas.value = value ? [value] : [];
  tables.value = [];
  persistedTableSnapshot = [];
  customRelationships.value = [];
  positions.value = {};
  matchConfirms.value = [];
  matchIgnores.value = [];
  matchResult.value = { relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } };
  if (diagramReady.value) await loadDiagram();
}

async function setSelectedSchemas(values: string[]) {
  namespaceGeneration++;
  selectedSchemas.value = [...values];
  schema.value = values.length === 1 ? values[0] : "";
  tables.value = [];
  persistedTableSnapshot = [];
  customRelationships.value = [];
  positions.value = {};
  matchConfirms.value = [];
  matchIgnores.value = [];
  matchResult.value = { relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } };
  if (diagramReady.value) await loadDiagram();
}

async function loadFullDiagram(request: FocusedDiagramLoadRequest, targetSchemas: string[], active: () => boolean): Promise<DiagramTable[]> {
  const { connectionId: id, database: db, catalog } = request;
  const lists = await Promise.all(
    targetSchemas.map(async (sc) => {
      try {
        const list = await api.listTables(id, db, sc, undefined, undefined, undefined, undefined, catalog);
        return list.filter((table) => table.table_type !== "VIEW" && table.table_type !== "MATERIALIZED_VIEW").map((table) => ({ name: table.name, schema: sc, comment: table.comment ?? null }));
      } catch (error) {
        console.warn(`[diagram] failed to list tables for schema ${sc}`, error);
        return [];
      }
    }),
  );
  const baseTables = lists.flat().sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  if (active()) totalTableCount.value = baseTables.length;
  const result: DiagramTable[] = [];
  for (let index = 0; index < baseTables.length; index += METADATA_BATCH_SIZE) {
    if (!active()) return result;
    const batch = await Promise.all(
      baseTables.slice(index, index + METADATA_BATCH_SIZE).map(async (table) => {
        try {
          const [columns, foreignKeys, indexes] = await Promise.all([api.getColumns(id, db, table.schema, table.name, catalog), api.listForeignKeys(id, db, table.schema, table.name, catalog).catch(() => []), api.listIndexes(id, db, table.schema, table.name, catalog).catch(() => [])]);
          return { ...table, columns, foreignKeys, indexes: diagramIndexes(indexes) };
        } catch (error) {
          if (active()) failedTableCount.value += 1;
          console.warn(`[diagram] failed to load table metadata: ${table.schema}.${table.name}`, error);
          return { ...table, columns: [], foreignKeys: [], indexes: [] };
        }
      }),
    );
    result.push(...batch);
    if (active()) loadedTableCount.value = result.length;
  }
  return result;
}

function diagramContextKey(): string {
  return JSON.stringify([connectionId.value, database.value, props.prefillCatalog, schema.value, selectedSchemas.value, focusedRoots.value]);
}

async function loadDiagram(options: { mode?: DiagramLoadMode; force?: boolean } = {}): Promise<void> {
  if (!diagramReady.value) return;
  const generation = ++diagramLoadGeneration;
  const context = diagramContextKey();
  const active = () => open.value && generation === diagramLoadGeneration && context === diagramContextKey();
  const mode = options.mode ?? (focusedRoots.value.length && !showAllTables.value ? "focused" : "full");
  if (tables.value.length === 0) loadedDiagramScope.value = mode;
  const request: FocusedDiagramLoadRequest = {
    connectionId: connectionId.value,
    database: database.value,
    catalog: props.prefillCatalog,
    roots: focusedRoots.value,
    concurrency: METADATA_BATCH_SIZE,
    onProgress: (loaded, discovered) => {
      if (!active()) return;
      loadedTableCount.value = loaded;
      totalTableCount.value = discovered;
    },
  };
  const key = focusedDiagramCacheKey(request);
  const cached = mode === "focused" && !options.force ? getFocusedDiagramCache(key) : undefined;
  // Check memory before connecting or showing the remote loading state.
  loadingDiagram.value = !cached;
  loadedTableCount.value = cached?.length ?? 0;
  totalTableCount.value = cached?.length ?? 0;
  failedTableCount.value = 0;
  try {
    let liveTables = cached;
    if (!liveTables) {
      const { connectionId: id, database: db, catalog } = request;
      if (mode === "focused") {
        liveTables = await loadFocusedDiagramCached(
          key,
          async () => {
            await store.ensureConnected(id);
            const result = await loadFocusedDiagram(request, {
              getColumns: (table) => api.getColumns(id, db, table.schema, table.name, catalog),
              listForeignKeys: (table) => api.listForeignKeys(id, db, table.schema, table.name, catalog),
              listIndexes: (table) => api.listIndexes(id, db, table.schema, table.name, catalog),
              getTableComment: (table) => api.getTableComment(id, db, table.schema, table.name, catalog),
            });
            return result.tables;
          },
          { force: options.force },
        );
      } else {
        const targetSchemas = isSchemaAware.value ? [...selectedSchemas.value] : [db];
        await store.ensureConnected(id);
        if (!active()) return;
        liveTables = await loadFullDiagram(request, targetSchemas, active);
      }
    }
    if (!active()) return;
    loadedTableCount.value = totalTableCount.value = liveTables.length;
    await applyLoadedDiagramTables(liveTables, mode, active);
    if (active() && failedTableCount.value > 0) toast(t("diagram.partialError", { count: failedTableCount.value }), 5000);
  } catch (error: any) {
    if (active()) toast(error?.message || String(error), 5000);
  } finally {
    if (active()) loadingDiagram.value = false;
  }
}

async function applyLoadedDiagramTables(liveTables: DiagramTable[], mode: DiagramLoadMode, active: () => boolean) {
  const schemaKey = effectiveSchemaKey.value;
  const drafts = loadDraftTables(connectionId.value, database.value, schemaKey);
  const identity = (table: DiagramTable) => diagramIdentityKey({ ...table, schema: table.schema ?? selectedSchemas.value[0] ?? schema.value });
  const liveKeys = new Set(liveTables.map(identity));
  const pendingDrafts = drafts.filter((draft) => !liveKeys.has(identity(draft)));
  const patches = loadLiveTablePatches(connectionId.value, database.value, schemaKey);
  const nextTables = applyLiveTablePatches([...liveTables, ...pendingDrafts], patches, selectedSchemas.value.length === 1 ? selectedSchemas.value[0] : undefined);
  tables.value = nextTables;
  loadedDiagramScope.value = mode;
  showAllTables.value = mode === "full" && focusedRoots.value.length > 0;
  positions.value = {};
  // Metadata reconciliation must not be mistaken for an edit to a saved live patch.
  persistedTableSnapshot = deepCloneJson(nextTables);
  if (mode === "full") {
    saveDraftTables(nextTables, connectionId.value, database.value, schemaKey);
    saveLiveTablePatches(nextTables, connectionId.value, database.value, schemaKey);
  } else if (pendingDrafts.length !== drafts.length) {
    // Only remove drafts whose exact identities were confirmed live by this load.
    saveDraftTables(pendingDrafts, connectionId.value, database.value, schemaKey);
  }
  layerStore.loadLayers(loadPersistedLayers(connectionId.value, database.value, schemaKey));
  if (isMultiSchema.value) {
    for (const layer of layerStore.layers) {
      layer.tableNames = layer.tableNames.map((name) => {
        const matches = tables.value.filter((table) => table.name === name && (mode !== "focused" || !table.schema || table.schema === selectedSchemas.value[0]));
        return matches.length === 1 ? getTableKey(matches[0]) : name;
      });
    }
  }
  loadCustomRelationships();
  loadMatchData();
  updateRelationshipDraftDefaults();
  loadingDiagram.value = false;
  await nextTick();
  if (!active()) return;
  await restoreOrInitializeLayout(active);
  if (active()) graphStore.clearHistory();
}

async function handleToggleShowAllTables(): Promise<void> {
  if (loadingDiagram.value || !focusedRoots.value.length) return;
  await loadDiagram({ mode: showAllTables.value ? "focused" : "full" });
}

/** Restore saved table positions, or run layer-aware LTR layout when none exist. */
async function restoreOrInitializeLayout(active: () => boolean = () => true) {
  const schemaKey = effectiveSchemaKey.value;
  const tableKeys = tables.value.map((t) => getTableKey(t));
  const tableNames = tables.value.map((t) => t.name);
  const savedPositions = loadPersistedPositions(connectionId.value, database.value, schemaKey);

  if (hasUsablePersistedPositions(savedPositions, tableKeys) || hasUsablePersistedPositions(savedPositions, tableNames)) {
    const next: Record<string, DiagramPosition> = {};
    for (const table of tables.value) {
      const key = getTableKey(table);
      const pos = savedPositions[key] || (canUseUnqualifiedTableName(table) ? savedPositions[table.name] : undefined);
      if (pos) next[key] = { ...pos };
    }
    positions.value = next;
    fillMissingTablePositions();
    fitAllLayers();
    persistDraftAndLayers();
    syncVueFlowNodes();
    await nextTick();
    fitDiagramView();
    return;
  }

  await applyInitialLayerAwareLayout(active);
}

/** Place tables that have no saved position into their layer (or canvas grid). */
function fillMissingTablePositions() {
  const heights = tableHeightsMap();
  const missing = tables.value.filter((t) => !positions.value[getTableKey(t)]);
  if (missing.length === 0) return;

  for (const table of missing) {
    const key = getTableKey(table);
    const layer = layerStore.getLayerByTable(key) || layerStore.getLayerByTable(table.name);
    if (layer?.position) {
      const memberPositions = layer.tableNames.map((name) => positions.value[name]).filter((pos): pos is DiagramPosition => !!pos);
      if (memberPositions.length === 0) {
        positions.value = {
          ...positions.value,
          [key]: {
            x: layer.position.x + LAYER_CONTENT_PADDING,
            y: layer.position.y + LAYER_HEADER_HEIGHT + LAYER_CONTENT_PADDING,
          },
        };
      } else {
        let maxBottom = layer.position.y + LAYER_HEADER_HEIGHT;
        let leftMost = layer.position.x + LAYER_CONTENT_PADDING;
        for (const name of layer.tableNames) {
          const pos = positions.value[name];
          if (!pos) continue;
          leftMost = Math.min(leftMost, pos.x);
          maxBottom = Math.max(maxBottom, pos.y + (heights[name] ?? 120));
        }
        positions.value = {
          ...positions.value,
          [key]: { x: leftMost, y: maxBottom + GAP_Y / 2 },
        };
      }
    } else {
      const count = Object.keys(positions.value).length;
      positions.value = {
        ...positions.value,
        [key]: {
          x: MARGIN + (count % 3) * (CARD_WIDTH + GAP_X),
          y: MARGIN + Math.floor(count / 3) * 200,
        },
      };
    }
  }
}

async function applyInitialLayerAwareLayout(active: () => boolean = () => true) {
  await nextTick();
  if (!active()) return;
  const layoutTables = canvasVisibleTables.value;
  if (layoutTables.length === 0) {
    syncVueFlowNodes();
    return;
  }

  // Free layers with no member positions cannot preserve relative layout — treat as auto for init.
  const layersForLayout = layerStore.layers
    .filter((l) => l.visible && canLayoutLayer(l))
    .map((l) => {
      const hasMemberPos = l.tableNames.some((name) => positions.value[name]);
      if ((l.layoutMode ?? "auto") === "free" && !hasMemberPos) {
        return { ...l, layoutMode: "auto" as const };
      }
      return l;
    });

  const result = computeLtrAutoLayout({
    tables: layoutTables.map((table) => ({ ...table, name: getTableKey(table) })),
    positions: positions.value,
    layers: layersForLayout,
    paneWidth: diagramPaneWidth(),
    relationships: canvasVisibleRelationships.value.map((r) => ({
      sourceTable: r.sourceTable,
      targetTable: r.targetTable,
    })),
  });

  const nextPositions: Record<string, DiagramPosition> = { ...positions.value, ...result.positions };
  for (const table of layoutTables) {
    const key = getTableKey(table);
    if (result.positions[table.name] && !nextPositions[key]) {
      nextPositions[key] = result.positions[table.name];
    }
    if (result.positions[key] && !nextPositions[table.name] && canUseUnqualifiedTableName(table)) {
      nextPositions[table.name] = result.positions[key];
    }
  }
  positions.value = nextPositions;

  for (const updated of result.layers) {
    const layer = layerStore.layers.find((l) => l.id === updated.id);
    if (!layer) continue;
    layer.position = updated.position ? { ...updated.position } : layer.position;
    layer.width = updated.width;
    layer.height = updated.height;
  }

  fitAllFreeLayers();
  persistDraftAndLayers();
  syncVueFlowNodes();
  await nextTick();
  fitDiagramView();
}

function requestRefreshDiagram() {
  if (!diagramReady.value || loadingDiagram.value) return;
  showRefreshConfirm.value = true;
}

function confirmRefreshDiagram() {
  showRefreshConfirm.value = false;
  void loadDiagram({ force: true });
}

async function initialize() {
  namespaceGeneration++;
  const generation = ++initializationGeneration;
  diagramLoadGeneration++;
  loadingDiagram.value = false;
  loadingDatabases.value = false;
  loadingSchemas.value = false;
  persistedTableSnapshot = [];
  connectionId.value = "";
  database.value = "";
  schema.value = "";
  databases.value = [];
  schemas.value = [];
  tables.value = [];
  customRelationships.value = [];
  tableSearch.value = "";
  showAllTables.value = false;
  showMatchPanel.value = false;
  diagramMode.value = "table";
  positions.value = {};
  loadedTableCount.value = 0;
  totalTableCount.value = 0;
  failedTableCount.value = 0;
  matchConfirms.value = [];
  matchIgnores.value = [];
  matchResult.value = { relationships: [], conflicts: [], pending: [], stats: { total: 0, high: 0, medium: 0 } };
  layerStore.clearLayers();
  graphStore.clearHistory();
  graphStore.setNodes([]);
  graphStore.setEdges([]);

  if (props.prefillConnectionId && props.prefillDatabase && (props.focusTableName || props.focusTableNames?.length)) {
    const names = props.focusTableNames?.length ? props.focusTableNames : [props.focusTableName!];
    const namespace = diagramNamespaceSnapshots.get(JSON.stringify([props.prefillConnectionId, props.prefillDatabase, props.prefillCatalog]));
    const rootSchema = props.prefillSchema || namespace?.defaultSchema || props.prefillDatabase;
    const request = { connectionId: props.prefillConnectionId, database: props.prefillDatabase, catalog: props.prefillCatalog, roots: names.map((name) => ({ name, schema: rootSchema })) };
    if (namespace && getFocusedDiagramCache(focusedDiagramCacheKey(request))) {
      connectionId.value = request.connectionId;
      database.value = request.database;
      schema.value = rootSchema;
      databases.value = [...namespace.databases];
      schemas.value = [...namespace.schemas];
      selectedSchemas.value = [rootSchema];
      await loadDiagram();
      return;
    }
  }
  if (props.prefillConnectionId) {
    connectionId.value = props.prefillConnectionId;
    await loadDatabases(props.prefillConnectionId);
    if (!open.value || generation !== initializationGeneration) return;
    const initialDatabase = props.prefillDatabase && databases.value.includes(props.prefillDatabase) ? props.prefillDatabase : props.prefillDatabase || databases.value[0] || "";
    if (initialDatabase) await setDatabase(initialDatabase);
    return;
  }

  if (sqlConnections.value.length === 1) {
    await setConnection(sqlConnections.value[0].id);
  }
}

function zoomIn() {
  if (diagramMode.value !== "table") return;
  vfZoomIn({ duration: 150 });
}

function zoomOut() {
  if (diagramMode.value !== "table") return;
  vfZoomOut({ duration: 150 });
}

const isFullscreen = ref(false);
/** Only exit fullscreen on dialog close when this page entered it. */
let diagramOwnedFullscreen = false;
let unlistenWindowResize: (() => void) | null = null;
let fullscreenTransitionTarget: boolean | null = null;
let viewportBeforeFullscreen: ViewportTransform | null = null;

const FULLSCREEN_SYNC_ATTEMPTS = 40;
const FULLSCREEN_SYNC_INTERVAL_MS = 50;

const dialogStyle = computed(() => {
  if (isFullscreen.value) {
    return {
      width: "100%",
      height: "100%",
      maxWidth: "100%",
      maxHeight: "100%",
      borderRadius: "0",
    };
  }
  return {
    width: "94vw",
    height: "86vh",
    maxWidth: "94vw",
    maxHeight: "86vh",
  };
});

async function syncFullscreenState() {
  if (isTauriRuntime()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const actualFullscreen = await getCurrentWindow().isFullscreen();
      isFullscreen.value = fullscreenTransitionTarget ?? actualFullscreen;
    } catch {
      isFullscreen.value = fullscreenTransitionTarget ?? false;
    }
  } else {
    isFullscreen.value = !!document.fullscreenElement;
  }
  if (!isFullscreen.value && fullscreenTransitionTarget === null) {
    diagramOwnedFullscreen = false;
  }
}

async function waitForTauriFullscreenState(appWindow: { isFullscreen: () => Promise<boolean> }, expected: boolean) {
  for (let attempt = 0; attempt < FULLSCREEN_SYNC_ATTEMPTS; attempt += 1) {
    if ((await appWindow.isFullscreen()) === expected) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, FULLSCREEN_SYNC_INTERVAL_MS));
  }
}

function captureDiagramViewport() {
  if (diagramMode.value !== "table" || viewportBeforeFullscreen) return;
  viewportBeforeFullscreen = { ...getViewport() };
}

async function restoreDiagramViewport() {
  const viewport = viewportBeforeFullscreen;
  viewportBeforeFullscreen = null;
  if (!viewport || diagramMode.value !== "table") return;
  await setViewport(viewport, { duration: 150 });
}

async function syncFullscreenLayout() {
  const wasFullscreen = isFullscreen.value;
  await syncFullscreenState();
  if (wasFullscreen === isFullscreen.value) return;
  await nextTick();
  if (isFullscreen.value) fitDiagramView();
  else await restoreDiagramViewport();
}

async function enterFullscreen() {
  captureDiagramViewport();
  if (isTauriRuntime()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    fullscreenTransitionTarget = true;
    try {
      await appWindow.setFullscreen(true);
      isFullscreen.value = true;
      await waitForTauriFullscreenState(appWindow, true);
    } finally {
      fullscreenTransitionTarget = null;
      await syncFullscreenState();
    }
  } else {
    await document.documentElement.requestFullscreen();
  }
  diagramOwnedFullscreen = true;
  await syncFullscreenState();
  await nextTick();
  fitDiagramView();
}

async function exitFullscreen() {
  const owned = diagramOwnedFullscreen;
  if (isTauriRuntime()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    fullscreenTransitionTarget = false;
    try {
      const currently = await appWindow.isFullscreen();
      if (currently) await appWindow.setFullscreen(false);
      isFullscreen.value = false;
      await waitForTauriFullscreenState(appWindow, false);
    } finally {
      fullscreenTransitionTarget = null;
      await syncFullscreenState();
    }
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
  if (owned) diagramOwnedFullscreen = false;
  await syncFullscreenState();
  await nextTick();
  await restoreDiagramViewport();
}

async function toggleFullscreen() {
  if (isFullscreen.value) await exitFullscreen();
  else await enterFullscreen();
}

function handleWebFullscreenChange() {
  void syncFullscreenLayout();
}

async function setupFullscreenListeners() {
  if (isTauriRuntime()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    unlistenWindowResize = await getCurrentWindow().onResized(() => {
      void syncFullscreenLayout();
    });
  } else {
    document.addEventListener("fullscreenchange", handleWebFullscreenChange);
  }
  await syncFullscreenState();
}

function teardownFullscreenListeners() {
  unlistenWindowResize?.();
  unlistenWindowResize = null;
  if (!isTauriRuntime()) {
    document.removeEventListener("fullscreenchange", handleWebFullscreenChange);
  }
}

function exportSvgLayers() {
  return layerStore.layers
    .filter((layer) => layer.visible)
    .map((layer) => ({
      id: layer.id,
      name: layer.name,
      color: layer.color,
      x: layer.position?.x ?? 0,
      y: layer.position?.y ?? 0,
      width: layer.width ?? 0,
      height: layer.height ?? 0,
    }));
}

/** Sync Vue Flow node positions into absolute canvas coords and fit visible layer bounds before export. */
function prepareTableDiagramExportGeometry() {
  const nextPositions: Record<string, DiagramPosition> = { ...positions.value };
  for (const node of nodes.value) {
    if (node.type === "layer") continue;
    nextPositions[node.id] = toAbsolutePosition(node.id, node.position, layerStore.layers);
  }
  positions.value = nextPositions;

  const heights = tableHeightsMap();
  for (const layer of layerStore.layers) {
    if (!layer.visible) continue;
    sizeLayerToFit(layer, positions.value, heights);
  }
}

function currentDiagramSvg(): string {
  if (diagramMode.value === "engineering") {
    return buildEngineeringDiagramSvg(engineeringDiagram.value);
  }

  prepareTableDiagramExportGeometry();

  // Positions are keyed by the diagram table id (`getTableKey`), which is schema-qualified in
  // multi-schema mode; hand that id to the exporter so cards are not all drawn at the origin.
  const exportTables = canvasVisibleTables.value.map((table) => ({ ...table, diagramKey: getTableKey(table) }));
  const exportRelationships = canvasVisibleRelationships.value;
  const layers = exportSvgLayers();
  const geometryInput = {
    relationships: exportRelationships,
    positions: positions.value,
    tables: exportTables,
    waypoints: edgeWaypoints.value,
    cardWidth: CARD_WIDTH,
  };
  const relationshipPolylines = buildTableRelationshipPolylines(geometryInput);
  const relationshipPaths = Object.fromEntries(Object.entries(relationshipPolylines).map(([id, points]) => [id, pointsToSvgPath(points)]));
  const canvas = computeTableDiagramCanvas(exportTables, positions.value, {
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    cardBottomPadding: CARD_BOTTOM_PADDING,
    layers,
    relationshipPolylines,
  });

  return buildTableDiagramSvg({
    tables: exportTables,
    relationships: exportRelationships,
    positions: positions.value,
    relationshipPaths,
    relationshipPolylines,
    canvas,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    cardBottomPadding: CARD_BOTTOM_PADDING,
    layers,
  });
}

function exportFormatLabel(format: DiagramExportFormat): string {
  switch (format) {
    case "svg":
      return t("diagram.exportSvg");
    case "png":
      return t("diagram.exportPng");
    case "json":
      return t("diagram.exportJson");
    case "dbml":
      return t("diagram.exportDbml");
    case "mermaid":
      return t("diagram.exportMermaid");
  }
}

async function exportDiagram(format: DiagramExportFormat) {
  try {
    const scopeName = isSchemaAware.value && effectiveSchemaKey.value ? `${database.value}-${effectiveSchemaKey.value}` : database.value;
    const defaultPath = diagramExportFileName(selectedConnection.value?.name ?? "", scopeName, diagramMode.value, format);

    let saved = false;
    if (format === "svg") {
      saved = await saveDiagramTextExport(defaultPath, currentDiagramSvg(), "svg");
    } else if (format === "png") {
      const svg = currentDiagramSvg();
      const png = await svgToPngBlob(svg, 2);
      saved = await saveDiagramBinaryExport(defaultPath, png, "png");
    } else if (format === "json") {
      const json = buildDiagramJson({
        meta: {
          connectionName: selectedConnection.value?.name ?? "",
          database: database.value,
          schema: effectiveSchemaKey.value,
          mode: diagramMode.value,
          exportedAt: new Date().toISOString(),
        },
        tables: visibleTables.value.map((table) => ({
          name: table.name,
          schema: table.schema,
          columns: table.columns.map((column) => ({
            name: column.name,
            dataType: column.data_type,
            nullable: column.is_nullable,
            primaryKey: column.is_primary_key,
          })),
          foreignKeys: table.foreignKeys.map((fk) => ({
            name: fk.name,
            column: fk.column,
            refTable: fk.ref_table,
            refColumn: fk.ref_column,
          })),
        })),
        relationships: visibleRelationships.value,
        positions: positions.value,
        layers: layerStore.toJSON(),
        customRelationships: customRelationships.value,
        matchConfirms: matchConfirms.value,
        matchIgnores: matchIgnores.value,
      });
      saved = await saveDiagramTextExport(defaultPath, json, "json");
    } else if (format === "dbml") {
      saved = await saveDiagramTextExport(defaultPath, buildDiagramDbml(visibleTables.value, visibleRelationships.value), "dbml");
    } else {
      saved = await saveDiagramTextExport(defaultPath, buildDiagramMermaid(visibleTables.value, visibleRelationships.value), "mermaid");
    }

    if (!saved) return;
    toast(t("diagram.exportedFormat", { format: exportFormatLabel(format) }));
  } catch (e: any) {
    toast(t("diagram.exportFailed", { format: exportFormatLabel(format), message: e?.message || String(e) }), 5000);
  }
}

const isSpacePressed = ref(false);

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && inspectorTarget.value) {
    e.preventDefault();
    inspectorTarget.value = null;
    syncHighlightEdgeId();
    return;
  }
  const target = e.target as HTMLElement | null;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  if (!typing && (e.ctrlKey || e.metaKey)) {
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
      return;
    }
    if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      handleRedo();
      return;
    }
  }
  if (!typing && (e.key === "Delete" || e.key === "Backspace")) {
    const selectedTableName = inspectorTarget.value?.kind === "table" ? inspectorTarget.value.tableName : nodes.value.find((n) => n.selected && n.type === "table")?.id;
    if (selectedTableName) {
      e.preventDefault();
      deleteTableFromDiagram(selectedTableName);
      return;
    }
  }
  if (!typing && (e.key === " " || e.key === "Spacebar")) {
    e.preventDefault();
    isSpacePressed.value = true;
  }
}

function handleKeyup(e: KeyboardEvent) {
  if (e.key === " " || e.key === "Spacebar") {
    isSpacePressed.value = false;
  }
}

watch(
  diagramContextKey,
  () => {
    diagramLoadGeneration++;
    loadingDiagram.value = false;
  },
  { flush: "sync" },
);

watch(
  () => [props.prefillConnectionId, props.prefillDatabase, props.prefillSchema, props.prefillCatalog, props.focusTableName, JSON.stringify(props.focusTableNames)],
  () => {
    if (open.value) void initialize();
  },
);

watch(
  open,
  (value) => {
    if (value) {
      void initialize();
      void setupFullscreenListeners();
    } else {
      diagramLoadGeneration++;
      initializationGeneration++;
      namespaceGeneration++;
      loadingDiagram.value = false;
      teardownFullscreenListeners();
      if (diagramOwnedFullscreen) {
        void exitFullscreen();
      }
    }
  },
  { immediate: true },
);

watch(
  () => visibleTables.value.map((table) => table.name).join("\n"),
  () => {
    // Search / focus filter: refresh nodes only — do not wipe manual positions
    syncVueFlowNodes();
  },
);

watch(
  () => relationshipDraft.value.sourceTable,
  () => {
    if (!sourceColumns.value.some((column) => column.name === relationshipDraft.value.sourceColumn)) {
      relationshipDraft.value.sourceColumn = sourceColumns.value[0]?.name ?? "";
    }
  },
);

watch(
  () => relationshipDraft.value.targetTable,
  () => {
    if (!targetColumns.value.some((column) => column.name === relationshipDraft.value.targetColumn)) {
      relationshipDraft.value.targetColumn = targetColumns.value[0]?.name ?? "";
    }
  },
);

watch(engineeringViewportRef, (viewport) => {
  engineeringResizeObserver?.disconnect();
  engineeringResizeObserver = null;
  if (!viewport || typeof ResizeObserver === "undefined") return;
  engineeringResizeObserver = new ResizeObserver(scheduleEngineeringViewportSync);
  engineeringResizeObserver.observe(viewport);
  scheduleEngineeringViewportSync();
});

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("keyup", handleKeyup);
});

onUnmounted(() => {
  diagramLoadGeneration++;
  initializationGeneration++;
  namespaceGeneration++;
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("keyup", handleKeyup);
  if (engineeringViewportFrame !== null) {
    window.cancelAnimationFrame(engineeringViewportFrame);
    engineeringViewportFrame = null;
  }
  engineeringResizeObserver?.disconnect();
  engineeringResizeObserver = null;
  teardownFullscreenListeners();
  if (diagramOwnedFullscreen) {
    void exitFullscreen();
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="gap-0 p-0 overflow-hidden flex flex-col min-w-0" :class="isFullscreen ? 'dbx-diagram-fullscreen' : 'sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw]'" :style="dialogStyle" :portal-class="isFullscreen ? 'p-0' : undefined">
      <DialogHeader class="px-4 py-3 border-b">
        <DialogTitle class="flex items-center gap-2">
          <Network class="w-4 h-4" />
          {{ t("diagram.title") }}
        </DialogTitle>
      </DialogHeader>

      <DiagramToolbar
        :connection-id="connectionId"
        :database="database"
        :schema="schema"
        :selected-schemas="selectedSchemas"
        :databases="databases"
        :schemas="schemas"
        :sql-connections="sqlConnections"
        :selected-connection="selectedConnection"
        :is-schema-aware="isSchemaAware"
        :loading-databases="loadingDatabases"
        :loading-schemas="loadingSchemas"
        :loading-diagram="loadingDiagram"
        :diagram-ready="diagramReady"
        :tables-count="visibleTables.length"
        :relationships-count="visibleRelationships.length"
        :custom-relationship-count="customRelationshipCount"
        :match-relationship-count="matchRelationshipCount"
        :diagram-mode="diagramMode"
        :table-search="tableSearch"
        :show-match-panel="showMatchPanel"
        :show-layers-panel="showLayersPanel"
        :show-all-tables="showAllTables"
        :focus-table-name="focusedRoots[0]?.name ?? ''"
        :generated-join-sql="generatedJoinSql"
        :is-fullscreen="isFullscreen"
        :draft-table-count="draftTableCount"
        :can-create-table="canCreateDraftTable"
        :can-sync-to-database="canSyncStructure"
        @set-connection="setConnection"
        @set-database="setDatabase"
        @set-schema="setSchema"
        @set-selected-schemas="setSelectedSchemas"
        @update:table-search="(value) => (tableSearch = value)"
        @set-diagram-mode="setDiagramMode"
        @toggle-match-panel="handleToggleMatchPanel"
        @toggle-layers-panel="showLayersPanel = !showLayersPanel"
        @copy-join-sql="copyJoinSql"
        @toggle-show-all-tables="handleToggleShowAllTables"
        @export-format="exportDiagram"
        @refresh="requestRefreshDiagram"
        @zoom-out="zoomOut"
        @zoom-in="zoomIn"
        @toggle-fullscreen="toggleFullscreen"
        @auto-layout="applyAutoLayout"
        @create-table="showCreateTableDialog = true"
        @sync-to-database="showSyncDialog = true"
      />

      <div class="flex min-h-0 flex-1 flex-col bg-muted/20">
        <div class="min-h-0 flex-1 flex overflow-hidden">
          <div v-if="showLayersPanel && diagramReady" class="flex flex-col overflow-hidden" :style="{ width: `${leftPanelWidth}px` }">
            <LayerPanel
              :tables="tables"
              :record-history="recordHistory"
              :is-multi-schema="isMultiSchema"
              class="h-full overflow-y-auto"
              @add-layer="handleAddLayer"
              @layer-changed="handleLayerChanged"
              @layout-mode-changed="handleLayerLayoutModeChanged"
              @focus-layer="handleFocusLayer"
              @create-draft-table="handleCreateDraftTable"
              @delete-table="deleteTableFromDiagram"
            />
          </div>
          <ResizerHandle v-if="showLayersPanel && diagramReady" @resize="handleLeftResize" />
          <div class="min-h-0 flex-1 overflow-hidden">
            <div v-if="loadingDiagram && tables.length === 0" class="h-full flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
              {{ loadingText }}
            </div>
            <div v-else-if="!diagramReady" class="h-full flex items-center justify-center text-sm text-muted-foreground">
              {{ t("diagram.selectTarget") }}
            </div>
            <div v-else-if="visibleTables.length === 0 && tables.length > 0" class="h-full flex items-center justify-center text-sm text-muted-foreground">
              {{ t("diagram.noMatches") }}
            </div>
            <div v-else-if="diagramMode === 'table'" ref="diagramPaneRef" class="relative w-full h-full">
              <div v-if="tables.length === 0" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-muted/30 text-sm text-muted-foreground pointer-events-none">
                <p class="max-w-md text-center px-4 pointer-events-none">{{ t("diagram.emptyDesignHint") }}</p>
                <Button v-if="canCreateDraftTable" type="button" size="sm" class="pointer-events-auto" @click="showCreateTableDialog = true">
                  <Plus class="mr-1 h-3.5 w-3.5" />
                  {{ t("diagram.createTable") }}
                </Button>
                <p v-else class="max-w-md text-center px-4 text-xs pointer-events-none">{{ t("diagram.createTableNotSupported") }}</p>
              </div>
              <VueFlow
                :nodes="nodes"
                :edges="edges"
                :node-types="nodeTypes"
                :edge-types="edgeTypes"
                :min-zoom="0.05"
                :max-zoom="2"
                :fit-view-options="{ padding: 0.15, minZoom: 0.05, maxZoom: 2 }"
                :only-render-visible-elements="virtualizeTableDiagram"
                :pan-mode="isSpacePressed ? 'always' : undefined"
                class="diagram-flow w-full h-full"
                @nodes-change="handleNodesChange"
                @edges-change="handleEdgesChange"
                @node-click="handleNodeClick"
                @node-drag-start="handleNodeDragStart"
                @node-drag-stop="handleNodeDragStop"
                @edge-click="handleEdgeClick"
                @pane-click="handlePaneClick"
              >
                <Background />
                <MiniMap pannable zoomable class="!bg-background/95" />
              </VueFlow>
              <ZoomControls :can-undo="graphStore.canUndo" :can-redo="graphStore.canRedo" @undo="handleUndo" @redo="handleRedo" />
            </div>
            <div v-else ref="engineeringViewportRef" class="min-h-0 h-full overflow-auto" @scroll.passive="scheduleEngineeringViewportSync">
              <div class="relative" :style="{ width: `${activeCanvasSize.width}px`, height: `${activeCanvasSize.height}px` }">
                <svg class="absolute inset-0 h-full w-full overflow-visible pointer-events-none">
                  <g class="stroke-foreground/70">
                    <line v-for="line in engineeringRenderSlice.attributeLines" :key="line.id" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2" stroke-width="1.2" />
                    <line v-for="line in engineeringRenderSlice.relationshipLines" :key="line.id" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2" stroke-width="1.4" />
                  </g>
                </svg>
                <div
                  v-for="attribute in engineeringRenderSlice.attributes"
                  :key="attribute.id"
                  class="absolute flex items-center justify-center rounded-full border border-green-600/55 bg-green-100/80 px-3 text-center text-xs text-green-950 shadow-sm dark:bg-green-950/35 dark:text-green-100"
                  :class="attribute.primaryKey ? 'font-semibold underline underline-offset-2' : ''"
                  :title="`${attribute.tableName}.${attribute.columnName}: ${attribute.dataType}`"
                  :style="{ width: `${attribute.width}px`, height: `${attribute.height}px`, transform: `translate(${attribute.x}px, ${attribute.y}px)` }"
                >
                  <span class="truncate">{{ attribute.label }}</span>
                </div>
                <div
                  v-for="relationship in engineeringRenderSlice.relationships"
                  :key="relationship.id"
                  class="absolute flex items-center justify-center text-center text-xs font-medium text-red-950 dark:text-red-100"
                  :style="{ width: `${relationship.width}px`, height: `${relationship.height}px`, transform: `translate(${relationship.x}px, ${relationship.y}px)` }"
                  :title="`${relationship.sourceTable} -> ${relationship.targetTable}`"
                >
                  <div class="absolute inset-0 border border-red-500/70 bg-red-100/80 dark:bg-red-950/35" style="clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" />
                  <span class="relative max-w-[70px] truncate">{{ relationship.label }}</span>
                </div>
                <div
                  v-for="entity in engineeringRenderSlice.entities"
                  :key="entity.id"
                  class="absolute flex cursor-pointer items-center justify-center border border-blue-500/70 bg-blue-100/80 px-3 text-center text-sm font-semibold text-blue-950 shadow-sm dark:bg-blue-950/35 dark:text-blue-100"
                  :class="entity.name === focusTableName ? 'ring-2 ring-primary/40' : ''"
                  :style="{ width: `${entity.width}px`, height: `${entity.height}px`, transform: `translate(${entity.x}px, ${entity.y}px)` }"
                  @dblclick.stop="openTableData(entity.name)"
                >
                  <span class="truncate">{{ entity.name }}</span>
                </div>
              </div>
            </div>
          </div>
          <ResizerHandle v-if="showRightPanel" @resize="handleRightResize" />
          <div v-if="showRightPanel" class="flex min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-background/95" :style="{ width: `${rightPanelWidth}px` }">
            <template v-if="inspectorTarget">
              <DiagramInspector
                :target="inspectorTarget"
                :tables="tables"
                :relationships="visibleRelationships"
                :database-type="selectedConnection?.db_type"
                @close="
                  inspectorTarget = null;
                  syncHighlightEdgeId();
                "
                @update-table="handleInspectorUpdateTable"
                @delete-draft-table="deleteTableFromDiagram"
                @delete-live-table="deleteTableFromDiagram"
                @remove-relationship="handleInspectorRemoveRelationship"
                @save-relationship="handleInspectorSaveRelationship"
                @confirm-relationship="handleInspectorConfirmRelationship"
                @ignore-relationship="handleInspectorIgnoreRelationship"
              />
            </template>
            <template v-else-if="showMatchPanel">
              <div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <h3 class="text-sm font-semibold text-foreground">{{ t("diagram.modelRelationships") }}</h3>
                <button type="button" class="p-1.5 rounded-md hover:bg-muted transition-colors" @click="showMatchPanel = false">
                  <X class="h-4 w-4 text-muted-foreground" />
                </button>
              </div>

              <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div class="min-h-0 flex-1 overflow-hidden">
                  <MatchPanel
                    v-if="isAutoMatchEnabled()"
                    :relationships="matchResult.relationships"
                    :conflicts="matchResult.conflicts"
                    :pending="matchResult.pending"
                    :confirmed-ids="matchConfirms"
                    :ignored-ids="matchIgnores"
                    @confirm="confirmMatch"
                    @ignore="ignoreMatch"
                    @confirm-all="confirmAllMatches"
                    @ignore-all="ignoreAllMatches"
                    @clear-all="clearAllMatches"
                  />
                  <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
                    <span>{{ t("diagram.noInferred") }}</span>
                  </div>
                </div>

                <div class="shrink-0 border-t border-border">
                  <button type="button" class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/50" @click="showManualAdd = !showManualAdd">
                    <ChevronDown v-if="showManualAdd" class="h-3.5 w-3.5 shrink-0" />
                    <ChevronRight v-else class="h-3.5 w-3.5 shrink-0" />
                    {{ t("diagram.manualAddRelationship") }}
                  </button>
                  <div v-if="showManualAdd" class="space-y-2 border-t border-border px-3 py-2">
                    <Input v-model="relationshipDraft.name" class="h-8 text-xs" :placeholder="t('diagram.relationshipNamePlaceholder')" />
                    <Select v-model="relationshipDraft.sourceTable">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue :placeholder="t('diagram.sourceTable')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="table in tables" :key="`source-${getTableKey(table)}`" :value="getTableKey(table)" :disabled="table.columns.length === 0">{{ getTableKey(table) }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select v-model="relationshipDraft.sourceColumn">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue :placeholder="t('diagram.sourceColumn')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="column in sourceColumns" :key="`source-column-${column.name}`" :value="column.name">{{ column.name }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select v-model="relationshipDraft.cardinality">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="one-to-one">{{ t("diagram.cardinalityOneToOne") }}</SelectItem>
                        <SelectItem value="one-to-many">{{ t("diagram.cardinalityOneToMany") }}</SelectItem>
                        <SelectItem value="many-to-one">{{ t("diagram.cardinalityManyToOne") }}</SelectItem>
                        <SelectItem value="many-to-many">{{ t("diagram.cardinalityManyToMany") }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select v-model="relationshipDraft.targetTable">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue :placeholder="t('diagram.targetTable')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="table in tables" :key="`target-${getTableKey(table)}`" :value="getTableKey(table)" :disabled="table.columns.length === 0">{{ getTableKey(table) }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select v-model="relationshipDraft.targetColumn">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue :placeholder="t('diagram.targetColumn')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="column in targetColumns" :key="`target-column-${column.name}`" :value="column.name">{{ column.name }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="default" size="sm" class="h-8 w-full px-2 text-xs" @click="addCustomRelationship">
                      <Plus class="mr-1 h-3.5 w-3.5" />
                      {{ t("diagram.addRelationship") }}
                    </Button>
                    <div v-if="customRelationships.length > 0" class="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      <Badge v-for="relationship in customRelationships" :key="relationship.id" variant="secondary" class="gap-1 pr-1">
                        <span class="max-w-48 truncate text-[10px]"> {{ relationship.sourceTable }}.{{ relationship.sourceColumn }} {{ relationship.sourceCardinality }}:{{ relationship.targetCardinality }} {{ relationship.targetTable }}.{{ relationship.targetColumn }} </span>
                        <button type="button" class="rounded-sm p-0.5 hover:bg-background/80" :title="t('diagram.removeRelationship')" @click="removeCustomRelationship(relationship.id)">
                          <Trash2 class="h-3 w-3" />
                        </button>
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <CreateDraftTableDialog v-model:open="showCreateTableDialog" :layers="layerStore.layers" :active-layer-id="layerStore.activeLayerId" :existing-names="tables.map((t) => t.name)" @create="handleCreateDraftTable" />
  <DiagramSyncDialog v-model:open="showSyncDialog" :tables="tables" :connection-id="connectionId" :database="database" :schema="schema || selectedSchemas[0] || ''" :database-type="selectedConnection?.db_type" @synced="handleSyncedDraftTables" />
  <DangerConfirmDialog v-model:open="showRefreshConfirm" :title="t('diagram.refresh')" :message="t('diagram.refreshConfirm')" :confirm-label="t('diagram.refresh')" @confirm="confirmRefreshDiagram" />
</template>
