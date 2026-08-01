// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import L from "leaflet";
import { createBuiltInCoordsToLatLng, prepareCoordsToLatLng } from "@/lib/dataGrid/geometryProjection";

describe("geometry projection", () => {
  it("maps equivalent EPSG:4326 and EPSG:3857 points to the same location", () => {
    const latLng = L.latLng(39.908, 116.397);
    const projected = L.CRS.EPSG3857.project(latLng);
    const from4326 = createBuiltInCoordsToLatLng(4326, L)!([116.397, 39.908]);
    const from3857 = createBuiltInCoordsToLatLng(3857, L)!([projected.x, projected.y]);

    expect(from3857.lat).toBeCloseTo(from4326.lat, 8);
    expect(from3857.lng).toBeCloseTo(from4326.lng, 8);
  });

  it("projects a CGCS2000 zone-40 (EPSG:4528) easting near 120E", async () => {
    const toLatLng = await prepareCoordsToLatLng(4528, L);
    expect(toLatLng).not.toBeNull();
    const ll = toLatLng!([40_500_000, 2_600_000]); // zone-40 false easting, ~lon 120

    expect(ll.lng).toBeCloseTo(120, 1);
    expect(ll.lat).toBeGreaterThan(0);
  });

  it("returns no converter for missing and unsupported spatial references", async () => {
    expect(createBuiltInCoordsToLatLng(null, L)).toBeNull();
    await expect(prepareCoordsToLatLng(2154, L)).resolves.toBeNull();
  });
});
