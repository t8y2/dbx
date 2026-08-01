import { Map as MapIcon } from "@lucide/vue";
import { registerPreviewAction, type PreviewActionContext } from "@/lib/dataGrid/resultPreviewRegistry";
import { wktToGeoJson, type GeoJsonGeometry } from "@/lib/dataGrid/geometryPreview";
import LayerPreviewDialog from "@/components/grid/LayerPreviewDialog.vue";

export interface GeometryMapFeature {
  type: "Feature";
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
}

export interface GeometryMapFeatureCollection {
  type: "FeatureCollection";
  features: GeometryMapFeature[];
  /** First non-null SRID among rendered features' columns, or null if unknown. */
  detectedSrid: number | null;
}

registerPreviewAction({
  id: "geometry-map-preview",
  label: "grid.layerPreview",
  icon: MapIcon,
  isAvailable(result) {
    return (result.column_types ?? []).some((t) => {
      const base = (t ?? "")
        .trim()
        .toLowerCase()
        .split(/[(:\s]/)[0];
      return base === "geometry" || base === "geography";
    });
  },
  execute(ctx) {
    const featureCollection = buildGeometryMapFeatureCollection(ctx);
    if (!featureCollection) return null;

    return {
      component: LayerPreviewDialog,
      props: {
        geojson: JSON.stringify(featureCollection),
      },
    };
  },
});

export function buildGeometryMapFeatureCollection(ctx: PreviewActionContext): GeometryMapFeatureCollection | null {
  const geomIndices = geometryColumnIndices(ctx.result.column_types);
  if (geomIndices.length === 0) return null;

  const features: GeometryMapFeature[] = [];
  const seen = new Set<string>();
  const sridByColumn = new Map<number, number | null>((ctx.result.spatial_columns ?? []).map((entry) => [entry.column_index, entry.srid]));
  const spatialValues = ctx.result.spatial_values;
  let detectedSrid: number | null = null;

  for (const ref of ctx.displayRowRefs) {
    if (ref.isNew) continue;
    if (ctx.selectedRowIds.length > 0 && !ctx.selectedRowIds.includes(ref.id)) continue;
    const row = ctx.result.rows[ref.sourceIndex];
    if (!row) continue;
    for (const colIdx of geomIndices) {
      const raw = row[colIdx];
      if (raw === null || raw === undefined) continue;
      const wkt = String(raw);
      if (wkt.startsWith("0x")) continue;
      const srid = spatialValues === undefined ? (sridByColumn.get(colIdx) ?? null) : (spatialValues[ref.sourceIndex]?.[colIdx] ?? null);
      const geometryKey = JSON.stringify([srid, wkt]);
      if (seen.has(geometryKey)) continue;
      seen.add(geometryKey);
      const geometry = wktToGeoJson(wkt);
      if (!geometry) continue;
      if (detectedSrid == null && srid != null) detectedSrid = srid;

      const properties: Record<string, unknown> = {
        _column: ctx.result.columns[colIdx],
        _row: ref.sourceIndex,
        _srid: srid,
      };
      for (let c = 0; c < ctx.result.columns.length; c++) {
        if (geomIndices.includes(c)) continue;
        const columnName = ctx.result.columns[c] ?? `col_${c}`;
        properties[columnName] = row[c] ?? null;
      }
      features.push({ type: "Feature", geometry, properties });
    }
  }

  return features.length > 0 ? { type: "FeatureCollection", features, detectedSrid } : null;
}

function geometryColumnIndices(columnTypes: readonly string[] | undefined): number[] {
  if (!columnTypes) return [];
  const indices: number[] = [];
  for (let i = 0; i < columnTypes.length; i++) {
    const base = (columnTypes[i] ?? "")
      .trim()
      .toLowerCase()
      .split(/[(:\s]/)[0];
    if (base === "geometry" || base === "geography") indices.push(i);
  }
  return indices;
}
