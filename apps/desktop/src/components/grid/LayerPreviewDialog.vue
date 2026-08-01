<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Camera, Loader2, Map, Maximize2, Minimize2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { renderGeometryFeaturesIndependently } from "@/lib/dataGrid/geometryLayerPreview";
import { prepareCoordsToLatLng, type CoordinateToLatLng } from "@/lib/dataGrid/geometryProjection";
import { getSpatialReference, SHORTLIST_SRIDS } from "@/lib/dataGrid/spatialReferenceCatalog";
import type { GeoJsonGeometry } from "@/lib/dataGrid/geometryPreview";
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
const isLoadingMap = ref(false);
const isExporting = ref(false);
const skippedFeatureCount = ref(0);

// ── Effective SRID (detected default + manual override) ─────────────────────
const detectedSrid = ref<number | null>(null);
const selectedSrid = ref<number>(4326);
const customSridInput = ref<string>("");
const showCustomSrid = ref(false);

const sridOptions = computed(() => SHORTLIST_SRIDS.map((srid) => ({ srid, label: getSpatialReference(srid)?.label ?? `EPSG:${srid}` })));
const effectiveSrid = computed(() => selectedSrid.value);
const spatialSourceLabel = computed(() => {
  if (selectedSrid.value !== (detectedSrid.value ?? 4326)) return t("grid.layerPreviewCrsManual");
  if (detectedSrid.value != null) return t("grid.layerPreviewCrsDetected");
  return t("grid.layerPreviewCrsAssumed");
});

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
let geoLayer: L.FeatureGroup | null = null;
let labelLayer: L.LayerGroup | null = null;
let tileLayer: L.TileLayer | null = null;
let mapResizeObserver: ResizeObserver | null = null;
let _geojsonData: any = null;
let mapGeneration = 0;
let coordinateConverters = new globalThis.Map<number, CoordinateToLatLng>();

interface PreviewFeature {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

/**
 * SRID a feature should be projected with: a manual CRS override applies to
 * every feature; otherwise each feature uses its own per-cell SRID, falling
 * back to the detected/selected one when unknown.
 */
function featureSrid(feature: PreviewFeature): number {
  const manualSrid = selectedSrid.value !== (detectedSrid.value ?? null) ? selectedSrid.value : null;
  return manualSrid ?? (typeof feature.properties?._srid === "number" ? feature.properties._srid : effectiveSrid.value);
}

async function loadLeaflet(): Promise<typeof L> {
  if (!_L) {
    const mod = await import("leaflet");
    _L = mod.default as unknown as typeof L;
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
    const coords = getLabelCoords(f.geometry, featureSrid(f));
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

function collectCoordinatePairs(geometry: any): [number, number][] {
  const pairs: [number, number][] = [];
  const visit = (value: any) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      pairs.push([value[0], value[1]]);
      return;
    }
    value.forEach(visit);
  };
  if (geometry?.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) pairs.push(...collectCoordinatePairs(child));
  } else {
    visit(geometry?.coordinates);
  }
  return pairs;
}

function geometryCoordinatesAreValid(geometry: any, srid: number, converter: (coord: [number, number]) => L.LatLng): boolean {
  const coordinates = collectCoordinatePairs(geometry);
  if (coordinates.length === 0) return false;
  return coordinates.every(([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (srid === 4326 && (x < -180 || x > 180 || y < -90 || y > 90)) return false;
    if (srid === 3857 && (Math.abs(x) > 20037508.342789244 || Math.abs(y) > 20037508.342789244)) return false;
    const latlng = converter([x, y]);
    return Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng) && latlng.lat >= -90 && latlng.lat <= 90 && latlng.lng >= -180 && latlng.lng <= 180;
  });
}

