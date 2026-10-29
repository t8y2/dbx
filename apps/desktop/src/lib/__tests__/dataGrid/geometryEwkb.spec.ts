import { describe, expect, it } from "vitest";
import { buildGeometryRawView, buildYashanRawStruct } from "@/lib/dataGrid/geometryEwkb";

// Fixtures captured from YashanDB 23.4 via
// SELECT ST_ASEWKB(ST_GeomFromText(<wkt>, 4326)) FROM DUAL.
const FIXTURES: Array<[string, number | null, string]> = [
  ["POINT(116.397 39.908)", 4326, "0x0101000020e6100000c520b07268195d404e62105839f44340"],
  ["POINT Z(116.397 39.908 50)", 4326, "0x01010000a0e6100000c520b07268195d404e62105839f443400000000000004940"],
  ["LINESTRING(1 2,3 4,5 6)", 4326, "0x0102000020e610000003000000000000000000f03f00000000000000400000000000000840000000000000104000000000000014400000000000001840"],
  ["POLYGON((0 0,1 0,1 1,0 1,0 0))", 4326, "0x0103000020e6100000010000000500000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000f03f0000000000000000000000000000f03f00000000000000000000000000000000"],
  ["MULTIPOINT((1 2),(3 4))", 4326, "0x0104000020e6100000020000000101000000000000000000f03f0000000000000040010100000000000000000008400000000000001040"],
  ["LINESTRING Z(1 2 3,4 5 6)", 4326, "0x01020000a0e610000002000000000000000000f03f00000000000000400000000000000840000000000000104000000000000014400000000000001840"],
  ["MULTIPOINT Z((1 2 3),(4 5 6))", 4326, "0x01040000a0e6100000020000000101000080000000000000f03f000000000000004000000000000008400101000080000000000000104000000000000014400000000000001840"],
  ["GEOMETRYCOLLECTION Z(POINT Z(1 2 3),LINESTRING Z(4 5 6,7 8 9))", 4326, "0x01070000a0e6100000020000000101000080000000000000f03f000000000000004000000000000008400102000080020000000000000000001040000000000000144000000000000018400000000000001c4000000000000020400000000000002240"],
  ["MULTILINESTRING((1 2,3 4),(5 6,7 8))", 4326, "0x0105000020e610000002000000010200000002000000000000000000f03f000000000000004000000000000008400000000000001040010200000002000000000000000000144000000000000018400000000000001c400000000000002040"],
  ["MULTIPOLYGON(((0 0,1 0,1 1,0 0)))", 4326, "0x0106000020e6100000010000000103000000010000000400000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000f03f00000000000000000000000000000000"],
  ["GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(3 4,5 6))", 4326, "0x0107000020e6100000020000000101000000000000000000f03f00000000000000400102000000020000000000000000000840000000000000104000000000000014400000000000001840"],
  ["LINESTRING EMPTY", 4326, "0x0102000020e610000000000000"],
  ["POLYGON EMPTY", 4326, "0x0103000020e610000000000000"],
  ["GEOMETRYCOLLECTION EMPTY", 4326, "0x0107000020e610000000000000"],
  ["POINT(12957254.77 4852618.61)", 3857, "0x0101000020110f00000ad7a3d8c8b66841713d0aa7e2825241"],
];

