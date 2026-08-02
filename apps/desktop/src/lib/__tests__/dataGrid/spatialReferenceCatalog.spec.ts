import { describe, it, expect } from "vitest";
import { getSpatialReference, SHORTLIST_SRIDS } from "@/lib/dataGrid/spatialReferenceCatalog";

describe("spatialReferenceCatalog", () => {
  it("resolves WGS84 and Web Mercator natively", () => {
    expect(getSpatialReference(4326)?.kind).toBe("lnglat");
    expect(getSpatialReference(3857)?.kind).toBe("webmercator");
  });

  it("resolves CGCS2000 3-degree zone 40 (4528) with false easting 40500000", () => {
    const entry = getSpatialReference(4528);
    expect(entry?.kind).toBe("proj4");
    expect(entry?.proj4).toContain("+lon_0=120");
    expect(entry?.proj4).toContain("+x_0=40500000 ");
  });

  it("resolves CGCS2000 3-degree CM 120E (4549) with false easting 500000", () => {
    const entry = getSpatialReference(4549);
    expect(entry?.proj4).toContain("+lon_0=120");
    expect(entry?.proj4).toContain("+x_0=500000 ");
  });

  it("resolves CGCS2000 3-degree CM 114E (4547) with false easting 500000", () => {
    const entry = getSpatialReference(4547);
    expect(entry?.proj4).toContain("+lon_0=114");
    expect(entry?.proj4).toContain("+x_0=500000 ");
  });

  it("treats CGCS2000 geographic (4490) as lng/lat", () => {
    expect(getSpatialReference(4490)?.kind).toBe("lnglat");
  });

  it("returns null for codes outside the offline subset", () => {
    expect(getSpatialReference(2154)).toBeNull();
  });

  it("shortlist starts with 4326 and 3857", () => {
    expect(SHORTLIST_SRIDS.slice(0, 2)).toEqual([4326, 3857]);
  });
});
