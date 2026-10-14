<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import { Download, EyeOff, Focus, Maximize2, Network, Pin, RotateCcw, Search, Save, X, ZoomIn, ZoomOut } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "vue-i18n";
import { mergeGraphResults, type GraphEdge, type GraphNode, type GraphProperty, type GraphResult } from "@/lib/graph/graphResult";
import type { QueryResult } from "@/types/database";

cytoscape.use(fcose);

const props = defineProps<{
  graph: GraphResult;
  rows: QueryResult["rows"];
  columns: string[];
  readOnly?: boolean;
  saveProperty?: (entity: GraphNode | GraphEdge, property: GraphProperty, value: string | boolean) => Promise<GraphProperty | undefined>;
  expandNode?: (node: GraphNode) => Promise<GraphResult | undefined>;
}>();

const { t } = useI18n();
const MAX_VISIBLE_NODES = 1000;
const MAX_VISIBLE_EDGES = 2000;
const canvas = ref<HTMLDivElement>();
const query = ref("");
const showRecords = ref(false);
const hidden = ref<Set<string>>(new Set());
const pinned = ref<Set<string>>(new Set());
const expanded = ref<GraphResult>();
const selectedId = ref("");
const selectedKind = ref<"node" | "edge">("node");
const editing = ref("");
const draft = ref<string | boolean>("");
const busy = ref(false);
const error = ref("");
let cy: Core | undefined;
let observer: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let lastNodeTap = { id: "", at: 0 };
let disposed = false;
let graphRevision = 0;

const graph = computed(() => mergeGraphResults(props.graph, expanded.value) ?? props.graph);
const visibleNodes = computed(() => graph.value.nodes.filter((node) => !hidden.value.has(node.id)).slice(0, MAX_VISIBLE_NODES));
const visibleNodeIds = computed(() => new Set(visibleNodes.value.map((node) => node.id)));
const visibleEdges = computed(() => graph.value.edges.filter((edge) => visibleNodeIds.value.has(edge.source) && visibleNodeIds.value.has(edge.target) && !hidden.value.has(edge.id)).slice(0, MAX_VISIBLE_EDGES));
const selected = computed(() => (selectedKind.value === "node" ? graph.value.nodes.find((node) => node.id === selectedId.value) : graph.value.edges.find((edge) => edge.id === selectedId.value)));
const selectedNode = computed(() => (selectedKind.value === "node" ? (selected.value as GraphNode | undefined) : undefined));
const relatedCells = computed(() => graph.value.cells.filter((cell) => cell.nodeIds.includes(selectedId.value) || cell.edgeIds.includes(selectedId.value)).slice(0, 50));
const records = computed(() => props.rows.slice(0, 300));
const cellIndex = computed(() => new Map(graph.value.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])));

function nodeLabel(node: GraphNode): string {
  const title = node.properties.find((property) => /^(name|title|label)$/i.test(property.name) && typeof property.value === "string");
  return String(title?.value ?? node.vid?.value ?? node.id);
}

