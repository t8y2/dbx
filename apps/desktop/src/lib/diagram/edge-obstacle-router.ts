import { Position } from "@vue-flow/core";
import { EDGE_ROUTE_OFFSET } from "./diagram-constants";

export type Point = { x: number; y: number };

export type ObstacleRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "table" | "layer";
  /** For layers: tables contained (used to skip same-layer fill) */
  tableNames?: string[];
};

export type RouteInput = {
  source: Point;
  target: Point;
  sourcePosition: Position;
  targetPosition: Position;
  obstacles: ObstacleRect[];
  /** Endpoint table ids to ignore as obstacles */
  endpointIds: [string, string];
  offset?: number;
};

const AXIS_EPS = 0.5;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= AXIS_EPS;
}

function inflate(rect: ObstacleRect, pad: number): ObstacleRect {
  return {
    ...rect,
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

function segmentIntersectsRect(a: Point, b: Point, rect: ObstacleRect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;

  if (maxX < rect.x || minX > rx2 || maxY < rect.y || minY > ry2) return false;

  if (nearlyEqual(a.x, b.x)) {
    const x = a.x;
    return x >= rect.x && x <= rx2 && maxY >= rect.y && minY <= ry2;
  }
  if (nearlyEqual(a.y, b.y)) {
    const y = a.y;
    return y >= rect.y && y <= ry2 && maxX >= rect.x && minX <= rx2;
  }
  return true;
}

export function pathHitsObstacles(points: Point[], obstacles: ObstacleRect[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    for (const rect of obstacles) {
      if (segmentIntersectsRect(points[i], points[i + 1], rect)) return true;
    }
  }
  return false;
}

function relevantObstacles(input: RouteInput, pad: number): ObstacleRect[] {
  const [srcId, tgtId] = input.endpointIds;
  return input.obstacles
    .filter((o) => {
      if (o.kind === "table") {
        return o.id !== srcId && o.id !== tgtId;
      }
      const names = o.tableNames || [];
      if (names.includes(srcId) || names.includes(tgtId)) return false;
      return true;
    })
    .map((o) => inflate(o, pad));
}

/** Table rects for the edge endpoints (source/target), optionally inflated. */
export function endpointRectsFromObstacles(obstacles: ObstacleRect[], endpointIds: [string, string], pad = 0): ObstacleRect[] {
  const [srcId, tgtId] = endpointIds;
  return obstacles.filter((o) => o.kind === "table" && (o.id === srcId || o.id === tgtId)).map((o) => (pad > 0 ? inflate(o, pad) : { ...o }));
}

export function stubOut(point: Point, position: Position, offset: number): Point {
  if (position === Position.Left) return { x: point.x - offset, y: point.y };
  if (position === Position.Top) return { x: point.x, y: point.y - offset };
  if (position === Position.Bottom) return { x: point.x, y: point.y + offset };
  return { x: point.x + offset, y: point.y };
}

/** Point just outside the target handle before the final inbound stub. */
export function stubIn(point: Point, position: Position, offset: number): Point {
  if (position === Position.Right) return { x: point.x + offset, y: point.y };
  if (position === Position.Top) return { x: point.x, y: point.y - offset };
  if (position === Position.Bottom) return { x: point.x, y: point.y + offset };
  return { x: point.x - offset, y: point.y };
}

function pointOnRectBorder(p: Point, rect: ObstacleRect): boolean {
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;
  const onVertical = (nearlyEqual(p.x, rect.x) || nearlyEqual(p.x, rx2)) && p.y >= rect.y - AXIS_EPS && p.y <= ry2 + AXIS_EPS;
  const onHorizontal = (nearlyEqual(p.y, rect.y) || nearlyEqual(p.y, ry2)) && p.x >= rect.x - AXIS_EPS && p.x <= rx2 + AXIS_EPS;
  return onVertical || onHorizontal;
}

/**
 * True when a segment runs along/through an endpoint table beyond a short handle stub.
 * Short outward/inward stubs (length ≤ stubLen) that touch the border are allowed.
 */
export function pathSkimsEndpoints(points: Point[], endpointRects: ObstacleRect[], stubLen = EDGE_ROUTE_OFFSET): boolean {
  if (endpointRects.length === 0 || points.length < 2) return false;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    for (const rect of endpointRects) {
      if (!segmentIntersectsRect(a, b, rect)) continue;
      const stubOk = segLen <= stubLen + AXIS_EPS && (pointOnRectBorder(a, rect) || pointOnRectBorder(b, rect));
      if (stubOk) continue;
      return true;
    }
  }
  return false;
}

/**
 * Build candidate orthogonal polylines with exit/entry stubs; return the shortest that
 * clears non-endpoint obstacles and does not skim endpoint tables on middle segments.
 */
export function routeOrthogonalAroundObstacles(input: RouteInput): Point[] | null {
  const offset = input.offset ?? EDGE_ROUTE_OFFSET;
  const obstacles = relevantObstacles(input, 6);
  const endpoints = endpointRectsFromObstacles(input.obstacles, input.endpointIds, 0);
  const { source: s, target: t } = input;
  const so = stubOut(s, input.sourcePosition, offset);
  const si = stubIn(t, input.targetPosition, offset);

  // Corridors from stubOut → stubIn (handles attached outside)
  const corridors: Point[][] = [
    [so, { x: si.x, y: so.y }, si],
    [so, { x: so.x, y: si.y }, si],
    [so, { x: so.x + offset, y: so.y }, { x: so.x + offset, y: si.y }, si],
    [so, { x: so.x - offset, y: so.y }, { x: so.x - offset, y: si.y }, si],
    [so, { x: so.x, y: so.y + offset }, { x: si.x, y: so.y + offset }, si],
    [so, { x: so.x, y: so.y - offset }, { x: si.x, y: so.y - offset }, si],
    [so, { x: si.x + offset, y: so.y }, { x: si.x + offset, y: si.y }, si],
    [so, { x: si.x - offset, y: so.y }, { x: si.x - offset, y: si.y }, si],
    [so, { x: so.x, y: Math.min(so.y, si.y) - offset }, { x: si.x, y: Math.min(so.y, si.y) - offset }, si],
    [so, { x: so.x, y: Math.max(so.y, si.y) + offset }, { x: si.x, y: Math.max(so.y, si.y) + offset }, si],
    [so, { x: Math.min(so.x, si.x) - offset, y: so.y }, { x: Math.min(so.x, si.x) - offset, y: si.y }, si],
    [so, { x: Math.max(so.x, si.x) + offset, y: so.y }, { x: Math.max(so.x, si.x) + offset, y: si.y }, si],
  ];

  let best: Point[] | null = null;
  let bestLen = Infinity;
  for (const corridor of corridors) {
    const cleaned = collapseColinearPoints(dedupePoints([s, ...corridor, t]));
    if (cleaned.length < 2) continue;
    if (pathHitsObstacles(cleaned, obstacles)) continue;
    if (pathSkimsEndpoints(cleaned, endpoints, offset)) continue;
    const len = polylineLength(cleaned);
    if (len < bestLen) {
      bestLen = len;
      best = cleaned;
    }
  }

  return best;
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function dedupePoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || !nearlyEqual(last.x, p.x) || !nearlyEqual(last.y, p.y)) {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/** Collapse consecutive collinear points on axis-aligned polylines. */
export function collapseColinearPoints(points: Point[]): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const colinearH = nearlyEqual(prev.y, cur.y) && nearlyEqual(cur.y, next.y);
    const colinearV = nearlyEqual(prev.x, cur.x) && nearlyEqual(cur.x, next.x);
    if (colinearH || colinearV) continue;
    out.push({ ...cur });
  }
  out.push({ ...points[points.length - 1] });
  return dedupePoints(out);
}

