/**
 * Client-side WKT → EWKB encoder used by the cell detail "raw geometry" view.
 *
 * The YashanDB agent decodes `MDSYS.ST_GEOMETRY` values to WKT so the grid and
 * map preview can work with them, which means the original EWKB payload is not
 * carried in query results. This encoder recreates the same OGC EWKB bytes on
 * demand from the displayed WKT plus the per-cell SRID, without adding another
 * parallel value matrix to the result protocol.
 */

export interface GeometryRawView {
  /** EWKT (`SRID=4326;POINT(...)`) when WKT was decoded, or the raw input for hex fallbacks. */
  ewkt: string;
  /** `0x`-prefixed lowercase EWKB, or null when the value is too large to encode. */
  hex: string | null;
  srid: number | null;
  /** True when the input was already a hex fallback rather than WKT. */
  rawOnly: boolean;
  /** True when the WKT exceeded the encoder's size guard. */
  tooLarge: boolean;
}

export interface YashanRawStruct {
  /** `0x`-prefixed 24-byte HEAD (or the 8-byte empty header). */
  headHex: string;
  /** `0x`-prefixed EWKB payload. */
  ewkbHex: string;
  /** The exact `MDSYS.ST_GEOMETRY(HEAD, EWKB)` text the JDBC driver exposes. */
  text: string;
  srid: number | null;
}

type GeometryKind = "point" | "line" | "polygon" | "multipoint" | "multiline" | "multipolygon" | "collection";

interface Dimensions {
  z: boolean;
  m: boolean;
}

interface GeometryNode {
  kind: GeometryKind;
  dims: Dimensions;
  empty: boolean;
  point?: number[];
  line?: number[][];
  polygon?: number[][][];
  multipoint?: number[][];
  multiline?: number[][][];
  multipolygon?: number[][][][];
  collection?: GeometryNode[];
}

const MAX_WKT_LENGTH = 1_000_000;
const BASE_TYPE: Record<GeometryKind, number> = {
  point: 1,
  line: 2,
  polygon: 3,
  multipoint: 4,
  multiline: 5,
  multipolygon: 6,
  collection: 7,
};
const KIND_BY_WKT: Record<string, GeometryKind> = {
  POINT: "point",
  LINESTRING: "line",
  POLYGON: "polygon",
  MULTIPOINT: "multipoint",
  MULTILINESTRING: "multiline",
  MULTIPOLYGON: "multipolygon",
  GEOMETRYCOLLECTION: "collection",
};

/**
 * YashanDB's HEAD type byte. The high nibble marks the collection/multi
 * variants (0x10), matching the values observed from
 * `com.yashandb.udt.YasStruct.getAttributes()[0]` on 23.4.
 */
const YASHAN_HEAD_TYPE: Record<GeometryKind, number> = {
  point: 0x01,
  line: 0x02,
  polygon: 0x03,
  multipoint: 0x11,
  multiline: 0x12,
  multipolygon: 0x13,
  collection: 0x14,
};

type Token = { kind: "word" | "number" | "lparen" | "rparen" | "comma"; text: string; value?: number };

/** Build the raw geometry view, or null when the value is not WKT/hex. */
export function buildGeometryRawView(value: unknown, srid?: number | null): GeometryRawView | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("0x")) {
    return { ewkt: trimmed, hex: trimmed, srid: normalizeSrid(srid), rawOnly: true, tooLarge: false };
  }

  const ewktPrefix = trimmed.match(/^SRID\s*=\s*(-?\d+)\s*;\s*/i);
  const declaredSrid = ewktPrefix ? normalizeSrid(Number(ewktPrefix[1])) : null;
  const wkt = ewktPrefix ? trimmed.slice(ewktPrefix[0].length) : trimmed;
  const effectiveSrid = normalizeSrid(srid) ?? declaredSrid;
  const ewkt = effectiveSrid == null ? wkt : `SRID=${effectiveSrid};${wkt}`;

  if (wkt.length > MAX_WKT_LENGTH) {
    return { ewkt, hex: null, srid: effectiveSrid, rawOnly: false, tooLarge: true };
  }

  const node = parseWkt(wkt);
  if (!node) return null;
  const bytes = encodeGeometry(node, effectiveSrid);
  return { ewkt, hex: bytesToHex(bytes), srid: effectiveSrid, rawOnly: false, tooLarge: false };
}