const palette = ["#2890a7", "#d07855", "#6c9d66", "#a478ba", "#cc9a44", "#5381bb", "#b56989", "#779987"];
function nodeColor(node: GraphNode): string {
  const label = node.labels[0] ?? "vertex";
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function renderGraph(keepPositions = false) {
  if (!canvas.value) return;
  const dark = document.documentElement.classList.contains("dark");
  const textColor = dark ? "#e6edf0" : "#202a31";
  const canvasColor = dark ? "#192327" : "#ffffff";
  const positions = new Map<string, { x: number; y: number }>();
  if (keepPositions && cy)
    cy.nodes().forEach((node) => {
      if (visibleNodeIds.value.has(node.id())) positions.set(node.id(), node.position());
    });
  cy?.destroy();
  const elements: ElementDefinition[] = [
    ...visibleNodes.value.map((node) => ({ data: { id: node.id, label: nodeLabel(node), color: nodeColor(node) }, ...(positions.has(node.id) ? { position: positions.get(node.id) } : {}) })),
    ...visibleEdges.value.map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target, label: edge.type } })),
  ];
  cy = cytoscape({
    container: canvas.value,
    elements,
    layout: { name: "preset" },
    minZoom: 0.08,
    maxZoom: 1.5,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          "border-color": canvasColor,
          "border-width": 2,
          width: 42,
          height: 42,
          label: "data(label)",
          color: textColor,
          "font-size": 11,
          "font-weight": 600,
          "text-valign": "bottom",
          "text-margin-y": 10,
          "text-wrap": "ellipsis",
          "text-max-width": "120px",
          "text-background-color": canvasColor,
          "text-background-opacity": 0.86,
          "text-background-padding": "2px",
        },
      },
      {
        selector: "edge",
        style: {
          width: 2,
          "line-color": "#9baeb3",
          "target-arrow-color": "#9baeb3",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.8,
          "curve-style": "bezier",
          "control-point-step-size": 50,
          label: "data(label)",
          color: dark ? "#c2cdd0" : "#52616b",
          "font-size": 10,
          "text-rotation": "autorotate",
          "text-background-color": canvasColor,
          "text-background-opacity": 0.88,
          "text-background-padding": "2px",
        },
      },
      { selector: ":selected", style: { "border-color": "#173e48", "border-width": 4, "line-color": "#173e48", "target-arrow-color": "#173e48" } },
      { selector: ".search-hit", style: { "border-color": "#e69a3e", "border-width": 5 } },
    ],
  });
  cy.on("tap", "node, edge", (event) => {
    selectedId.value = event.target.id();
    selectedKind.value = event.target.isNode() ? "node" : "edge";
    editing.value = "";
    error.value = "";
    if (event.target.isNode()) {
      const now = performance.now();
      if (lastNodeTap.id === selectedId.value && now - lastNodeTap.at < 320) void expand();
      lastNodeTap = { id: selectedId.value, at: now };
    }
  });
  cy.on("tap", (event) => {
    if (event.target === cy) selectedId.value = "";
  });
  if (selectedId.value) cy.getElementById(selectedId.value).select();
  for (const id of pinned.value) cy.getElementById(id).lock();
  if (!positions.size) relayout();
  else if (visibleNodes.value.some((node) => !positions.has(node.id))) {
    cy.layout({
      name: "fcose",
      quality: "default",
      animate: true,
      animationDuration: 350,
      randomize: false,
      nodeDimensionsIncludeLabels: true,
      fixedNodeConstraint: [...positions].map(([nodeId, position]) => ({ nodeId, position })),
    } as cytoscape.LayoutOptions).run();
  } else cy.fit(undefined, 40);
  highlightSearch();
}

function relayout() {
  if (!cy || !cy.nodes().length) return;
  const fixedNodeConstraint = cy
    .nodes()
    .filter((node) => pinned.value.has(node.id()))
    .map((node) => ({ nodeId: node.id(), position: (node as cytoscape.NodeSingular).position() }));
  cy.layout({ name: "fcose", quality: "default", animate: true, animationDuration: 350, randomize: false, nodeDimensionsIncludeLabels: true, fixedNodeConstraint } as cytoscape.LayoutOptions).run();
}

function highlightSearch() {
  if (!cy) return;
  cy.elements().removeClass("search-hit");
  const text = query.value.trim().toLocaleLowerCase();
  if (!text) return;
  cy.nodes().forEach((node) => {
    if (String(node.data("label")).toLocaleLowerCase().includes(text) || node.id().toLocaleLowerCase().includes(text)) node.addClass("search-hit");
  });
}

function focusElement(id: string, kind: "node" | "edge") {
  selectedId.value = id;
  selectedKind.value = kind;
  cy?.elements().unselect();
  const element = cy?.getElementById(id);
  if (element?.length) {
    element.select();
    cy?.animate({ center: { eles: element }, zoom: Math.max(cy.zoom(), 0.8) }, { duration: 250 });
  }
}

function cellFor(row: number, column: number) {
  return cellIndex.value.get(`${row}:${column}`);
}