describe("buildGeometryRawView", () => {
  it.each(FIXTURES)("encodes %s with SRID %s byte-for-byte", (wkt, srid, expectedHex) => {
    const raw = buildGeometryRawView(wkt, srid);
    expect(raw).not.toBeNull();
    expect(raw!.hex).toBe(expectedHex);
    expect(raw!.srid).toBe(srid);
    expect(raw!.ewkt).toBe(`SRID=${srid};${wkt}`);
  });

  it("omits the SRID flag when the SRID is unknown", () => {
    const raw = buildGeometryRawView("POINT(1 2)");
    expect(raw?.hex).toBe("0x0101000000000000000000f03f0000000000000040");
    expect(raw?.ewkt).toBe("POINT(1 2)");
    expect(raw?.srid).toBeNull();
  });

  it("accepts EWKT input and prefers the explicit per-cell SRID", () => {
    const raw = buildGeometryRawView("SRID=4326;POINT(1 2)", 3857);
    expect(raw?.srid).toBe(3857);
    expect(raw?.ewkt).toBe("SRID=3857;POINT(1 2)");
  });

  it("passes through hex fallbacks unchanged", () => {
    const raw = buildGeometryRawView("0x0101000000", 4326);
    expect(raw).toMatchObject({ hex: "0x0101000000", rawOnly: true, srid: 4326 });
  });

  it("normalizes multi-point and multi-line inner groups", () => {
    // YashanDB's decoder emits parenthesized coordinates; the non-parenthesized
    // OGC form used by other clients must encode identically.
    expect(buildGeometryRawView("MULTIPOINT(1 2,3 4)", 4326)?.hex).toBe(buildGeometryRawView("MULTIPOINT((1 2),(3 4))", 4326)?.hex);
  });

  it("rejects non-geometry text", () => {
    expect(buildGeometryRawView("MDSYS.ST_GEOMETRY(0x0102, 0x03)", 4326)).toBeNull();
    expect(buildGeometryRawView("not a geometry", 4326)).toBeNull();
    expect(buildGeometryRawView(null, 4326)).toBeNull();
  });

  it("guards against oversized WKT", () => {
    const raw = buildGeometryRawView(`POINT(${"1".repeat(1_000_001)} 2)`, 4326);
    expect(raw).toMatchObject({ hex: null, tooLarge: true });
  });
});

// HEAD bytes captured from com.yashandb.udt.YasStruct.getAttributes()[0] on
// YashanDB 23.4. The 24-byte layout is version/type/dims/pad/srid/bbox(float32).
const YASHAN_HEAD_FIXTURES: Array<[string, number | null, string]> = [
  ["POINT(116.397 39.908)", 4326, "0x00011400e610000043cbe84244cbe842caa11f42cba11f42"],
  ["POINT Z(116.397 39.908 50)", 4326, "0x00011500e610000043cbe84244cbe842caa11f42cba11f42"],
  ["LINESTRING(1 2,3 4,5 6)", 4326, "0x00021400e61000000000803f0000a040000000400000c040"],
  ["POLYGON((0 0,1 0,1 1,0 1,0 0))", 4326, "0x00031400e6100000000000000000803f000000000000803f"],
  ["MULTIPOINT((1 2),(3 4))", 4326, "0x00111400e61000000000803f000040400000004000008040"],
  ["LINESTRING Z(1 2 3,4 5 6)", 4326, "0x00021500e61000000000803f00008040000000400000a040"],
  ["MULTIPOINT Z((1 2 3),(4 5 6))", 4326, "0x00111500e61000000000803f00008040000000400000a040"],
  ["GEOMETRYCOLLECTION Z(POINT Z(1 2 3),LINESTRING Z(4 5 6,7 8 9))", 4326, "0x00141500e61000000000803f0000e0400000004000000041"],
  ["MULTILINESTRING((1 2,3 4),(5 6,7 8))", 4326, "0x00121400e61000000000803f0000e0400000004000000041"],
  ["MULTIPOLYGON(((0 0,1 0,1 1,0 0)))", 4326, "0x00131400e6100000000000000000803f000000000000803f"],
  ["GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(3 4,5 6))", 4326, "0x00141400e61000000000803f0000a040000000400000c040"],
  ["POINT EMPTY", 4326, "0x00011000e6100000"],
  ["LINESTRING EMPTY", 4326, "0x00021000e6100000"],
  ["POLYGON EMPTY", 4326, "0x00031000e6100000"],
  ["MULTIPOINT EMPTY", 4326, "0x00111000e6100000"],
  ["MULTILINESTRING EMPTY", 4326, "0x00121000e6100000"],
  ["MULTIPOLYGON EMPTY", 4326, "0x00131000e6100000"],
  ["GEOMETRYCOLLECTION EMPTY", 4326, "0x00141000e6100000"],
  ["POINT(12957254.77 4852618.61)", 3857, "0x00011400110f000046b6454b47b6454b1517944a1617944a"],
  ["POINT(-58.2687 29.149)", 4326, "0x00011400e6100000271369c2261369c22631e9412731e941"],
  ["POINT(-0.0001 -0.0002)", 4326, "0x00011400e610000018b7d1b817b7d1b818b751b917b751b9"],
  ["LINESTRING(-1 -2,3 4)", 4326, "0x00021400e6100000000080bf00004040000000c000008040"],
  ["POINT(1 2)", null, "0x00011400000000000000803f0000803f0000004000000040"],
];

