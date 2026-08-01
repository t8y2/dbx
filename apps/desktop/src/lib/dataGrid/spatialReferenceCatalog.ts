export interface SpatialReferenceEntry {
  srid: number;
  label: string;
  kind: "lnglat" | "webmercator" | "proj4";
  /** proj4 definition string for kind === "proj4". */
  proj4?: string;
}

const GRS80 = "+ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs";

/** CGCS2000 Gauss-Kruger definitions follow the official EPSG parameters. */
function gaussKruger(lon0: number, falseEasting: number): string {
  return `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${falseEasting} +y_0=0 ${GRS80}`;
}

const entries = new Map<number, SpatialReferenceEntry>();

function add(entry: SpatialReferenceEntry) {
  entries.set(entry.srid, entry);
}

// Geographic / native
add({ srid: 4326, label: "WGS 84 (EPSG:4326)", kind: "lnglat" });
add({ srid: 4490, label: "CGCS2000 geographic (EPSG:4490)", kind: "lnglat" });
add({ srid: 3857, label: "Web Mercator (EPSG:3857)", kind: "webmercator" });
add({ srid: 3395, label: "World Mercator (EPSG:3395)", kind: "proj4", proj4: `+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 ${GRS80}` });

// CGCS2000 3-degree Gauss-Kruger, ZONE-numbered series: EPSG 4513..4533, zones 25..45.
// x_0 = zone*1e6 + 500000 — the leading digits encode the zone (e.g. 4528 = zone 40, x_0=40500000).
for (let code = 4513; code <= 4533; code++) {
  const zone = 25 + (code - 4513);
  add({ srid: code, label: `CGCS2000 3-degree GK zone ${zone} · CM ${zone * 3}E (EPSG:${code})`, kind: "proj4", proj4: gaussKruger(zone * 3, zone * 1_000_000 + 500_000) });
}
// CGCS2000 3-degree Gauss-Kruger, CM (no zone prefix) series: EPSG 4534..4554, CM 75E..135E, x_0=500000
// (e.g. 4547 = CM 114E, 4549 = CM 120E).
for (let code = 4534; code <= 4554; code++) {
  const lon0 = 75 + (code - 4534) * 3;
  add({ srid: code, label: `CGCS2000 3-degree GK CM ${lon0}E (EPSG:${code})`, kind: "proj4", proj4: gaussKruger(lon0, 500000) });
}
// CGCS2000 6-degree Gauss-Kruger, ZONE-numbered series: EPSG 4491..4501, zones 13..23.
// x_0 = zone*1e6 + 500000.
for (let code = 4491; code <= 4501; code++) {
  const zone = 13 + (code - 4491);
  add({ srid: code, label: `CGCS2000 6-degree GK zone ${zone} · CM ${zone * 6 - 3}E (EPSG:${code})`, kind: "proj4", proj4: gaussKruger(zone * 6 - 3, zone * 1_000_000 + 500_000) });
}
// CGCS2000 6-degree Gauss-Kruger, CM (no zone prefix) series: EPSG 4502..4512, CM 75E..135E, x_0=500000
for (let code = 4502; code <= 4512; code++) {
  const lon0 = 75 + (code - 4502) * 6;
  add({ srid: code, label: `CGCS2000 6-degree GK CM ${lon0}E (EPSG:${code})`, kind: "proj4", proj4: gaussKruger(lon0, 500000) });
}

export function getSpatialReference(srid: number): SpatialReferenceEntry | null {
  return entries.get(srid) ?? null;
}

/** Curated dropdown order: WGS84, Web Mercator, then common CGCS2000 zones. */
export const SHORTLIST_SRIDS: number[] = [4326, 3857, 4490, 4528, 4549, 4526, 4547];
