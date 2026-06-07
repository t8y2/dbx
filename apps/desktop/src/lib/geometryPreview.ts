type Coord = [number, number];

interface GeometryGroup {
  coords: Coord[];
  children: GeometryGroup[];
}

function tokenize(wkt: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  while (i < wkt.length) {
    const ch = wkt[i];
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push(ch);
      i++;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if ((ch >= "0" && ch <= "9") || ch === "-" || ch === "+" || ch === ".") {
      const m = wkt.slice(i).match(/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (m) {
        tokens.push(parseFloat(m[0]));
        i += m[0].length;
      } else {
        i++;
      }
    } else {
      // skip alphabetic keywords (type names, EMPTY, Z, M, etc.)
      const word = wkt.slice(i).match(/^[A-Za-z]+/);
      if (word) {
        i += word[0].length;
      } else {
        i++;
      }
    }
  }
  return tokens;
}

function parseCoordSequence(tokens: (string | number)[], start: number): { coords: Coord[]; end: number } {
  const coords: Coord[] = [];
  let i = start;
  while (i < tokens.length) {
    if (typeof tokens[i] === "number") {
      const x = tokens[i] as number;
      i++;
      const y = i < tokens.length && typeof tokens[i] === "number" ? (tokens[i] as number) : 0;
      i++;
      coords.push([x, y]);
      // skip Z/M values
      while (i < tokens.length && typeof tokens[i] === "number") i++;
    } else if (tokens[i] === ",") {
      i++;
    } else {
      break;
    }
  }
  return { coords, end: i };
}

function parseGroups(tokens: (string | number)[], start: number): { groups: GeometryGroup[]; end: number } {
  const groups: GeometryGroup[] = [];
  let i = start;
  while (i < tokens.length) {
    if (tokens[i] === "(") {
      const inner = parseGroups(tokens, i + 1);
      if (inner.groups.length === 0) {
        // leaf group: parse as coordinate sequence
        const seq = parseCoordSequence(tokens, i + 1);
        groups.push({ coords: seq.coords, children: [] });
        i = seq.end;
      } else {
        groups.push({ coords: [], children: inner.groups });
        i = inner.end;
      }
      if (i < tokens.length && tokens[i] === ")") i++;
    } else if (tokens[i] === ")" || tokens[i] === ",") {
      break;
    } else if (typeof tokens[i] === "number") {
      const seq = parseCoordSequence(tokens, i);
      groups.push({ coords: seq.coords, children: [] });
      i = seq.end;
    } else {
      i++;
    }
  }
  return { groups, end: i };
}

function flattenCoords(groups: GeometryGroup[]): Coord[] {
  const result: Coord[] = [];
  for (const g of groups) {
    for (const c of g.coords) result.push(c);
    const childCoords = flattenCoords(g.children);
    for (const c of childCoords) result.push(c);
  }
  return result;
}

// Walk a group recursively and return the first non-empty coordinate sequence found
function extractCoords(g: GeometryGroup): Coord[] {
  if (g.coords.length > 0) return g.coords;
  for (const child of g.children) {
    const found = extractCoords(child);
    if (found.length > 0) return found;
  }
  return [];
}

// Draw polygon exterior + holes from a group structure
function drawPolygonRings(
  ctx: CanvasRenderingContext2D,
  group: GeometryGroup,
  mapX: (v: number) => number,
  mapY: (v: number) => number,
) {
  // group.children contains ring groups
  const rings = group.children.length > 0 ? group.children : [group];
  let ringIndex = 0;
  for (const ringGroup of rings) {
    const coords = extractCoords(ringGroup);
    if (coords.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(mapX(coords[0][0]), mapY(coords[0][1]));
    for (let j = 1; j < coords.length; j++) {
      ctx.lineTo(mapX(coords[j][0]), mapY(coords[j][1]));
    }
    ctx.closePath();
    if (ringIndex === 0) ctx.fill();
    ctx.stroke();
    ringIndex++;
  }
}

function drawGroups(
  ctx: CanvasRenderingContext2D,
  groups: GeometryGroup[],
  type: string,
  mapX: (v: number) => number,
  mapY: (v: number) => number,
) {
  if (type === "POINT" || type === "MULTIPOINT") {
    const allCoords = flattenCoords(groups);
    for (const [x, y] of allCoords) {
      ctx.beginPath();
      ctx.arc(mapX(x), mapY(y), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (type === "LINESTRING" || type === "MULTILINESTRING") {
    for (const g of groups) {
      const coords = extractCoords(g);
      if (coords.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(mapX(coords[0][0]), mapY(coords[0][1]));
        for (let i = 1; i < coords.length; i++) {
          ctx.lineTo(mapX(coords[i][0]), mapY(coords[i][1]));
        }
        ctx.stroke();
      }
    }
    return;
  }

  if (type === "POLYGON") {
    for (const g of groups) {
      drawPolygonRings(ctx, g, mapX, mapY);
    }
    return;
  }

  if (type === "MULTIPOLYGON") {
    for (const g of groups) {
      if (g.children.length > 0) {
        for (const polyChild of g.children) {
          drawPolygonRings(ctx, polyChild, mapX, mapY);
        }
      }
    }
    return;
  }

  // GEOMETRYCOLLECTION or unknown: draw all coordinate sequences
  for (const g of groups) {
    const coords = extractCoords(g);
    if (coords.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(mapX(coords[0][0]), mapY(coords[0][1]));
      for (let i = 1; i < coords.length; i++) {
        ctx.lineTo(mapX(coords[i][0]), mapY(coords[i][1]));
      }
      ctx.stroke();
    } else if (coords.length === 1) {
      const [x, y] = coords[0];
      ctx.beginPath();
      ctx.arc(mapX(x), mapY(y), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // recurse for type-less children
    if (coords.length === 0) {
      drawGroups(ctx, g.children, "", mapX, mapY);
    }
  }
}

function detectWktType(wkt: string): string {
  const m = wkt.trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : "GEOMETRYCOLLECTION";
}

// EWKB parsing on the backend can fall back to hex for unsupported geometry types
// (e.g. TIN, Triangle, CircularString). Don't attempt to render hex as WKT.
export function isHexGeometry(value: string): boolean {
  return value.startsWith("0x");
}

export function renderWktOnCanvas(canvas: HTMLCanvasElement, wkt: string): void {
  if (isHexGeometry(wkt)) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Preview not available for binary format", canvas.width / 2, canvas.height / 2);
    return;
  }

  const type = detectWktType(wkt);
  const tokens = tokenize(wkt);
  const { groups } = parseGroups(tokens, 0);
  const allCoords = flattenCoords(groups);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const pad = 20;

  ctx.clearRect(0, 0, W, H);

  if (allCoords.length === 0) {
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Empty geometry", W / 2, H / 2);
    return;
  }

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of allCoords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (minX === maxX && minY === maxY) {
    minX -= 1;
    maxX += 1;
    minY -= 1;
    maxY += 1;
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeY);

  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const mapX = (x: number) => (x - midX) * scale + W / 2;
  const mapY = (y: number) => -(y - midY) * scale + H / 2;

  ctx.strokeStyle = "#3b82f6";
  ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawGroups(ctx, groups, type, mapX, mapY);
}