describe("buildYashanRawStruct", () => {
  it.each(YASHAN_HEAD_FIXTURES)("rebuilds the HEAD for %s", (wkt, srid, expectedHead) => {
    const raw = buildYashanRawStruct(wkt, srid);
    expect(raw).not.toBeNull();
    expect(raw!.headHex).toBe(expectedHead);
    expect(raw!.ewkbHex).toBe(buildGeometryRawView(wkt, srid)?.hex);
    expect(raw!.text).toBe(`MDSYS.ST_GEOMETRY(${expectedHead}, ${raw!.ewkbHex})`);
  });

  it("matches the exact original text for a YashanDB point", () => {
    const raw = buildYashanRawStruct("POINT(116.397 39.908)", 4326);
    expect(raw?.text).toBe("MDSYS.ST_GEOMETRY(0x00011400e610000043cbe84244cbe842caa11f42cba11f42, 0x0101000020e6100000c520b07268195d404e62105839f44340)");
  });

  it("uses the 8-byte EMPTY header without a bbox", () => {
    const raw = buildYashanRawStruct("POINT EMPTY", 4326);
    expect(raw?.headHex).toBe("0x00011000e6100000");
    expect(raw?.headHex.length).toBe(18); // 0x + 16 hex chars
    expect(raw?.text).toBe("MDSYS.ST_GEOMETRY(0x00011000e6100000, 0x0101000020e6100000000000000000f87f000000000000f87f)");
  });

  it("rejects M/ZM values that YashanDB would coerce and hex fallbacks", () => {
    expect(buildYashanRawStruct("POINT M(1 2 3)", 4326)).toBeNull();
    expect(buildYashanRawStruct("POINT ZM(1 2 3 4)", 4326)).toBeNull();
    expect(buildYashanRawStruct("0x0101000000", 4326)).toBeNull();
  });
});

// YashanDB keeps Z on EMPTY point/line/polygon but drops it for EMPTY
// multi/collection values; captured from the live driver.
const YASHAN_EMPTY_Z_FIXTURES: Array<[string, string, string]> = [
  ["POINT Z EMPTY", "0x00011100e6100000", "0x01010000a0e6100000000000000000f87f000000000000f87f000000000000f87f"],
  ["LINESTRING Z EMPTY", "0x00021100e6100000", "0x01020000a0e610000000000000"],
  ["POLYGON Z EMPTY", "0x00031100e6100000", "0x01030000a0e610000000000000"],
  ["MULTIPOINT Z EMPTY", "0x00111000e6100000", "0x0104000020e610000000000000"],
  ["GEOMETRYCOLLECTION Z EMPTY", "0x00141000e6100000", "0x0107000020e610000000000000"],
];

describe("buildYashanRawStruct EMPTY Z normalization", () => {
  it.each(YASHAN_EMPTY_Z_FIXTURES)("matches YashanDB for %s", (wkt, expectedHead, expectedEwkb) => {
    const raw = buildYashanRawStruct(wkt, 4326);
    expect(raw?.headHex).toBe(expectedHead);
    expect(raw?.ewkbHex).toBe(expectedEwkb);
  });
});