/**
 * Rebuild the original `MDSYS.ST_GEOMETRY(0xHEAD, 0xEWKB)` text YashanDB's
 * JDBC driver exposes through `Struct.getAttributes()`.
 *
 * The 24-byte HEAD layout is `version(1) type(1) dims(1) pad(1) srid(4)
 * bbox(4 x float32: minX, maxX, minY, maxY)`; EMPTY geometries use the 8-byte
 * header without a bbox and dims byte 0x10. Every byte here was verified
 * against a live YashanDB 23.4 Struct for all OGC types and EMPTY variants.
 */
export function buildYashanRawStruct(value: unknown, srid?: number | null): YashanRawStruct | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0x")) return null;

  const ewktPrefix = trimmed.match(/^SRID\s*=\s*(-?\d+)\s*;\s*/i);
  const declaredSrid = ewktPrefix ? normalizeSrid(Number(ewktPrefix[1])) : null;
  const wkt = ewktPrefix ? trimmed.slice(ewktPrefix[0].length) : trimmed;
  const effectiveSrid = normalizeSrid(srid) ?? declaredSrid;
  if (wkt.length > MAX_WKT_LENGTH) return null;

  const node = parseWkt(wkt);
  // YashanDB supports 2D/3D only; M/ZM values are coerced to Z by the server.
  if (!node || node.dims.m) return null;

  // YashanDB drops Z from EMPTY multi/collection geometries (but keeps it for
  // EMPTY point/line/polygon), so mirror that before encoding HEAD + EWKB.
  const rawNode = node.empty && node.dims.z && !["point", "line", "polygon"].includes(node.kind) ? { ...node, dims: { z: false, m: false } } : node;

  const head = encodeYashanHead(rawNode, effectiveSrid);
  const ewkb = encodeGeometry(rawNode, effectiveSrid);
  const headHex = bytesToHex(head);
  const ewkbHex = bytesToHex(ewkb);
  return {
    headHex,
    ewkbHex,
    srid: effectiveSrid,
    text: `MDSYS.ST_GEOMETRY(${headHex}, ${ewkbHex})`,
  };
}

function encodeYashanHead(node: GeometryNode, srid: number | null): Uint8Array {
  const writer = new ByteWriter();
  writer.u8(0);
  writer.u8(YASHAN_HEAD_TYPE[node.kind]);
  const dimCode = node.empty ? (node.dims.z && (node.kind === "point" || node.kind === "line" || node.kind === "polygon") ? 0x11 : 0x10) : node.dims.z ? 0x15 : 0x14;
  writer.u8(dimCode);
  writer.u8(0);
  writer.u32(srid ?? 0);
  if (!node.empty) {
    const bbox = geometryBbox(node);
    writer.f32Floor(bbox.minX);
    writer.f32Ceil(bbox.maxX);
    writer.f32Floor(bbox.minY);
    writer.f32Ceil(bbox.maxY);
  }
  return writer.finish();
}

function geometryBbox(node: GeometryNode): { minX: number; maxX: number; minY: number; maxY: number } {
  const coordinates: number[][] = [];
  collectCoordinates(node, coordinates);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const coordinate of coordinates) {
    const x = coordinate[0] ?? 0;
    const y = coordinate[1] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

function collectCoordinates(node: GeometryNode, out: number[][]): void {
  if (node.point) out.push(node.point);
  if (node.line) for (const coordinate of node.line) out.push(coordinate);
  if (node.polygon) for (const ring of node.polygon) for (const coordinate of ring) out.push(coordinate);
  if (node.multipoint) for (const coordinate of node.multipoint) out.push(coordinate);
  if (node.multiline) for (const line of node.multiline) for (const coordinate of line) out.push(coordinate);
  if (node.multipolygon) {
    for (const polygon of node.multipolygon) for (const ring of polygon) for (const coordinate of ring) out.push(coordinate);
  }
  if (node.collection) for (const child of node.collection) collectCoordinates(child, out);
}

function normalizeSrid(value: number | null | undefined): number | null {
  return value != null && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff ? value : null;
}

// ── WKT parsing ───────────────────────────────────────────────────────────

function parseWkt(wkt: string): GeometryNode | null {
  const tokens = tokenize(wkt);
  if (tokens.length === 0) return null;
  try {
    const parsed = parseGeometry(tokens, 0);
    if (parsed.next !== tokens.length) return null;
    return parsed.node;
  } catch {
    return null;
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", text: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", text: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma", text: ch });
      i++;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === "-" || ch === "+" || ch === ".") {
      const match = input.slice(i).match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (match) {
        const text = match[0];
        tokens.push({ kind: "number", text, value: Number(text) });
        i += text.length;
        continue;
      }
    }
    const word = input.slice(i).match(/^[A-Za-z_]+/);
    if (word) {
      tokens.push({ kind: "word", text: word[0] });
      i += word[0].length;
      continue;
    }
    // Unknown characters are ignored, matching the permissive display parser.
    i++;
  }
  return tokens;
}

