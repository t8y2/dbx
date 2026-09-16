export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Where a line from one card's centre towards another leaves the first card.
 *
 * Without this, edges terminate under the card and appear to sprout from a
 * table's middle. Scaling both axes and taking the smaller factor picks
 * whichever edge the ray actually reaches first.
 *
 * `half` is the card's HALF width and height, measured from its centre.
 */
export function clipToCard(from: Point, to: Point, half: Size): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    // Coincident centres would divide by zero and put NaN in the path data,
    // which renders as nothing rather than as an error.
    return { x: from.x, y: from.y };
  }
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : half.width / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : half.height / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
