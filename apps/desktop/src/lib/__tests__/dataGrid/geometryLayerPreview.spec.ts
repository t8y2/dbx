import { describe, expect, it } from "vitest";
import { renderGeometryFeaturesIndependently } from "@/lib/dataGrid/geometryLayerPreview";

describe("renderGeometryFeaturesIndependently", () => {
  it("keeps valid mixed-SRID layers when other features are unsupported or throw", () => {
    const added: string[] = [];
    const errors: unknown[] = [];
    const summary = renderGeometryFeaturesIndependently(
      [
        { id: "wgs84", srid: 4326 },
        { id: "unknown", srid: null },
        { id: "broken", srid: 3857 },
        { id: "mercator", srid: 3857 },
      ],
      (feature) => {
        if (feature.srid === null) return null;
        if (feature.id === "broken") throw new Error("invalid geometry");
        return { layer: feature.id, srid: feature.srid };
      },
      (layer) => added.push(layer),
      (error) => errors.push(error),
    );

    expect(added).toEqual(["wgs84", "mercator"]);
    expect(summary).toEqual({ rendered: 2, skipped: 2, srids: [3857, 4326] });
    expect(errors).toHaveLength(1);
  });

  it("reports an entirely unsupported result without adding layers", () => {
    const summary = renderGeometryFeaturesIndependently(
      [null, 4490],
      () => null,
      () => {
        throw new Error("must not add a layer");
      },
    );

    expect(summary).toEqual({ rendered: 0, skipped: 2, srids: [] });
  });
});