function parseGeometry(tokens: Token[], start: number): { node: GeometryNode; next: number } {
  let pos = start;
  const typeToken = tokens[pos];
  if (typeToken?.kind !== "word") throw new Error("expected geometry type");
  const kind = KIND_BY_WKT[typeToken.text.toUpperCase()];
  if (!kind) throw new Error(`unsupported geometry type: ${typeToken.text}`);
  pos++;

  let dims: Dimensions = { z: false, m: false };
  let explicitDims = false;
  const dimToken = tokens[pos];
  if (dimToken?.kind === "word" && /^(?:Z|M|ZM)$/i.test(dimToken.text)) {
    const suffix = dimToken.text.toUpperCase();
    dims = { z: suffix.includes("Z"), m: suffix.includes("M") };
    explicitDims = true;
    pos++;
  }

  if (tokens[pos]?.kind === "word" && tokens[pos].text.toUpperCase() === "EMPTY") {
    return { node: { kind, dims, empty: true }, next: pos + 1 };
  }

  expectToken(tokens, pos, "lparen");
  pos++;

  let node: GeometryNode;
  switch (kind) {
    case "point": {
      const point = readCoordinate(tokens, pos);
      pos = point.next;
      node = { kind, dims: explicitDims ? dims : inferDims([point.values]), empty: false, point: point.values };
      break;
    }
    case "line": {
      const sequence = readCoordinateSequence(tokens, pos);
      pos = sequence.next;
      node = {
        kind,
        dims: explicitDims ? dims : inferDims(sequence.coords),
        empty: false,
        line: sequence.coords,
      };
      break;
    }
    case "polygon": {
      const rings = readRingGroups(tokens, pos);
      pos = rings.next;
      node = {
        kind,
        dims: explicitDims ? dims : inferDims(rings.rings.flat()),
        empty: false,
        polygon: rings.rings,
      };
      break;
    }
    case "multipoint": {
      const points = readMultiPoints(tokens, pos);
      pos = points.next;
      node = {
        kind,
        dims: explicitDims ? dims : inferDims(points.points),
        empty: false,
        multipoint: points.points,
      };
      break;
    }
    case "multiline": {
      const lines = readMultiLines(tokens, pos);
      pos = lines.next;
      node = {
        kind,
        dims: explicitDims ? dims : inferDims(lines.lines.flat()),
        empty: false,
        multiline: lines.lines,
      };
      break;
    }
    case "multipolygon": {
      const polygons = readMultiPolygons(tokens, pos);
      pos = polygons.next;
      node = {
        kind,
        dims: explicitDims ? dims : inferDims(polygons.polygons.flat(2)),
        empty: false,
        multipolygon: polygons.polygons,
      };
      break;
    }
    case "collection": {
      const children: GeometryNode[] = [];
      let childPos = pos;
      if (tokens[childPos]?.kind !== "rparen") {
        while (true) {
          const child = parseGeometry(tokens, childPos);
          children.push(child.node);
          childPos = child.next;
          if (tokens[childPos]?.kind === "comma") {
            childPos++;
            continue;
          }
          break;
        }
      }
      pos = childPos;
      node = {
        kind,
        dims: explicitDims ? dims : (children[0]?.dims ?? { z: false, m: false }),
        empty: false,
        collection: children,
      };
      break;
    }
  }

  expectToken(tokens, pos, "rparen");
  pos++;
  validateNode(node);
  return { node, next: pos };
}

