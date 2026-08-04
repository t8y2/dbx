import type L from "leaflet";
import type { Coord } from "@/lib/dataGrid/geometryPreview";
import { getSpatialReference } from "@/lib/dataGrid/spatialReferenceCatalog";

export type CoordinateToLatLng = (coord: Coord) => L.LatLng;

type CoordinateTransform = (coord: Coord) => Coord;

const transformPromises = new Map<number, Promise<CoordinateTransform>>();

export function createBuiltInCoordsToLatLng(srid: number | null | undefined, leaflet: typeof L): CoordinateToLatLng | null {
  if (srid == null) return null;
  const entry = getSpatialReference(srid);
  if (entry?.kind === "lnglat") return (coord) => leaflet.latLng(coord[1], coord[0]);
  if (entry?.kind === "webmercator") return (coord) => leaflet.CRS.EPSG3857.unproject(leaflet.point(coord[0], coord[1]));
  return null;
}

export async function prepareCoordsToLatLng(srid: number | null | undefined, leaflet: typeof L): Promise<CoordinateToLatLng | null> {
  const builtIn = createBuiltInCoordsToLatLng(srid, leaflet);
  if (builtIn) return builtIn;
  if (srid == null) return null;
  const entry = getSpatialReference(srid);
  if (!entry || entry.kind !== "proj4" || !entry.proj4) return null;

  let transformPromise = transformPromises.get(srid);
  if (!transformPromise) {
    transformPromise = loadCoordinateTransform(srid, entry.proj4);
    transformPromises.set(srid, transformPromise);
    transformPromise.catch(() => transformPromises.delete(srid));
  }
  const transform = await transformPromise;
  return (coord) => {
    const [longitude, latitude] = transform(coord);
    return leaflet.latLng(latitude, longitude);
  };
}

async function loadCoordinateTransform(srid: number, definition: string): Promise<CoordinateTransform> {
  const { default: proj4 } = await import("proj4");
  const source = `EPSG:${srid}`;
  proj4.defs(source, definition);
  const converter = proj4(source, "EPSG:4326");
  return ([x, y]) => {
    const [longitude, latitude] = converter.forward([x, y]);
    return [longitude, latitude];
  };
}