function getLabelCoords(geom: any, srid: number): [number, number] | null {
  const converter = coordinateConverters.get(srid) ?? null;
  if (!geom || !converter || !geometryCoordinatesAreValid(geom, srid, converter)) return null;
  const pts = collectCoordinatePairs(geom);
  if (pts.length === 0) return null;
  const projected = pts.map((coord) => converter(coord));
  const avgLng = projected.reduce((sum, point) => sum + point.lng, 0) / projected.length;
  const avgLat = projected.reduce((sum, point) => sum + point.lat, 0) / projected.length;
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
  const generation = mapGeneration;
  mapError.value = "";
  isLoadingMap.value = true;

  try {
    const L = await loadLeaflet();
    if (generation !== mapGeneration || !props.open) return;

    map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      center: [35, 110],
      zoom: 4,
    });
    map.invalidateSize();

    tileLayer = L.tileLayer(selectedBasemap.value.url, {
      attribution: selectedBasemap.value.attribution,
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
    // Sync ID ref
    selectedBasemapId.value = selectedBasemap.value.id;
    await addGeoJsonToMap(generation);
    if (generation !== mapGeneration || !map) return;
    if (_geojsonData) parseLabelProperties(_geojsonData);

    mapResizeObserver = new ResizeObserver(() => {
      map?.invalidateSize();
    });
    mapResizeObserver.observe(container);
    setTimeout(() => {
      map?.invalidateSize();
    }, 500);
  } catch (err) {
    if (generation === mapGeneration) {
      console.error("[LayerPreview] initMap error:", err);
      mapError.value = String(err);
    }
  } finally {
    if (generation === mapGeneration) isLoadingMap.value = false;
  }
}

async function addGeoJsonToMap(generation: number) {
  if (!map || geoLayer) return;
  try {
    _geojsonData = JSON.parse(props.geojson);
  } catch {
    console.warn("[LayerPreview] invalid geojson JSON");
    mapError.value = t("grid.layerPreviewNoGeometryData");
    return;
  }

  let data = _geojsonData;
  if (data.type === "Feature") data = { type: "FeatureCollection", features: [data] };
  else if (data.type && data.coordinates)
    data = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: data, properties: {} }],
    };
  if (!data.features?.length) {
    console.warn("[LayerPreview] no features");
    mapError.value = t("grid.layerPreviewNoGeometryData");
    return;
  }

  detectedSrid.value = typeof data.detectedSrid === "number" ? data.detectedSrid : null;
  selectedSrid.value = detectedSrid.value ?? 4326;
  _geojsonData = data;

  await renderLayer(generation);
}

async function renderLayer(generation: number) {
  if (!map || !_geojsonData || !_L) return;
  skippedFeatureCount.value = 0;
  const leaflet = _L;
  const data = _geojsonData;

  try {
    const features = (data.features ?? []) as PreviewFeature[];
    const sridsNeeded = new Set<number>();
    for (const feature of features) {
      const srid = featureSrid(feature);
      if (Number.isInteger(srid) && srid > 0) sridsNeeded.add(srid);
    }
    const converters = new globalThis.Map<number, CoordinateToLatLng>();
    for (const srid of sridsNeeded) {
      const converter = await prepareCoordsToLatLng(srid, leaflet);
      if (converter) converters.set(srid, converter);
    }
    if (generation !== mapGeneration || !map) return;
    if (converters.size === 0) {
      mapError.value = t("grid.layerPreviewUnsupportedCrs", { srid: effectiveSrid.value });
      return;
    }
    coordinateConverters = converters;

    geoLayer = leaflet.featureGroup().addTo(map);
    const summary = renderGeometryFeaturesIndependently(
      features,
      (feature) => {
        const geometry = feature.geometry;
        const srid = featureSrid(feature);
        const converter = converters.get(srid) ?? null;
        if (!geometry || !converter || !geometryCoordinatesAreValid(geometry, srid, converter)) {
          return null;
        }
        const layer = leaflet.geoJSON(feature as unknown as Parameters<(typeof L)["geoJSON"]>[0], {
          coordsToLatLng: (coords) => converter([coords[0], coords[1]]),
          style: {
            color: "#ff6600",
            weight: 3,
            opacity: 0.95,
            fillColor: "#ff6600",
            fillOpacity: 0.25,
          },
          pointToLayer: pointToCircleFeature,
          onEachFeature: (sourceFeature, layer) => layer.bindPopup(popupContent(sourceFeature)),
        });
        return { layer, srid };
      },
      (layer) => layer.addTo(geoLayer!),
      (error) => console.warn("[LayerPreview] skipped invalid feature", error),
    );
    skippedFeatureCount.value = summary.skipped;
    if (summary.rendered === 0) {
      mapError.value = t("grid.layerPreviewNoSupportedCrs");
      return;
    }

    const bounds = geoLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
    }
  } catch (err) {
    if (generation === mapGeneration) {
      console.error("[LayerPreview] renderLayer error:", err);
      mapError.value = String(err);
    }
  }
}

