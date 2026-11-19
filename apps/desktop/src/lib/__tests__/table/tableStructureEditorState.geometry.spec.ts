import { describe, expect, it } from "vitest";

import { combinePostgresGeometryType, isPostgresGeometryDataType, POSTGRES_GEOMETRY_TYPES, postgresGeometrySridValue, postgresGeometryTypeValue } from "@/lib/table/tableStructureEditorState";

describe("postgres geometry column typmod helpers", () => {
  describe("combinePostgresGeometryType", () => {
    it("returns bare type when both sub-type and SRID are empty", () => {
      expect(combinePostgresGeometryType("geometry", "", "")).toBe("geometry");
    });

    it("emits geometry(Point) for sub-type only", () => {
      expect(combinePostgresGeometryType("geometry", "Point", "")).toBe("geometry(Point)");
    });

    it("emits geometry(GEOMETRY,4326) for SRID only (geometry(,4326) and geometry(4326) are rejected by PostGIS)", () => {
      expect(combinePostgresGeometryType("geometry", "", "4326")).toBe("geometry(GEOMETRY,4326)");
    });

    it("emits geometry(Point,4326) for both", () => {
      expect(combinePostgresGeometryType("geometry", "Point", "4326")).toBe("geometry(Point,4326)");
    });

    it("trims whitespace in inputs", () => {
      expect(combinePostgresGeometryType("  geography  ", "  Polygon  ", "  3857  ")).toBe("geography(Polygon,3857)");
    });

    it("emits geography(GEOMETRY,4326) for geography SRID only (verified against PostGIS)", () => {
      expect(combinePostgresGeometryType("geography", "", "4326")).toBe("geography(GEOMETRY,4326)");
    });

    it("returns empty string when base type is empty", () => {
      expect(combinePostgresGeometryType("", "Point", "4326")).toBe("");
    });
  });

  describe("postgresGeometryTypeValue / postgresGeometrySridValue", () => {
    it("parses geometry(Point,4326)", () => {
      expect(postgresGeometryTypeValue("geometry(Point,4326)")).toBe("Point");
      expect(postgresGeometrySridValue("geometry(Point,4326)")).toBe("4326");
    });

    it("parses geography(Polygon,3857)", () => {
      expect(postgresGeometryTypeValue("geography(Polygon,3857)")).toBe("Polygon");
      expect(postgresGeometrySridValue("geography(Polygon,3857)")).toBe("3857");
    });

    it("parses bare geometry with no typmod", () => {
      expect(postgresGeometryTypeValue("geometry")).toBe("");
      expect(postgresGeometrySridValue("geometry")).toBe("");
    });

    it("parses whitespace variant geometry( Point , 4326 )", () => {
      expect(postgresGeometryTypeValue("geometry( Point , 4326 )")).toBe("Point");
      expect(postgresGeometrySridValue("geometry( Point , 4326 )")).toBe("4326");
    });

    it("parses sub-type-only geometry(Point)", () => {
      expect(postgresGeometryTypeValue("geometry(Point)")).toBe("Point");
      expect(postgresGeometrySridValue("geometry(Point)")).toBe("");
    });

    it("parses geometry(GEOMETRY,4326) as blank (GEOMETRY = any sub-type, normalized to empty)", () => {
      expect(postgresGeometryTypeValue("geometry(GEOMETRY,4326)")).toBe("");
      expect(postgresGeometrySridValue("geometry(GEOMETRY,4326)")).toBe("4326");
    });
  });

  describe("isPostgresGeometryDataType", () => {
    it("returns true for postgres + geometry", () => {
      expect(isPostgresGeometryDataType("postgres", "geometry(Point,4326)")).toBe(true);
    });

    it("returns true for postgres + bare geography", () => {
      expect(isPostgresGeometryDataType("postgres", "geography")).toBe(true);
    });

    it("returns true for gaussdb (Postgres family)", () => {
      expect(isPostgresGeometryDataType("gaussdb", "geometry(Point,4326)")).toBe(true);
    });

    it("returns false for mysql even with a geometry type string", () => {
      expect(isPostgresGeometryDataType("mysql", "geometry")).toBe(false);
    });

    it("returns false for postgres non-spatial types", () => {
      expect(isPostgresGeometryDataType("postgres", "varchar(255)")).toBe(false);
    });
  });

  it("POSTGRES_GEOMETRY_TYPES includes the OGC simple-feature sub-types", () => {
    expect(POSTGRES_GEOMETRY_TYPES).toContain("Point");
    expect(POSTGRES_GEOMETRY_TYPES).toContain("LineString");
    expect(POSTGRES_GEOMETRY_TYPES).toContain("Polygon");
    expect(POSTGRES_GEOMETRY_TYPES).toContain("MultiPoint");
    expect(POSTGRES_GEOMETRY_TYPES).toContain("MultiPolygon");
    expect(POSTGRES_GEOMETRY_TYPES).toContain("GeometryCollection");
  });
});