function isOrthogonalPolyline(points: Point[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!nearlyEqual(a.x, b.x) && !nearlyEqual(a.y, b.y)) return false;
  }
  return true;
}

/** Orthogonal elbow from a → b (try both corners; prefer shorter). */
function orthogonalConnect(a: Point, b: Point): Point[] {
  if (nearlyEqual(a.x, b.x) || nearlyEqual(a.y, b.y)) return [a, b];
  const viaH: Point[] = [a, { x: b.x, y: a.y }, b];
  const viaV: Point[] = [a, { x: a.x, y: b.y }, b];
  const len = (pts: Point[]) => pts.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)), 0);
  return len(viaH) <= len(viaV) ? viaH : viaV;
}

/**
 * Infer Vue Flow handle ids from ELK waypoint exit/entry directions.
 */
export function handlesFromWaypoints(waypoints: Point[]): { sourceHandle: string; targetHandle: string } | null {
  if (waypoints.length < 2) return null;
  const a = waypoints[0];
  const b = waypoints[1];
  const c = waypoints[waypoints.length - 2];
  const d = waypoints[waypoints.length - 1];

  const outDx = b.x - a.x;
  const outDy = b.y - a.y;
  let sourceHandle: string;
  if (Math.abs(outDx) >= Math.abs(outDy)) {
    sourceHandle = outDx >= 0 ? "right" : "left";
  } else {
    sourceHandle = outDy >= 0 ? "bottom" : "top";
  }

  const inDx = d.x - c.x;
  const inDy = d.y - c.y;
  let targetHandle: string;
  if (Math.abs(inDx) >= Math.abs(inDy)) {
    // Arriving with +dx means coming from the left → hit left side
    targetHandle = inDx >= 0 ? "left-target" : "right-target";
  } else {
    targetHandle = inDy >= 0 ? "top-target" : "bottom-target";
  }

  return { sourceHandle, targetHandle };
}