function selectCell(row: number, column: number) {
  const cell = cellFor(row, column);
  if (!cell) return;
  const edge = cell.kind === "edge" && !!cell.edgeIds[0];
  const id = edge ? cell.edgeIds[0] : (cell.nodeIds[0] ?? cell.edgeIds[0]);
  if (id) focusElement(id, edge ? "edge" : "node");
}

function hideSelected() {
  if (!selectedId.value) return;
  hidden.value = new Set([...hidden.value, selectedId.value]);
  selectedId.value = "";
  renderGraph(true);
}

function restoreHidden() {
  hidden.value = new Set();
  renderGraph(true);
}

function togglePin() {
  const element = cy?.getElementById(selectedId.value);
  if (!element?.length || !element.isNode()) return;
  const next = new Set(pinned.value);
  if (next.has(selectedId.value)) {
    next.delete(selectedId.value);
    element.unlock();
  } else {
    next.add(selectedId.value);
    element.lock();
  }
  pinned.value = next;
}

async function expand() {
  if (!selectedNode.value || !props.expandNode || busy.value) return;
  const revision = graphRevision;
  const isCurrent = () => !disposed && graphRevision === revision;
  busy.value = true;
  error.value = "";
  try {
    const result = await props.expandNode(selectedNode.value);
    if (!isCurrent()) return;
    // Neighbor-query rows do not belong to the original result table.
    expanded.value = mergeGraphResults(expanded.value, result ? { ...result, cells: [] } : undefined);
    await nextTick();
    if (isCurrent()) renderGraph(true);
  } catch (cause) {
    if (isCurrent()) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

function canEdit(property: GraphProperty): boolean {
  return !props.readOnly && !!props.saveProperty && property.value !== null && ["string", "bool", "int", "float"].includes(property.type);
}

function startEdit(property: GraphProperty) {
  editing.value = `${property.owner}\u0000${property.name}`;
  draft.value = property.value ?? "";
  error.value = "";
}

async function save(property: GraphProperty) {
  if (!selected.value || !props.saveProperty || busy.value) return;
  const entity = selected.value;
  const revision = graphRevision;
  const editKey = editing.value;
  const isCurrent = () => !disposed && graphRevision === revision;
  busy.value = true;
  error.value = "";
  try {
    const updated = await props.saveProperty(entity, property, draft.value);
    if (!updated || !isCurrent()) return;
    const element = ("labels" in entity ? graph.value.nodes : graph.value.edges).find((item) => item.id === entity.id);
    if (!element) return;
    const target = element.properties.find((candidate) => candidate.owner === property.owner && candidate.name === property.name);
    if (target) target.value = updated.value;
    if ("labels" in element) cy?.getElementById(element.id).data("label", nodeLabel(element));
    if (selectedId.value === entity.id && editing.value === editKey) editing.value = "";
  } catch (cause) {
    if (isCurrent() && selectedId.value === entity.id) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

const draftText = computed({
  get: () => String(draft.value),
  set: (value: string) => {
    draft.value = value;
  },
});

function exportImage() {
  if (!cy) return;
  const link = document.createElement("a");
  link.download = "dbx-graph.png";
  link.href = cy.png({ full: true, scale: 2, bg: document.documentElement.classList.contains("dark") ? "#111a1e" : "#ffffff" });
  link.click();
}

watch(query, highlightSearch);
watch(
  () => props.graph,
  (next, previous) => {
    // Appending a result page reuses the same cells and only adds new ones;
    // keep the view state and re-render with preserved positions instead of
    // wiping selection/pins/hidden nodes and re-running a full layout.
    const appended =
      !!previous &&
      previous.cells.length < next.cells.length &&
      (() => {
        const nextCellKeys = new Set(next.cells.map((cell) => `${cell.row}:${cell.column}`));
        if (previous.cells.some((cell) => !nextCellKeys.has(`${cell.row}:${cell.column}`))) return false;
        const nextNodeIds = new Set(next.nodes.map((node) => node.id));
        return previous.nodes.every((node) => nextNodeIds.has(node.id));
      })();
    if (!appended) {
      graphRevision++;
      busy.value = false;
      expanded.value = undefined;
      selectedId.value = "";
      editing.value = "";
      error.value = "";
      lastNodeTap = { id: "", at: 0 };
      hidden.value = new Set();
      pinned.value = new Set();
    }
    const revision = graphRevision;
    void nextTick(() => {
      if (!disposed && graphRevision === revision) renderGraph(appended);
    });
  },
  { flush: "sync" },
);
watch(selectedId, () => {
  editing.value = "";
  error.value = "";
});
onMounted(() => {
  renderGraph();
  if (canvas.value && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        cy?.resize();
        cy?.fit(undefined, 32);
      });
    });
    observer.observe(canvas.value);
  }
  themeObserver = new MutationObserver(() => renderGraph(true));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  themeObserver?.disconnect();
  cy?.destroy();
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-background" data-graph-result-view>
    <div class="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div class="relative min-w-0 flex-1 sm:max-w-52">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" :aria-label="t('graph.search')" :placeholder="t('graph.search')" class="h-7 pl-7 text-xs" />
      </div>
      <span class="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline"
        >{{ visibleNodes.length }}<template v-if="graph.nodes.length > visibleNodes.length">/{{ graph.nodes.length }}</template> {{ t("graph.nodes") }} · {{ visibleEdges.length }}<template v-if="graph.edges.length > visibleEdges.length">/{{ graph.edges.length }}</template>
        {{ t("graph.edges") }}</span
      >
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.zoomIn')" :aria-label="t('graph.zoomIn')" @click="cy?.zoom(cy.zoom() * 1.2)"><ZoomIn class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.zoomOut')" :aria-label="t('graph.zoomOut')" @click="cy?.zoom(cy.zoom() / 1.2)"><ZoomOut class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.fit')" :aria-label="t('graph.fit')" @click="cy?.fit(undefined, 40)"><Maximize2 class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.layout')" :aria-label="t('graph.layout')" @click="relayout"><RotateCcw class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.records')" :aria-label="t('graph.records')" :aria-pressed="showRecords" @click="showRecords = !showRecords"><Focus class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.exportPng')" :aria-label="t('graph.exportPng')" @click="exportImage"><Download class="h-4 w-4" /></Button>
    </div>
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <div class="flex min-h-[280px] min-w-0 flex-1 flex-col">
        <div ref="canvas" class="min-h-0 flex-1" data-graph-canvas />
        <div v-if="showRecords" class="max-h-40 shrink-0 overflow-auto border-t text-xs">
          <table class="min-w-full border-collapse text-left">
            <thead class="sticky top-0 bg-muted/80 text-muted-foreground">
              <tr>
                <th class="w-10 px-2 py-1 font-medium">#</th>
                <th v-for="(column, index) in columns" :key="index" class="min-w-32 px-2 py-1 font-medium">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in records" :key="rowIndex" class="border-t hover:bg-muted/30">
                <td class="px-2 py-1 text-muted-foreground">{{ rowIndex + 1 }}</td>
                <td v-for="(value, columnIndex) in row" :key="columnIndex" class="max-w-60 px-2 py-1">
                  <button v-if="cellFor(rowIndex, columnIndex)" type="button" class="block max-w-60 truncate text-left hover:underline" :title="String(value)" @click="selectCell(rowIndex, columnIndex)">{{ value }}</button>
                  <span v-else class="block max-w-60 truncate" :title="String(value)">{{ value }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <aside class="max-h-64 min-h-0 w-full shrink-0 overflow-auto border-t md:max-h-none md:w-72 md:border-l md:border-t-0">
        <template v-if="selected">
          <div class="flex items-start justify-between gap-2 border-b px-3 py-2">
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold">{{ selectedKind === "node" ? nodeLabel(selected as GraphNode) : (selected as GraphEdge).type }}</div>
              <div class="truncate text-[11px] text-muted-foreground">{{ selectedKind === "node" ? (selected as GraphNode).labels.join(", ") || (selected as GraphNode).vid?.value || (selected as GraphNode).id : `${(selected as GraphEdge).source} → ${(selected as GraphEdge).target}` }}</div>
            </div>
            <Button size="icon" variant="ghost" class="h-6 w-6 shrink-0" :title="t('graph.clearSelection')" :aria-label="t('graph.clearSelection')" @click="selectedId = ''"><X class="h-3.5 w-3.5" /></Button>
          </div>
          <div class="flex items-center gap-1 border-b px-2 py-1">
            <Button v-if="selectedKind === 'node' && expandNode" size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs" :disabled="busy || visibleNodes.length >= MAX_VISIBLE_NODES" @click="expand"><Network class="h-3.5 w-3.5" />{{ t("graph.expand") }}</Button>
            <Button v-if="selectedKind === 'node'" size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.pin')" :aria-label="t('graph.pin')" @click="togglePin"><Pin class="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" class="h-7 w-7" :title="t('graph.hide')" :aria-label="t('graph.hide')" @click="hideSelected"><EyeOff class="h-3.5 w-3.5" /></Button>
          </div>
          <div class="px-3 py-2 text-[11px] font-medium text-muted-foreground">{{ t("graph.properties") }}</div>
          <div v-for="property in selected.properties" :key="`${property.owner}:${property.name}`" class="border-b px-3 py-2 text-xs">
            <div class="flex min-w-0 items-center justify-between gap-2">
              <span class="min-w-0 truncate font-medium" :title="property.owner ? `${property.owner}.${property.name}` : property.name">{{ property.owner ? `${property.owner}.${property.name}` : property.name }}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{{ property.type }}</span>
            </div>
            <template v-if="editing === `${property.owner}\u0000${property.name}`">
              <label v-if="property.type === 'bool'" class="mt-1 flex items-center gap-2"><input v-model="draft" type="checkbox" :disabled="busy" class="h-4 w-4" />{{ draft ? "true" : "false" }}</label>
              <Input v-else v-model="draftText" :disabled="busy" class="mt-1 h-7 text-xs" :aria-label="property.name" @keyup.enter="save(property)" />
              <div class="mt-1 flex justify-end gap-1">
                <Button size="icon" variant="ghost" class="h-6 w-6" :title="t('graph.cancel')" :aria-label="t('graph.cancel')" @click="editing = ''"><X class="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" class="h-6 w-6" :title="t('graph.save')" :aria-label="t('graph.save')" :disabled="busy" @click="save(property)"><Save class="h-3.5 w-3.5" /></Button>
              </div>
            </template>
            <button v-else type="button" class="mt-1 block w-full break-all text-left text-foreground" :class="canEdit(property) ? 'hover:underline' : 'cursor-default'" :disabled="busy || !canEdit(property)" @click="startEdit(property)">
              {{ property.value === null ? "NULL" : String(property.value) }}
            </button>
          </div>
          <div v-if="relatedCells.length" class="px-3 py-2 text-[11px] text-muted-foreground">{{ t("graph.records") }}: {{ relatedCells.map((cell) => cell.row + 1).join(", ") }}</div>
        </template>
        <div v-else class="flex h-24 items-center justify-center text-xs text-muted-foreground">
          {{ visibleNodes.length }}<template v-if="graph.nodes.length > visibleNodes.length">/{{ graph.nodes.length }}</template> {{ t("graph.nodes") }} · {{ visibleEdges.length }}<template v-if="graph.edges.length > visibleEdges.length">/{{ graph.edges.length }}</template> {{ t("graph.edges") }}
        </div>
        <div v-if="error" role="alert" class="break-words px-3 py-2 text-xs text-destructive">{{ error }}</div>
        <div v-if="hidden.size" class="border-t px-2 py-1">
          <Button size="sm" variant="ghost" class="h-7 text-xs" @click="restoreHidden">{{ t("graph.restoreHidden") }}</Button>
        </div>
      </aside>
    </div>
  </div>
</template>