function readCoordinate(tokens: Token[], start: number): { values: number[]; next: number } {
  const values: number[] = [];
  let pos = start;
  while (tokens[pos]?.kind === "number") {
    values.push(tokens[pos].value!);
    pos++;
  }
  if (values.length < 2 || values.length > 4) throw new Error("invalid coordinate");
  return { values, next: pos };
}

function readCoordinateSequence(tokens: Token[], start: number): { coords: number[][]; next: number } {
  const coords: number[][] = [];
  let pos = start;
  while (true) {
    const coordinate = readCoordinate(tokens, pos);
    coords.push(coordinate.values);
    pos = coordinate.next;
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    break;
  }
  return { coords, next: pos };
}

function readRingGroups(tokens: Token[], start: number): { rings: number[][][]; next: number } {
  const rings: number[][][] = [];
  let pos = start;
  while (true) {
    expectToken(tokens, pos, "lparen");
    const ring = readCoordinateSequence(tokens, pos + 1);
    expectToken(tokens, ring.next, "rparen");
    rings.push(ring.coords);
    pos = ring.next + 1;
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    break;
  }
  return { rings, next: pos };
}

function readMultiPoints(tokens: Token[], start: number): { points: number[][]; next: number } {
  const points: number[][] = [];
  let pos = start;
  while (true) {
    if (tokens[pos]?.kind === "lparen") {
      const point = readCoordinate(tokens, pos + 1);
      expectToken(tokens, point.next, "rparen");
      points.push(point.values);
      pos = point.next + 1;
    } else {
      const point = readCoordinate(tokens, pos);
      points.push(point.values);
      pos = point.next;
    }
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    break;
  }
  return { points, next: pos };
}

function readMultiLines(tokens: Token[], start: number): { lines: number[][][]; next: number } {
  const lines: number[][][] = [];
  let pos = start;
  while (true) {
    expectToken(tokens, pos, "lparen");
    const line = readCoordinateSequence(tokens, pos + 1);
    expectToken(tokens, line.next, "rparen");
    lines.push(line.coords);
    pos = line.next + 1;
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    break;
  }
  return { lines, next: pos };
}

function readMultiPolygons(tokens: Token[], start: number): { polygons: number[][][][]; next: number } {
  const polygons: number[][][][] = [];
  let pos = start;
  while (true) {
    expectToken(tokens, pos, "lparen");
    const polygon = readRingGroups(tokens, pos + 1);
    expectToken(tokens, polygon.next, "rparen");
    polygons.push(polygon.rings);
    pos = polygon.next + 1;
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    break;
  }
  return { polygons, next: pos };
}

function expectToken(tokens: Token[], pos: number, kind: Token["kind"]): void {
  if (tokens[pos]?.kind !== kind) throw new Error(`expected ${kind}`);
}

function inferDims(coords: number[][]): Dimensions {
  const length = coords[0]?.length ?? 2;
  return { z: length >= 3, m: length >= 4 };
}

function coordinateLength(dims: Dimensions): number {
  return 2 + (dims.z ? 1 : 0) + (dims.m ? 1 : 0);
}

function validateNode(node: GeometryNode): void {
  const expected = coordinateLength(node.dims);
  const check = (coords: number[][]): void => {
    for (const coordinate of coords) {
      if (coordinate.length !== expected) throw new Error("inconsistent coordinate dimensions");
    }
  };
  if (node.point) check([node.point]);
  if (node.line) check(node.line);
  if (node.polygon) for (const ring of node.polygon) check(ring);
  if (node.multipoint) check(node.multipoint);
  if (node.multiline) for (const line of node.multiline) check(line);
  if (node.multipolygon) for (const polygon of node.multipolygon) for (const ring of polygon) check(ring);
  if (node.collection) for (const child of node.collection) validateNode(child);
}

// ── EWKB encoding ─────────────────────────────────────────────────────────

function encodeGeometry(node: GeometryNode, srid: number | null): Uint8Array {
  const writer = new ByteWriter();
  writeGeometry(writer, node, srid, true);
  return writer.finish();
}