export type AlignWaypointsOptions = {
  obstacles?: ObstacleRect[];
  endpointIds?: [string, string];
};

/**
 * Attach live Vue Flow handle endpoints to ELK interior bends with orthogonal elbows.
 * Does NOT translate the whole polyline by source delta (that caused diagonals / V shapes).
 * Returns null when the result is unusable (caller should fall back to obstacle router).
 */
export function alignWaypointsToEndpoints(waypoints: Point[], sourceX: number, sourceY: number, targetX: number, targetY: number, options?: AlignWaypointsOptions): Point[] | null {
  if (waypoints.length < 2) return null;

  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const interior = waypoints.slice(1, -1);

  let merged: Point[];
  if (interior.length === 0) {
    merged = dedupePoints(orthogonalConnect(source, target));
  } else {
    const head = orthogonalConnect(source, interior[0]);
    const tail = orthogonalConnect(interior[interior.length - 1], target);
    merged = dedupePoints([...head.slice(0, -1), ...interior, ...tail.slice(1)]);
  }

  if (merged.length < 2 || !isOrthogonalPolyline(merged)) return null;

  const cleaned = collapseColinearPoints(merged);

  if (options?.obstacles?.length && options.endpointIds) {
    const obstacles = relevantObstacles(
      {
        source,
        target,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        obstacles: options.obstacles,
        endpointIds: options.endpointIds,
      },
      4,
    );
    if (pathHitsObstacles(cleaned, obstacles)) return null;
    const endpoints = endpointRectsFromObstacles(options.obstacles, options.endpointIds, 0);
    if (pathSkimsEndpoints(cleaned, endpoints, EDGE_ROUTE_OFFSET)) return null;
  }

  return cleaned;
}

export function pointsToSvgPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/**
 * Point at fraction `t` (0..1) along the polyline by arc length.
 * Out-of-range t is clamped.
 */
export function pointAlongPolyline(points: Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const clamped = Math.min(1, Math.max(0, t));
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    segs.push(d);
    total += d;
  }
  if (total === 0) return { ...points[0] };
  let remain = total * clamped;
  for (let i = 0; i < segs.length; i++) {
    if (remain <= segs[i]) {
      const ratio = segs[i] === 0 ? 0 : remain / segs[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * ratio,
        y: points[i].y + (points[i + 1].y - points[i].y) * ratio,
      };
    }
    remain -= segs[i];
  }
  return { ...points[points.length - 1] };
}

export function midpointAlongPolyline(points: Point[]): Point {
  return pointAlongPolyline(points, 0.5);
}
