export interface PreparedGeometryLayer<TLayer> {
  layer: TLayer;
  srid: number;
}

export interface GeometryLayerRenderSummary {
  rendered: number;
  skipped: number;
  srids: number[];
}

/** Render features independently so one malformed geometry cannot hide valid layers. */
export function renderGeometryFeaturesIndependently<TFeature, TLayer>(features: readonly TFeature[], prepareLayer: (feature: TFeature) => PreparedGeometryLayer<TLayer> | null, addLayer: (layer: TLayer) => void, onError?: (error: unknown) => void): GeometryLayerRenderSummary {
  let rendered = 0;
  let skipped = 0;
  const srids = new Set<number>();

  for (const feature of features) {
    try {
      const prepared = prepareLayer(feature);
      if (!prepared) {
        skipped++;
        continue;
      }
      addLayer(prepared.layer);
      rendered++;
      srids.add(prepared.srid);
    } catch (error) {
      skipped++;
      onError?.(error);
    }
  }

  return { rendered, skipped, srids: Array.from(srids).sort((a, b) => a - b) };
}
