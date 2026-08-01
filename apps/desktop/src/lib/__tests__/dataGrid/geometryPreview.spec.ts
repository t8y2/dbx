import { describe, expect, it } from "vitest";
import { parseWktGeometry, renderGeometryOnCanvas, wktToGeoJson } from "@/lib/dataGrid/geometryPreview";

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

  it("defensively strips an old EWKT prefix", () => {
    expect(wktToGeoJson("SRID=4326;POINT(116.397 39.908)")).toEqual({
      type: "Point",
      coordinates: [116.397, 39.908],
    });
    expect(parseWktGeometry("SRID=3857;POINT(1 2)")?.type).toBe("POINT");
  });

  it("rejects a geometry collection when any member cannot be parsed", () => {
    expect(wktToGeoJson("GEOMETRYCOLLECTION(POINT(1 2),NOT_A_GEOMETRY(3 4))")).toBeNull();
  });

  it("fills polygon holes with the even-odd rule", () => {
    const fillRules: string[] = [];
    const context = {
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {},
      arc() {},
      fill(rule?: string) {
        if (rule) fillRules.push(rule);
      },
      fillStyle: "",
      strokeStyle: "",
      font: "",
      textAlign: "",
      lineWidth: 0,
      lineJoin: "",
      lineCap: "",
      fillText() {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 400, height: 280, getContext: () => context } as unknown as HTMLCanvasElement;
    const geometry = parseWktGeometry("POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,8 2,8 8,2 8,2 2))");
    expect(geometry).not.toBeNull();
    renderGeometryOnCanvas(canvas, geometry!);
    expect(fillRules).toContain("evenodd");
  });
});
