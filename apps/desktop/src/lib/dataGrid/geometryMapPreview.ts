import { Map as MapIcon } from "@lucide/vue";
import { registerPreviewAction, type PreviewActionContext } from "@/lib/dataGrid/resultPreviewRegistry";
import { wktToGeoJson, type GeoJsonGeometry } from "@/lib/dataGrid/geometryPreview";
import LayerPreviewDialog from "@/components/grid/LayerPreviewDialog.vue";
import type { QueryResult } from "@/types/database";

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
    return hasGeometryMapPreviewColumns(result);
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

export function hasGeometryMapPreviewColumns(result: Pick<QueryResult, "column_types"> & Partial<Pick<QueryResult, "spatial_columns">>): boolean {
  return geometryColumnIndices(result.column_types, result.spatial_columns).length > 0;
}

export function buildGeometryMapFeatureCollection(ctx: PreviewActionContext): GeometryMapFeatureCollection | null {
  let geomIndices = geometryColumnIndices(ctx.result.column_types, ctx.result.spatial_columns);
  if (geomIndices.length === 0) return null;

  if (ctx.selectedColumnIndexes && ctx.selectedColumnIndexes.length > 0) {
    const selectedGeomIndices = geomIndices.filter((idx) => ctx.selectedColumnIndexes!.includes(idx));
    // A column selection without geometry columns is not previewable; only an
    // empty/absent selection falls back to every geometry column.
    if (selectedGeomIndices.length === 0) return null;
    geomIndices = selectedGeomIndices;
  }

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

export function geometryColumnIndices(columnTypes: readonly string[] | undefined, spatialColumns?: readonly { column_index: number }[]): number[] {
  const indices = new Set<number>();
  if (columnTypes && columnTypes.length > 0) {
    for (let i = 0; i < columnTypes.length; i++) {
      const base = (columnTypes[i] ?? "")
        .trim()
        .toLowerCase()
        .split(/[(:\s]/)[0];
      if (base === "geometry" || base === "geography") indices.add(i);
    }
  } else if (spatialColumns) {
    for (const entry of spatialColumns) {
      if (typeof entry.column_index === "number" && entry.column_index >= 0) {
        indices.add(entry.column_index);
      }
    }
  }
  return [...indices].sort((a, b) => a - b);
}
