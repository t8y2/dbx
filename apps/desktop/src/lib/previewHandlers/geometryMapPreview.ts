import { Map as MapIcon } from "@lucide/vue";
import { registerPreviewAction } from "@/lib/resultPreviewRegistry";
import { wktToGeoJson } from "@/lib/geometryPreview";
import LayerPreviewDialog from "@/components/grid/LayerPreviewDialog.vue";

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
    const geomIndices = geometryColumnIndices(ctx.result.column_types);
    if (geomIndices.length === 0) return null;

    const features: Record<string, any>[] = [];
    const seen = new Set<string>();

    for (const ref of ctx.displayRowRefs) {
      if (ref.isNew) continue;
      // Only include selected rows if there's an active selection
      if (ctx.selectedRowIds.length > 0 && !ctx.selectedRowIds.includes(ref.id)) continue;
      const row = ctx.result.rows[ref.sourceIndex];
      if (!row) continue;
      for (const colIdx of geomIndices) {
        const raw = row[colIdx];
        if (raw === null || raw === undefined) continue;
        const wkt = String(raw);
        if (wkt.startsWith("0x") || seen.has(wkt)) continue;
        seen.add(wkt);
        const geom = wktToGeoJson(wkt);
        if (geom) {
          // Include all non-geometry column values as properties for labelling.
          const props: Record<string, any> = {
            _column: ctx.result.columns[colIdx],
            _row: ref.sourceIndex,
          };
          for (let c = 0; c < ctx.result.columns.length; c++) {
            if (geomIndices.includes(c)) continue; // skip geometry columns
            const colName = ctx.result.columns[c] ?? `col_${c}`;
            const val = row[c];
            props[colName] = val ?? null;
          }
          features.push({
            type: "Feature",
            geometry: geom,
            properties: props,
          });
        }
      }
    }

    if (features.length === 0) return null;

    const fc = { type: "FeatureCollection", features };

    return {
      component: LayerPreviewDialog,
      props: {
        geojson: JSON.stringify(fc),
      },
    };
  },
});

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
