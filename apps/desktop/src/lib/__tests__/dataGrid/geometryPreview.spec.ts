import { describe, expect, it } from "vitest";
import { wktToGeoJson } from "@/lib/dataGrid/geometryPreview";

describe("wktToGeoJson", () => {
  it("preserves polygon interior rings", () => {
    const geometry = wktToGeoJson("POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,8 2,8 8,2 8,2 2))");

    expect(geometry).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [8, 2],
          [8, 8],
          [2, 8],
          [2, 2],
        ],
      ],
    });
  });

  it("preserves multipolygon interior rings", () => {
    const geometry = wktToGeoJson("MULTIPOLYGON(((0 0,10 0,10 10,0 10,0 0),(2 2,8 2,8 8,2 8,2 2)))");

    expect(geometry).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [8, 2],
            [8, 8],
            [2, 8],
            [2, 2],
          ],
        ],
      ],
    });
  });
});