async function applySrid(next: number) {
  selectedSrid.value = next;
  mapError.value = "";
  if (!map) return;
  mapGeneration++;
  const generation = mapGeneration;
  if (geoLayer) {
    map.removeLayer(geoLayer);
    geoLayer = null;
  }
  if (labelLayer) {
    map.removeLayer(labelLayer);
    labelLayer = null;
  }
  await renderLayer(generation);
  if (generation === mapGeneration && labelProperty.value) updateLabels();
}

function onSridSelect(value: string) {
  if (value === "custom") {
    showCustomSrid.value = true;
    return;
  }
  showCustomSrid.value = false;
  void applySrid(Number(value));
}

function onCustomSridSubmit() {
  const srid = Number.parseInt(customSridInput.value, 10);
  if (!Number.isInteger(srid) || srid <= 0) return;
  void applySrid(srid);
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
  mapGeneration++;
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
  coordinateConverters = new globalThis.Map();
  detectedSrid.value = null;
  selectedSrid.value = 4326;
  showCustomSrid.value = false;
  customSridInput.value = "";
  labelProperty.value = "";
  isLoadingMap.value = false;
  skippedFeatureCount.value = 0;
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
    if (open) {
      await nextTick();
      if (!mapContainer.value) await nextTick();
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
      <div class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2">
        <div class="flex min-w-32 flex-1 items-center gap-2">
          <Map class="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle class="truncate text-sm font-semibold">{{ dialogTitle }}</DialogTitle>
        </div>

        <!-- SRID selector (built-in shortlist + custom EPSG) -->
        <select class="h-6 max-w-44 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none" :value="showCustomSrid ? 'custom' : String(selectedSrid)" @change="onSridSelect(($event.target as HTMLSelectElement).value)">
          <option v-for="opt in sridOptions" :key="opt.srid" :value="String(opt.srid)">{{ opt.label }}</option>
          <option v-if="!sridOptions.some((o) => o.srid === selectedSrid)" :value="String(selectedSrid)">
            {{ getSpatialReference(selectedSrid)?.label ?? `EPSG:${selectedSrid}` }}
          </option>
          <option value="custom">{{ t("grid.layerPreviewCustomCrs") }}</option>
        </select>
        <input v-if="showCustomSrid" v-model="customSridInput" type="number" inputmode="numeric" :placeholder="t('grid.layerPreviewCustomCrsPlaceholder')" class="h-6 w-24 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none" @keyup.enter="onCustomSridSubmit" />
        <span class="shrink-0 text-[11px] text-muted-foreground">{{ spatialSourceLabel }}</span>
        <span v-if="skippedFeatureCount > 0" class="shrink-0 text-[11px] text-amber-600">
          {{ t("grid.layerPreviewSkipped", { count: skippedFeatureCount }) }}
        </span>

        <!-- Label property selector -->
        <select v-if="labelProperties.length" v-model="labelProperty" class="h-6 max-w-40 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none" @change="onLabelPropertyChange">
          <option value="">{{ t("grid.layerPreviewLabel") }}</option>
          <option v-for="p in labelProperties" :key="p" :value="p">
            {{ p }}
          </option>
        </select>

        <!-- Basemap selector -->
        <select v-model="selectedBasemapId" class="ml-auto h-6 shrink-0 rounded border bg-background px-1.5 text-[11px] outline-none">
          <option v-for="bm in basemaps" :key="bm.id" :value="bm.id">
            {{ bm.label }}
          </option>
        </select>

        <!-- Save as image -->
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" :title="t('grid.layerPreviewExport')" :disabled="isExporting" @click="saveAsImage">
          <Camera v-if="!isExporting" class="h-3.5 w-3.5" />
          <Loader2 v-else class="h-3.5 w-3.5 animate-spin" />
        </Button>

        <!-- Maximise -->
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" :title="isMaximized ? t('grid.layerPreviewRestore') : t('grid.layerPreviewMaximize')" @click="toggleMaximize">
          <Maximize2 v-if="!isMaximized" class="h-3.5 w-3.5" />
          <Minimize2 v-else class="h-3.5 w-3.5" />
        </Button>

        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground" :title="t('dangerDialog.cancel')" @click="close">
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>

      <!-- Map -->
      <div ref="mapContainer" class="relative w-full flex-1" style="min-height: 200px" data-map-container>
        <div v-if="isLoadingMap" class="absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-xs text-muted-foreground pointer-events-none" data-map-placeholder>{{ t("grid.layerPreviewLoading") }}</div>
        <div v-if="mapError" class="absolute inset-0 z-20 flex items-center justify-center bg-background/90 p-4 text-sm text-destructive">
          {{ mapError }}
        </div>
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
