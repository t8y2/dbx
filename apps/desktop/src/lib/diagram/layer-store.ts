import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { DiagramLayer, LayerLayoutMode } from "@/types/diagram";
import { LAYER_COLORS } from "@/types/diagram";

function generateLayerId(): string {
  return `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function getNextColor(existingColors: string[]): string {
  const usedColors = new Set(existingColors);
  for (const color of LAYER_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  return LAYER_COLORS[existingColors.length % LAYER_COLORS.length];
}

function getNextLayerName(existingNames: string[]): string {
  let maxIndex = 0;
  const layerNameRegex = /^Layer (\d+)$/;
  for (const name of existingNames) {
    const match = name.match(layerNameRegex);
    if (match) {
      const index = parseInt(match[1], 10);
      if (index > maxIndex) {
        maxIndex = index;
      }
    }
  }
  return `Layer ${maxIndex + 1}`;
}

export const useLayerStore = defineStore("diagram-layer", () => {
  const layers = ref<DiagramLayer[]>([]);
  const activeLayerId = ref<string | null>(null);

  const activeLayer = computed(() => layers.value.find((l) => l.id === activeLayerId.value));

  function getLayerByTable(tableName: string): DiagramLayer | undefined {
    return layers.value.find((layer) => layer.tableNames.includes(tableName));
  }

  function getLayerColor(tableName: string): string {
    const layer = getLayerByTable(tableName);
    return layer?.color || "#9ca3af";
  }

  function addLayer(name?: string, position?: { x: number; y: number }, size?: { width?: number; height?: number }): DiagramLayer {
    for (const layer of layers.value) {
      layer.collapsed = true;
    }
    const newLayer: DiagramLayer = {
      id: generateLayerId(),
      name: name || getNextLayerName(layers.value.map((l) => l.name)),
      color: getNextColor(layers.value.map((l) => l.color)),
      tableNames: [],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: position || { x: 40, y: 40 },
      width: size?.width ?? 240,
      height: size?.height ?? 52,
    };
    layers.value.push(newLayer);
    activeLayerId.value = newLayer.id;
    return newLayer;
  }

  function setLayoutMode(layerId: string, layoutMode: LayerLayoutMode) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer) {
      layer.layoutMode = layoutMode;
    }
  }

  function updateLayerGeometry(layerId: string, geometry: { position?: { x: number; y: number }; width?: number; height?: number }) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (!layer) return;
    if (geometry.position) layer.position = geometry.position;
    if (geometry.width !== undefined) layer.width = geometry.width;
    if (geometry.height !== undefined) layer.height = geometry.height;
  }

  function removeLayer(layerId: string) {
    const index = layers.value.findIndex((l) => l.id === layerId);
    if (index === -1) return;

    layers.value.splice(index, 1);

    if (activeLayerId.value === layerId) {
      activeLayerId.value = layers.value[0]?.id || null;
    }
  }

  function renameLayer(layerId: string, newName: string) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer) {
      layer.name = newName;
    }
  }

  function setActiveLayer(layerId: string | null) {
    activeLayerId.value = layerId;
  }

  function addTableToLayer(layerId: string, tableName: string) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer && !layer.tableNames.includes(tableName)) {
      layer.tableNames.push(tableName);
    }
  }

  function removeTableFromLayer(layerId: string, tableName: string) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer) {
      layer.tableNames = layer.tableNames.filter((name) => name !== tableName);
    }
  }

  function moveTableToLayer(tableName: string, targetLayerId: string) {
    const currentLayer = getLayerByTable(tableName);
    if (currentLayer && currentLayer.id !== targetLayerId) {
      removeTableFromLayer(currentLayer.id, tableName);
    }
    addTableToLayer(targetLayerId, tableName);
  }

  function toggleLayerVisibility(layerId: string) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer) {
      layer.visible = !layer.visible;
    }
  }

  function toggleLayerCollapse(layerId: string) {
    const layer = layers.value.find((l) => l.id === layerId);
    if (layer) {
      layer.collapsed = !layer.collapsed;
    }
  }

  function clearLayers() {
    layers.value = [];
    activeLayerId.value = null;
  }

  function loadLayers(savedLayers: DiagramLayer[]) {
    layers.value = savedLayers.map((layer) => ({
      ...layer,
      layoutMode: layer.layoutMode ?? "auto",
    }));
    activeLayerId.value = layers.value[0]?.id || null;
  }

  function toJSON(): DiagramLayer[] {
    return JSON.parse(JSON.stringify(layers.value));
  }

  return {
    layers,
    activeLayerId,
    activeLayer,
    getLayerByTable,
    getLayerColor,
    addLayer,
    removeLayer,
    renameLayer,
    setActiveLayer,
    setLayoutMode,
    updateLayerGeometry,
    addTableToLayer,
    removeTableFromLayer,
    moveTableToLayer,
    toggleLayerVisibility,
    toggleLayerCollapse,
    clearLayers,
    loadLayers,
    toJSON,
  };
});
