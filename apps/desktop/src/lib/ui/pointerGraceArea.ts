export interface GraceAreaPoint {
  x: number;
  y: number;
}

/**
 * Ray-casting point-in-polygon test.
 *
 * This backs the "safe triangle" that keeps a submenu open while the pointer
 * travels from its trigger row to the submenu panel. The two are separate boxes
 * with a gap between them, so the pointer always leaves the trigger before it
 * reaches the submenu, and a diagonal move dips outside both. Treating the wedge
 * between them as part of the submenu stops the menu from closing mid-travel.
 */
export function isPointInPolygon(point: GraceAreaPoint, polygon: readonly GraceAreaPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const { x: xi, y: yi } = polygon[i]!;
    const { x: xj, y: yj } = polygon[j]!;
    // The edge (xi, yi)-(xj, yj) crosses the ray cast to the right from `point`
    // exactly when the point sits between the two y values and lies left of the
    // intersection x. The opposite-side test also guarantees `yj - yi` is
    // non-zero, so the division is safe.
    const crossesRay = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (crossesRay) inside = !inside;
  }
  return inside;
}

/** Null-safe wrapper: no area means the pointer is not inside it. */
export function isPointerInGraceArea(point: GraceAreaPoint, area: readonly GraceAreaPoint[] | null | undefined): boolean {
  if (!area) return false;
  return isPointInPolygon(point, area);
}

/**
 * Builds the safe triangle used while moving from a menu trigger into its
 * submenu: one vertex where the pointer left the trigger, and a base spanning
 * the full height of the submenu's edge that faces the trigger.
 *
 * A triangle rather than a polygon covering the whole submenu is deliberate.
 * The pointer has just left the trigger, so it always sits outside the submenu
 * horizontally, which keeps this a simple, convex shape. A shape that reached
 * across to the submenu's far edge could instead intersect itself when the
 * pointer lies between the submenu's two vertical edges, and the ray-casting
 * test would then give an answer that is not meaningful. The submenu's own
 * rectangle is covered by the ordinary hover check, so nothing is lost.
 */
export function buildSubmenuGraceArea(options: { origin: GraceAreaPoint; nearEdgeX: number; top: number; bottom: number }): GraceAreaPoint[] {
  const { origin, nearEdgeX, top, bottom } = options;
  return [
    { x: origin.x, y: origin.y },
    { x: nearEdgeX, y: top },
    { x: nearEdgeX, y: bottom },
  ];
}