function writeGeometry(writer: ByteWriter, node: GeometryNode, srid: number | null, includeSrid: boolean): void {
  writer.u8(1); // little-endian
  let typeWord = BASE_TYPE[node.kind];
  if (node.dims.z) typeWord |= 0x8000_0000;
  if (node.dims.m) typeWord |= 0x4000_0000;
  const withSrid = includeSrid && srid != null;
  if (withSrid) typeWord |= 0x2000_0000;
  writer.u32(typeWord);
  if (withSrid) writer.u32(srid);

  const empty = node.empty;
  switch (node.kind) {
    case "point":
      if (empty) {
        for (let i = 0; i < coordinateLength(node.dims); i++) writer.f64(Number.NaN);
      } else {
        writeCoordinate(writer, node.point!);
      }
      break;
    case "line":
      writer.u32(empty ? 0 : node.line!.length);
      if (!empty) for (const coordinate of node.line!) writeCoordinate(writer, coordinate);
      break;
    case "polygon":
      writer.u32(empty ? 0 : node.polygon!.length);
      if (!empty) {
        for (const ring of node.polygon!) {
          writer.u32(ring.length);
          for (const coordinate of ring) writeCoordinate(writer, coordinate);
        }
      }
      break;
    case "multipoint":
      writer.u32(empty ? 0 : node.multipoint!.length);
      if (!empty) {
        for (const point of node.multipoint!) {
          writeGeometry(writer, { kind: "point", dims: node.dims, empty: false, point }, null, false);
        }
      }
      break;
    case "multiline":
      writer.u32(empty ? 0 : node.multiline!.length);
      if (!empty) {
        for (const line of node.multiline!) {
          writeGeometry(writer, { kind: "line", dims: node.dims, empty: false, line }, null, false);
        }
      }
      break;
    case "multipolygon":
      writer.u32(empty ? 0 : node.multipolygon!.length);
      if (!empty) {
        for (const polygon of node.multipolygon!) {
          writeGeometry(writer, { kind: "polygon", dims: node.dims, empty: false, polygon }, null, false);
        }
      }
      break;
    case "collection":
      writer.u32(empty ? 0 : node.collection!.length);
      if (!empty) for (const child of node.collection!) writeGeometry(writer, child, null, false);
      break;
  }
}

function writeCoordinate(writer: ByteWriter, coordinate: number[]): void {
  for (const value of coordinate) writer.f64(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "0x";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function floorFloat32(value: number): number {
  const nearest = Math.fround(value);
  if (!Number.isFinite(nearest) || nearest <= value) return nearest;
  return adjacentFloat32(nearest, -1);
}

function ceilFloat32(value: number): number {
  const nearest = Math.fround(value);
  if (!Number.isFinite(nearest) || nearest >= value) return nearest;
  return adjacentFloat32(nearest, 1);
}

/** Move one representable float32 toward -Infinity (direction = -1) or +Infinity (direction = 1). */
function adjacentFloat32(value: number, direction: -1 | 1): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  if (bits === 0) {
    // +0 → smallest subnormal in the requested direction.
    view.setUint32(0, direction > 0 ? 1 : 0x8000_0001, true);
    return view.getFloat32(0, true);
  }
  const negative = (bits & 0x8000_0000) !== 0;
  // For positive numbers higher bits are larger; for negative numbers the
  // unsigned representation grows as the value becomes more negative.
  const step = negative ? -direction : direction;
  view.setUint32(0, (bits + (step > 0 ? 1 : -1)) >>> 0, true);
  return view.getFloat32(0, true);
}

class ByteWriter {
  private bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u32(value: number): void {
    const unsigned = value >>> 0;
    this.bytes.push(unsigned & 0xff, (unsigned >>> 8) & 0xff, (unsigned >>> 16) & 0xff, (unsigned >>> 24) & 0xff);
  }

  f64(value: number): void {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, true);
    const view = new Uint8Array(buffer);
    for (const byte of view) this.bytes.push(byte);
  }

  f32(value: number): void {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    const view = new Uint8Array(buffer);
    for (const byte of view) this.bytes.push(byte);
  }

  /**
   * YashanDB's HEAD bbox is produced by C-style double→float casts: the min
   * corners round toward -inf and the max corners toward +inf, so the box
   * always contains the geometry.
   */
  f32Floor(value: number): void {
    this.f32(floorFloat32(value));
  }

  f32Ceil(value: number): void {
    this.f32(ceilFloat32(value));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
