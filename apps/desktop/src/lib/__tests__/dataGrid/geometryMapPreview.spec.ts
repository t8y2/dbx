import { describe, expect, it } from "vitest";
import { buildGeometryMapFeatureCollection, hasGeometryMapPreviewColumns } from "@/lib/dataGrid/geometryMapPreview";
import type { PreviewActionContext } from "@/lib/dataGrid/resultPreviewRegistry";

function context(): PreviewActionContext {
  return {
    result: {
      columns: ["shape", "name"],
      column_types: ["geometry", "text"],
      column_sortables: [],
      spatial_columns: [{ column_index: 0, srid: 4326 }],
      rows: [
        ["POINT(116.397 39.908)", "wgs84"],
        ["POINT(12957254.77 4852618.61)", "mercator"],
        ["POINT(1 2)", "unknown"],
      ],
      affected_rows: 0,
      execution_time_ms: 1,
      truncated: false,
      has_more: false,
    },
    selectedRowIds: [],
    displayRowRefs: [
      { id: 20, sourceIndex: 1, isNew: false },
      { id: 10, sourceIndex: 0, isNew: false },
      { id: 30, sourceIndex: 2, isNew: false },
    ],
  };
}

describe("buildGeometryMapFeatureCollection", () => {
  it("treats GEOGRAPHY columns as map-preview layers and preserves SRID metadata", () => {
    const ctx = context();
    ctx.result.column_types = ["GEOGRAPHY", "text"];
    ctx.result.columns = ["location", "name"];
    ctx.result.rows = [["SRID=4326;POINT(116.397 39.908)", "wgs84"]];
    ctx.result.spatial_columns = [{ column_index: 0, srid: 4326 }];
    ctx.result.spatial_values = [[4326, null]];
    ctx.displayRowRefs = [{ id: 1, sourceIndex: 0, isNew: false }];

    expect(hasGeometryMapPreviewColumns(ctx.result)).toBe(true);
    expect(buildGeometryMapFeatureCollection(ctx)).toEqual({
      type: "FeatureCollection",
      detectedSrid: 4326,
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [116.397, 39.908] },
          properties: { _column: "location", _row: 0, _srid: 4326, name: "wgs84" },
        },
      ],
    });
  });

  it("checks preview availability from column metadata without parsing result rows", () => {
    const result = context().result;
    expect(hasGeometryMapPreviewColumns(result)).toBe(true);

    result.rows = [
      [null, "empty"],
      ["0x0101000000", "binary"],
      ["not geometry", "invalid"],
    ];
    expect(hasGeometryMapPreviewColumns(result)).toBe(true);

    result.column_types = ["text", "text"];
    expect(hasGeometryMapPreviewColumns(result)).toBe(false);
  });

  it("exposes the detected layer SRID and binds row properties by sourceIndex", () => {
    const collection = buildGeometryMapFeatureCollection(context());

    expect(collection?.detectedSrid).toBe(4326);
    expect(collection?.features.map((feature) => feature.properties.name)).toEqual(["mercator", "wgs84", "unknown"]);
  });

  it("reports detectedSrid null when spatial metadata is absent", () => {
    const ctx = context();
    ctx.result.spatial_columns = undefined;

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.detectedSrid).toBeNull();
  });

  it("binds each feature to its own per-cell SRID when the column mixes SRIDs", () => {
    const ctx = context();
    ctx.result.spatial_columns = [{ column_index: 0, srid: 4326 }];
    // Per-cell SRIDs, parallel to rows: wgs84=4326, mercator=3857, unknown=null.
    ctx.result.spatial_values = [
      [4326, null],
      [3857, null],
      [null, null],
    ];

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features.map((feature) => feature.properties._srid)).toEqual([3857, 4326, null]);
  });

  it("prefers per-cell SRIDs over column-level hints", () => {
    const ctx = context();
    ctx.result.spatial_columns = [{ column_index: 0, srid: 3857 }];
    ctx.result.spatial_values = [
      [4326, null],
      [null, null],
      [null, null],
    ];

    const collection = buildGeometryMapFeatureCollection(ctx);
    // wgs84 row carries its own 4326 even though the column hint says 3857.
    expect(collection?.features.find((f) => f.properties.name === "wgs84")?.properties._srid).toBe(4326);
  });

  it("uses the column-level hint only for legacy results without per-cell metadata", () => {
    const ctx = context();
    ctx.result.spatial_columns = [{ column_index: 0, srid: 3857 }];
    ctx.result.spatial_values = undefined;

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features.map((feature) => feature.properties._srid)).toEqual([3857, 3857, 3857]);
  });

  it("deduplicates geometry by SRID and WKT", () => {
    const ctx = context();
    ctx.result.rows = [
      ["POINT(1 2)", "wgs84"],
      ["POINT(1 2)", "mercator"],
      ["POINT(1 2)", "duplicate wgs84"],
    ];
    ctx.result.spatial_values = [
      [4326, null],
      [3857, null],
      [4326, null],
    ];

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features.map((feature) => feature.properties._srid)).toEqual([3857, 4326]);
    expect(collection?.features.map((feature) => feature.properties.name)).toEqual(["mercator", "wgs84"]);
  });

  it("filters preview features according to selectedRowIds", () => {
    const ctx = context();
    // displayRowRefs: [{ id: 20, sourceIndex: 1 }, { id: 10, sourceIndex: 0 }, { id: 30, sourceIndex: 2 }]
    ctx.selectedRowIds = [10];

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features).toHaveLength(1);
    expect(collection?.features[0].properties.name).toBe("wgs84");
  });

  it("filters preview features according to selectedColumnIndexes", () => {
    const ctx = context();
    ctx.result.columns = ["shape_a", "shape_b", "name"];
    ctx.result.column_types = ["geometry", "geometry", "text"];
    ctx.result.rows = [["POINT(1 1)", "POINT(2 2)", "first"]];
    ctx.displayRowRefs = [{ id: 1, sourceIndex: 0, isNew: false }];
    ctx.selectedColumnIndexes = [1];

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features).toHaveLength(1);
    expect(collection?.features[0].properties._column).toBe("shape_b");
  });

  it("interprets selectedColumnIndexes in the actual data-column space", () => {
    const ctx = context();
    // Hidden leading id column: "shape" is visible grid position 0 but actual
    // data column 1; the caller maps visible positions before passing them in.
    ctx.result.columns = ["id", "shape", "name"];
    ctx.result.column_types = ["int", "geometry", "text"];
    ctx.result.rows = [[7, "POINT(1 1)", "first"]];
    ctx.displayRowRefs = [{ id: 1, sourceIndex: 0, isNew: false }];
    ctx.selectedColumnIndexes = [1];

    const collection = buildGeometryMapFeatureCollection(ctx);
    expect(collection?.features).toHaveLength(1);
    expect(collection?.features[0].properties._column).toBe("shape");
  });

  it("returns null when the column selection contains no geometry column", () => {
    const ctx = context();
    ctx.result.columns = ["shape_a", "shape_b", "name"];
    ctx.result.column_types = ["geometry", "geometry", "text"];
    ctx.result.rows = [["POINT(1 1)", "POINT(2 2)", "first"]];
    ctx.displayRowRefs = [{ id: 1, sourceIndex: 0, isNew: false }];
    ctx.selectedColumnIndexes = [2];

    expect(buildGeometryMapFeatureCollection(ctx)).toBeNull();
  });

  it("recognizes spatial_columns when column_types is empty or omitted", () => {
    const result = {
      column_types: [],
      spatial_columns: [{ column_index: 0, srid: 4326 }],
    };
    expect(hasGeometryMapPreviewColumns(result)).toBe(true);
  });
});
