import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { DiagramNode, DiagramEdge, HistorySnapshot, LayoutOptions, DiagramLayer } from "@/types/diagram";
import { LayoutManager } from "./layout-manager";
import type { LayerLayoutInfo } from "./elk-layout";

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function emptySnapshotExtras(): Pick<HistorySnapshot, "positions" | "layers" | "tables" | "customRelationships" | "edgeWaypoints" | "edgeHandleHints" | "matchConfirms" | "matchIgnores"> {
  return {
    positions: {},
    layers: [],
    tables: [],
    customRelationships: [],
    edgeWaypoints: {},
    edgeHandleHints: {},
    matchConfirms: [],
    matchIgnores: [],
  };
}

export const useGraphStore = defineStore("diagram-graph", () => {
  const nodes = ref<DiagramNode[]>([]);
  const edges = ref<DiagramEdge[]>([]);
  const layerLayouts = ref<LayerLayoutInfo[]>([]);
  const historyStack = ref<HistorySnapshot[]>([]);
  const redoStack = ref<HistorySnapshot[]>([]);
  const maxHistorySize = 50;
  const layoutManager = new LayoutManager();

  const canUndo = computed(() => historyStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  function snapshotFromNodesEdges(): HistorySnapshot {
    return {
      nodes: deepClone(nodes.value),
      edges: deepClone(edges.value),
      ...emptySnapshotExtras(),
      positions: Object.fromEntries(nodes.value.map((n) => [n.id, { ...n.position }])),
    };
  }

  function pushHistory(snapshot: HistorySnapshot) {
    historyStack.value.push(deepClone(snapshot));
    if (historyStack.value.length > maxHistorySize) {
      historyStack.value.shift();
    }
    redoStack.value = [];
  }

  /** Push current store nodes/edges (used by store-owned layout helpers). */
  function pushStoreHistory() {
    pushHistory(snapshotFromNodesEdges());
  }

  function undo(current: HistorySnapshot): HistorySnapshot | null {
    if (historyStack.value.length === 0) return null;
    redoStack.value.push(deepClone(current));
    const prev = historyStack.value.pop()!;
    nodes.value = deepClone(prev.nodes);
    edges.value = deepClone(prev.edges);
    return deepClone(prev);
  }

  function redo(current: HistorySnapshot): HistorySnapshot | null {
    if (redoStack.value.length === 0) return null;
    historyStack.value.push(deepClone(current));
    const next = redoStack.value.pop()!;
    nodes.value = deepClone(next.nodes);
    edges.value = deepClone(next.edges);
    return deepClone(next);
  }

  function setNodes(newNodes: DiagramNode[]) {
    nodes.value = newNodes;
  }

  function setEdges(newEdges: DiagramEdge[]) {
    edges.value = newEdges;
  }

  function updateNodePosition(nodeId: string, position: { x: number; y: number }) {
    const node = nodes.value.find((n) => n.id === nodeId);
    if (node) {
      pushStoreHistory();
      node.position = position;
    }
  }

  async function applyLayout(direction?: LayoutOptions["direction"]) {
    pushStoreHistory();
    const result = await layoutManager.applyElkLayout(nodes.value, edges.value, direction);
    nodes.value = result.nodes;
    edges.value = result.edges;
    layerLayouts.value = [];
  }

  async function applyElkLayoutWithLayers(nodesParam: DiagramNode[], edgesParam: DiagramEdge[], layers: DiagramLayer[]) {
    pushStoreHistory();
    const result = await layoutManager.applyElkLayoutWithLayers(nodesParam, edgesParam, layers);
    nodes.value = result.nodes;
    edges.value = result.edges;
    layerLayouts.value = result.layerLayouts || [];
    return result;
  }

  function applyGridLayout() {
    pushStoreHistory();
    nodes.value = layoutManager.applyGridLayout(nodes.value);
  }

  function clearHistory() {
    historyStack.value = [];
    redoStack.value = [];
  }

  return {
    nodes,
    edges,
    layerLayouts,
    undo,
    redo,
    canUndo,
    canRedo,
    pushHistory,
    setNodes,
    setEdges,
    updateNodePosition,
    applyLayout,
    applyElkLayoutWithLayers,
    applyGridLayout,
    clearHistory,
  };
});
