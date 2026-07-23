<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Camera, Loader2, Map, Maximize2, Minimize2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import "leaflet/dist/leaflet.css";
import type L from "leaflet";

const props = defineProps<{
  open: boolean;
  title?: string;
  geojson: string;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();

const { t } = useI18n();
const mapContainer = ref<HTMLDivElement>();
const mapError = ref<string>("");
const isExporting = ref(false);

// ── Resize / maximise ──────────────────────────────────────────────────────
const customSize = ref<{ w: number; h: number } | null>(null);
const isMaximized = ref(false);
type ResizeEdge = "e" | "s" | "se";
let _resizeEdge: ResizeEdge | null = null;
let _resizeStart: { x: number; y: number; w: number; h: number } | null = null;

const contentStyle = computed(() => {
  if (isMaximized.value)
    return {
      width: "100vw",
      height: "100vh",
      maxWidth: "none",
      maxHeight: "none",
    };
  if (customSize.value)
    return {
      width: `${customSize.value.w}px`,
      height: `${customSize.value.h}px`,
      maxWidth: "none",
      maxHeight: "none",
    };
  return {};
});

function toggleMaximize() {
  isMaximized.value = !isMaximized.value;
}

function onResizePointerDown(event: PointerEvent, edge: ResizeEdge) {
  const el = (event.currentTarget as HTMLElement).closest("[data-slot='dialog-content']") as HTMLElement;
  if (!el) return;
  _resizeEdge = edge;
  const rect = el.getBoundingClientRect();
  _resizeStart = {
    x: event.clientX,
    y: event.clientY,
    w: rect.width,
    h: rect.height,
  };
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onResizePointerMove(event: PointerEvent) {
  if (!_resizeStart || !_resizeEdge) return;
  const dx = event.clientX - _resizeStart.x;
  const dy = event.clientY - _resizeStart.y;
  let w = _resizeStart.w;
  let h = _resizeStart.h;
  if (_resizeEdge === "e" || _resizeEdge === "se") w += dx;
  if (_resizeEdge === "s" || _resizeEdge === "se") h += dy;
  w = Math.max(640, Math.min(w, window.innerWidth - 32));
  h = Math.max(400, Math.min(h, window.innerHeight - 32));
  customSize.value = { w, h };
}

function onResizePointerUp() {
  _resizeEdge = null;
  _resizeStart = null;
}

// ── Leaflet ───────────────────────────────────────────────────────────────
let _L: typeof L | null = null;
let map: L.Map | null = null;
let geoLayer: L.GeoJSON | null = null;
let labelLayer: L.LayerGroup | null = null;
let tileLayer: L.TileLayer | null = null;
let mapResizeObserver: ResizeObserver | null = null;
let _geojsonData: any = null;

async function loadLeaflet(): Promise<typeof L> {
  if (!_L) {
    console.log("[LayerPreview] dynamic import leaflet…");
    const mod = await import("leaflet");
    _L = mod.default as unknown as typeof L;
    console.log("[LayerPreview] leaflet loaded, L.version =", (_L as any).version);
  }
  return _L;
}

interface BasemapOption {
  id: string;
  label: string;
  url: string;
  attribution: string;
}

const basemaps: BasemapOption[] = [
  {
    id: "osm",
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    id: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
  {
    id: "street",
    label: "World Street",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, HERE, Garmin, and the GIS User Community",
  },
  {
    id: "topo",
    label: "World Topo",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, HERE, FAO, NOAA, and the GIS User Community",
  },
  {
    id: "light",
    label: "Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
  },
];

const selectedBasemap = ref(basemaps[0]);
const selectedBasemapId = ref(basemaps[0].id);
const dialogTitle = computed(() => props.title || t("grid.layerPreview"));

// ── Label property ─────────────────────────────────────────────────────────
const labelProperties = ref<string[]>([]);
const labelProperty = ref<string>("");

function parseLabelProperties(data: any) {
  const keys = new Set<string>();
  const features = data.features || (data.type === "Feature" ? [data] : []);
  for (const f of features) {
    if (f.properties) Object.keys(f.properties).forEach((k) => keys.add(k));
    if (keys.size >= 20) break;
  }
  labelProperties.value = Array.from(keys).sort();
  labelProperty.value = "";
}

function onLabelPropertyChange() {
  updateLabels();
}

function updateLabels() {
  if (!map || !_geojsonData || !_L) return;
  // Remove old labels
  if (labelLayer) {
    map.removeLayer(labelLayer);
    labelLayer = null;
  }

  const prop = labelProperty.value;
  if (!prop) return;

  const L = _L;
  labelLayer = L.layerGroup().addTo(map);

  const features = _geojsonData.features || [];
  for (const f of features) {
    const value = f.properties?.[prop];
    if (value == null) continue;
    const coords = getLabelCoords(f.geometry);
    if (!coords) continue;
    const icon = L.divIcon({
      className: "layer-preview-label",
      html: `<span>${escapeHtml(String(value))}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker(coords, { icon, interactive: false }).addTo(labelLayer);
  }
}

function getLabelCoords(geom: any): [number, number] | null {
  if (!geom) return null;
  if (geom.type === "Point") return [geom.coordinates[1], geom.coordinates[0]];
  if (geom.type === "MultiPoint") return [geom.coordinates[0][1], geom.coordinates[0][0]];
  // For lines/polygons, label at the centroid (midpoint)
  const coords = geom.coordinates?.flat(Infinity).filter((n: any) => typeof n === "number");
  if (!coords || coords.length < 2) return null;
  // Collect all [lng, lat] pairs
  const pts: [number, number][] = [];
  const flat = geom.coordinates?.flat(Infinity) ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (typeof flat[i] === "number" && typeof flat[i + 1] === "number") pts.push([flat[i], flat[i + 1]]);
  }
  if (pts.length === 0) return null;
  const avgLng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const avgLat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [avgLat, avgLng];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Map ────────────────────────────────────────────────────────────────────
function pointToCircleFeature(_feature: any, latlng: L.LatLng): L.CircleMarker {
  return _L!.circleMarker(latlng, {
    radius: 7,
    color: "#ff6600",
    weight: 3,
    opacity: 0.95,
    fillColor: "#ff6600",
    fillOpacity: 0.5,
  });
}

function popupContent(feature: any): string {
  const rows: string[] = [];
  if (feature.properties) {
    for (const [k, v] of Object.entries(feature.properties)) {
      rows.push(`<tr><td class="pr-2 font-medium">${escapeHtml(k)}</td><td>${escapeHtml(String(v ?? ""))}</td></tr>`);
    }
  }
  const geom = feature.geometry?.type ?? "?";
  return `<div class="text-xs leading-relaxed"><div class="mb-1 font-semibold text-[#ff6600]">${geom}</div><table>${rows.join("")}</table></div>`;
}

async function initMap() {
  const container = mapContainer.value;
  if (!container) {
    console.warn("[LayerPreview] mapContainer ref is null");
    return;
  }
  cleanupMap();
  mapError.value = "";

  // Remove the "Loading map…" placeholder so Leaflet can take over.
  const placeholder = container.querySelector("[data-map-placeholder]");
  if (placeholder) placeholder.remove();

  try {
    console.log("[LayerPreview] container offset:", container.offsetWidth, "x", container.offsetHeight);
    const L = await loadLeaflet();
    const rect = container.getBoundingClientRect();
    console.log("[LayerPreview] container getBoundingClientRect:", rect.width, "x", rect.height);

    map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      center: [35, 110],
      zoom: 4,
    });
    console.log("[LayerPreview] L.map created");
    map.invalidateSize();

    tileLayer = L.tileLayer(selectedBasemap.value.url, {
      attribution: selectedBasemap.value.attribution,
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
    // Sync ID ref
    selectedBasemapId.value = selectedBasemap.value.id;
    console.log("[LayerPreview] tileLayer added");
    addGeoJsonToMap();
    parseLabelProperties(_geojsonData);

    mapResizeObserver = new ResizeObserver(() => {
      map?.invalidateSize();
    });
    mapResizeObserver.observe(container);
    setTimeout(() => {
      map?.invalidateSize();
    }, 500);
  } catch (err) {
    console.error("[LayerPreview] initMap error:", err);
    mapError.value = String(err);
  }
}

function addGeoJsonToMap() {
  if (!map || geoLayer) return;
  try {
    _geojsonData = JSON.parse(props.geojson);
  } catch {
    console.warn("[LayerPreview] invalid geojson JSON");
    return;
  }
  console.log("[LayerPreview] GeoJSON type:", _geojsonData.type, "features:", _geojsonData.features?.length);

  let data = _geojsonData;
  if (data.type === "Feature") data = { type: "FeatureCollection", features: [data] };
  else if (data.type && data.coordinates)
    data = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: data, properties: {} }],
    };
  if (!data.features?.length) {
    console.warn("[LayerPreview] no features");
    return;
  }

  geoLayer = _L!
    .geoJSON(data, {
      style: {
        color: "#ff6600",
        weight: 3,
        opacity: 0.95,
        fillColor: "#ff6600",
        fillOpacity: 0.25,
      },
      pointToLayer: pointToCircleFeature,
      onEachFeature: (feature, layer) => {
        layer.bindPopup(popupContent(feature));
      },
    })
    .addTo(map);

  const bounds = geoLayer.getBounds();
  console.log("[LayerPreview] geoLayer added, bounds:", bounds.toBBoxString(), "valid:", bounds.isValid());
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
    console.log("[LayerPreview] fitBounds done, zoom:", map.getZoom());
  }
}

function switchBasemap(basemap: BasemapOption) {
  selectedBasemap.value = basemap;
  selectedBasemapId.value = basemap.id;
  if (!map) return;
  const L = _L!;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(basemap.url, {
    attribution: basemap.attribution,
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(map);
}

// Watch the dropdown-driven basemap ID and switch when it changes.
watch(selectedBasemapId, (id) => {
  const bm = basemaps.find((b) => b.id === id);
  if (bm && bm !== selectedBasemap.value) switchBasemap(bm);
});

function cleanupMap() {
  mapResizeObserver?.disconnect();
  mapResizeObserver = null;
  labelLayer = null;
  geoLayer = null;
  tileLayer = null;
  if (map) {
    map.remove();
    map = null;
  }
  _geojsonData = null;
  labelProperty.value = "";
}

function close() {
  emit("update:open", false);
}

async function saveAsImage() {
  if (!map || !mapContainer.value || isExporting.value) return;
  isExporting.value = true;
  try {
    const defaultName = `map-${Date.now()}.png`;
    const domtoimage = (await import("dom-to-image-more")).default;
    const dataUrl = await domtoimage.toPng(mapContainer.value, {
      quality: 1,
      width: mapContainer.value.offsetWidth,
      height: mapContainer.value.offsetHeight,
    });
    const blob = await (await fetch(dataUrl)).blob();
    if (!blob) return;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.error("[LayerPreview] saveAsImage error:", err);
  } finally {
    isExporting.value = false;
  }
}

watch(
  () => props.open,
  async (open) => {
    console.log("[LayerPreview] open prop changed:", open);
    if (open) {
      await nextTick();
      if (!mapContainer.value) await nextTick();
      console.log("[LayerPreview] after nextTick, mapContainer in DOM:", !!mapContainer.value);
      await initMap();
    } else {
      cleanupMap();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => cleanupMap());
</script>

<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent :show-close-button="false" :style="contentStyle" class="layer-preview-dialog flex w-[96vw] max-w-[1800px] h-[88vh] max-h-[960px] min-w-[640px] min-h-[400px] flex-col gap-0 overflow-hidden rounded-lg border p-0 shadow-2xl" @escape-key-down="close">
      <!-- Header -->
      <div class="flex h-12 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
        <div class="flex min-w-0 shrink-0 items-center gap-2">
          <Map class="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle class="truncate text-sm font-semibold">{{ dialogTitle }}</DialogTitle>
        </div>

        <!-- Label property selector -->
        <select v-if="labelProperties.length" v-model="labelProperty" class="h-6 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none" @change="onLabelPropertyChange">
          <option value="">— 标签 —</option>
          <option v-for="p in labelProperties" :key="p" :value="p">
            {{ p }}
          </option>
        </select>

        <div class="flex flex-1" />

        <!-- Basemap selector -->
        <select v-model="selectedBasemapId" class="h-6 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none">
          <option v-for="bm in basemaps" :key="bm.id" :value="bm.id">
            {{ bm.label }}
          </option>
        </select>

        <!-- Save as image -->
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" title="导出图片" :disabled="isExporting" @click="saveAsImage">
          <Camera v-if="!isExporting" class="h-3.5 w-3.5" />
          <Loader2 v-else class="h-3.5 w-3.5 animate-spin" />
        </Button>

        <!-- Maximise -->
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
          <Maximize2 v-if="!isMaximized" class="h-3.5 w-3.5" />
          <Minimize2 v-else class="h-3.5 w-3.5" />
        </Button>

        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" :title="t('dangerDialog.cancel')" @click="close">
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>

      <!-- Map -->
      <div ref="mapContainer" class="relative w-full flex-1" style="min-height: 200px" data-map-container>
        <div class="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted-foreground pointer-events-none" data-map-placeholder>Loading map…</div>
      </div>
      <div v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-sm text-destructive">
        {{ mapError }}
      </div>

      <!-- Resize handles -->
      <div class="absolute bottom-0 right-0 z-50 h-5 w-5 cursor-se-resize" @pointerdown.prevent="onResizePointerDown($event, 'se')" @pointermove="onResizePointerMove" @pointerup="onResizePointerUp" @pointercancel="onResizePointerUp">
        <div class="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" style="border-right: 2px solid; border-bottom: 2px solid; opacity: 0.3" />
      </div>
      <div class="absolute bottom-0 left-2 right-6 z-50 h-2 cursor-s-resize opacity-0 hover:opacity-25" @pointerdown.prevent="onResizePointerDown($event, 's')" @pointermove="onResizePointerMove" @pointerup="onResizePointerUp" @pointercancel="onResizePointerUp" />
      <div class="absolute right-0 top-2 bottom-6 z-50 w-2 cursor-e-resize opacity-0 hover:opacity-25" @pointerdown.prevent="onResizePointerDown($event, 'e')" @pointermove="onResizePointerMove" @pointerup="onResizePointerUp" @pointercancel="onResizePointerUp" />
    </DialogContent>
  </Dialog>
</template>

<style>
.layer-preview-dialog .leaflet-container {
  width: 100% !important;
  height: 100% !important;
  background: #1a1a2e;
}
.layer-preview-dialog .leaflet-popup-content-wrapper {
  border-radius: var(--dbx-radius-fixed-6);
  font-size: 12px;
}
.layer-preview-dialog .leaflet-popup-content {
  margin: 8px 12px;
}
.layer-preview-label span {
  display: inline-block;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 10px;
  line-height: 1.3;
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
}
</style>
