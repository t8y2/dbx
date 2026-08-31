import type { EngineeringDiagram, EngineeringEntityNode } from "@/lib/diagram/engineeringDiagram";
import type { DiagramPosition, DiagramRelationship, DiagramTable } from "@/lib/diagram/erDiagram";
import { pickHandles } from "@/lib/diagram/vue-flow-adapter";
import { pointAlongPolyline, pointsToSvgPath, type Point } from "@/lib/diagram/edge-obstacle-router";
import { CARD_BOTTOM_PADDING, CARD_HEADER_HEIGHT, CARD_WIDTH, COLUMN_ROW_HEIGHT, MARGIN } from "@/lib/diagram/diagram-constants";

const SOURCE_CARDINALITY_T = 0.18;
const TARGET_CARDINALITY_T = 0.82;

interface DiagramCanvas {
  width: number;
  height: number;
  /** viewBox origin; defaults to 0 when omitted (engineering mode already normalizes to ~0). */
  originX?: number;
  originY?: number;
}

export interface DiagramSvgLayer {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TableDiagramSvgOptions {
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
  positions: Record<string, DiagramPosition>;
  relationshipPaths: Record<string, string>;
  /** Polyline points for endpoint cardinality badges (aligned with relationshipPaths). */
  relationshipPolylines?: Record<string, Point[]>;
  canvas: DiagramCanvas;
  cardWidth: number;
  cardHeaderHeight: number;
  columnRowHeight: number;
  cardBottomPadding?: number;
  layers?: DiagramSvgLayer[];
}

type CardHeightMetrics = {
  cardHeaderHeight: number;
  columnRowHeight: number;
  cardBottomPadding?: number;
};

function escapeXml(value: string | number): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function svgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function svgHeader(canvas: DiagramCanvas): string {
  // Always viewBox 0 0 — callers that use non-zero canvas.origin must translate content (see buildTableDiagramSvg).
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(canvas.width)}" height="${svgNumber(canvas.height)}" viewBox="0 0 ${svgNumber(canvas.width)} ${svgNumber(canvas.height)}">`,
    `<rect x="0" y="0" width="${svgNumber(canvas.width)}" height="${svgNumber(canvas.height)}" fill="#fafafa"/>`,
  ].join("");
}

function svgText(
  label: string,
  x: number,
  y: number,
  options: {
    size?: number;
    fill?: string;
    weight?: string;
    anchor?: "start" | "middle" | "end";
    family?: string;
    decoration?: string;
  } = {},
): string {
  const attrs = [`x="${svgNumber(x)}"`, `y="${svgNumber(y)}"`, `fill="${options.fill ?? "#18181b"}"`, `font-size="${options.size ?? 12}"`, `font-family="${options.family ?? "Arial, Helvetica, sans-serif"}"`, 'dominant-baseline="middle"'];
  if (options.weight) attrs.push(`font-weight="${options.weight}"`);
  if (options.anchor) attrs.push(`text-anchor="${options.anchor}"`);
  if (options.decoration) attrs.push(`text-decoration="${options.decoration}"`);
  return `<text ${attrs.join(" ")}>${escapeXml(label)}</text>`;
}

/** Shared table card height for SVG canvas / paths / cards. */
function svgCardHeight(columnCount: number, metrics: CardHeightMetrics): number {
  return metrics.cardHeaderHeight + columnCount * metrics.columnRowHeight + (metrics.cardBottomPadding ?? CARD_BOTTOM_PADDING);
}

function isForeignKeyColumn(table: DiagramTable, columnName: string): boolean {
  return table.foreignKeys.some((fk) => fk.column === columnName);
}

function handleAnchor(pos: DiagramPosition, handle: string, width: number, height: number): Point {
  const cx = pos.x + width / 2;
  const cy = pos.y + height / 2;
  if (handle.startsWith("right")) return { x: pos.x + width, y: cy };
  if (handle.startsWith("left")) return { x: pos.x, y: cy };
  if (handle.startsWith("bottom")) return { x: cx, y: pos.y + height };
  return { x: cx, y: pos.y };
}

/** Orthogonal fallback polyline when no ELK/obstacle waypoints are stored. */
function orthogonalPointsBetweenTables(sourcePos: DiagramPosition, targetPos: DiagramPosition, sourceHeight: number, targetHeight: number, cardWidth: number): Point[] {
  const { sourceHandle, targetHandle } = pickHandles(sourcePos, targetPos, sourceHeight, targetHeight, cardWidth);
  const s = handleAnchor(sourcePos, sourceHandle, cardWidth, sourceHeight);
  const t = handleAnchor(targetPos, targetHandle.replace(/-target$/, ""), cardWidth, targetHeight);
  const mid: Point = Math.abs(s.x - t.x) >= Math.abs(s.y - t.y) ? { x: t.x, y: s.y } : { x: s.x, y: t.y };
  return [s, mid, t];
}

type RelationshipGeometryInput = {
  relationships: DiagramRelationship[];
  positions: Record<string, DiagramPosition>;
  tables: DiagramTable[];
  waypoints?: Record<string, Point[]>;
  cardWidth?: number;
  cardHeaderHeight?: number;
  columnRowHeight?: number;
  cardBottomPadding?: number;
};

/**
 * Build relationship polylines from live waypoints or table positions.
 */
export function buildTableRelationshipPolylines(input: RelationshipGeometryInput): Record<string, Point[]> {
  const cardWidth = input.cardWidth ?? CARD_WIDTH;
  const metrics: CardHeightMetrics = {
    cardHeaderHeight: input.cardHeaderHeight ?? CARD_HEADER_HEIGHT,
    columnRowHeight: input.columnRowHeight ?? COLUMN_ROW_HEIGHT,
    cardBottomPadding: input.cardBottomPadding ?? CARD_BOTTOM_PADDING,
  };
  const heightByName = new Map(input.tables.map((t) => [t.name, svgCardHeight(t.columns.length, metrics)]));
  const polylines: Record<string, Point[]> = {};

  for (const rel of input.relationships) {
    const stored = input.waypoints?.[rel.id];
    if (stored && stored.length >= 2) {
      polylines[rel.id] = stored.map((p) => ({ ...p }));
      continue;
    }
    const sourcePos = input.positions[rel.sourceTable];
    const targetPos = input.positions[rel.targetTable];
    if (!sourcePos || !targetPos) continue;
    const sh = heightByName.get(rel.sourceTable) ?? svgCardHeight(0, metrics);
    const th = heightByName.get(rel.targetTable) ?? svgCardHeight(0, metrics);
    polylines[rel.id] = orthogonalPointsBetweenTables(sourcePos, targetPos, sh, th, cardWidth);
  }
  return polylines;
}

/**
 * Build SVG path `d` strings for relationships from live waypoints or table positions.
 */
export function buildTableRelationshipPaths(input: RelationshipGeometryInput): Record<string, string> {
  const polylines = buildTableRelationshipPolylines(input);
  const paths: Record<string, string> = {};
  for (const [id, points] of Object.entries(polylines)) {
    paths[id] = pointsToSvgPath(points);
  }
  return paths;
}

/** Compute canvas size that fits tables + layers + relationship polylines with padding. */
export function computeTableDiagramCanvas(
  tables: DiagramTable[],
  positions: Record<string, DiagramPosition>,
  options: {
    cardWidth: number;
    cardHeaderHeight: number;
    columnRowHeight: number;
    cardBottomPadding?: number;
    layers?: DiagramSvgLayer[];
    relationshipPolylines?: Record<string, Point[]>;
    padding?: number;
  },
): DiagramCanvas {
  const padding = options.padding ?? MARGIN;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const expand = (x1: number, y1: number, x2: number, y2: number) => {
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  };

  for (const layer of options.layers ?? []) {
    if (layer.width <= 0 || layer.height <= 0) continue;
    expand(layer.x, layer.y, layer.x + layer.width, layer.y + layer.height);
  }

  for (const table of tables) {
    const pos = positions[table.name] ?? { x: 0, y: 0 };
    const height = svgCardHeight(table.columns.length, options);
    expand(pos.x, pos.y, pos.x + options.cardWidth, pos.y + height);
  }

  for (const points of Object.values(options.relationshipPolylines ?? {})) {
    for (const point of points) {
      expand(point.x, point.y, point.x, point.y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { width: 400 + padding, height: 300 + padding, originX: 0, originY: 0 };
  }

  return {
    width: Math.ceil(maxX - minX + 2 * padding),
    height: Math.ceil(maxY - minY + 2 * padding),
    originX: minX - padding,
    originY: minY - padding,
  };
}

export function buildTableDiagramSvg(options: TableDiagramSvgOptions): string {
  const ox = options.canvas.originX ?? 0;
  const oy = options.canvas.originY ?? 0;
  const parts = [svgHeader(options.canvas)];
  parts.push(`<g transform="translate(${svgNumber(-ox)} ${svgNumber(-oy)})">`);

  const layers = (options.layers ?? []).filter((l) => l.width > 0 && l.height > 0);
  if (layers.length > 0) {
    parts.push('<g class="diagram-layers">');
    for (const layer of layers) {
      const fill = layer.color || "#9ca3af";
      parts.push(`<rect x="${svgNumber(layer.x)}" y="${svgNumber(layer.y)}" width="${svgNumber(layer.width)}" height="${svgNumber(layer.height)}" ` + `rx="8" fill="${escapeXml(fill)}" fill-opacity="0.08" stroke="${escapeXml(fill)}" stroke-opacity="0.55" stroke-width="1.5"/>`);
      parts.push(
        svgText(layer.name, layer.x + 12, layer.y + 18, {
          size: 12,
          weight: "600",
          fill: fill,
        }),
      );
    }
    parts.push("</g>");
  }

  parts.push('<g fill="none" stroke="#2563eb" stroke-opacity="0.58" stroke-width="1.6">');
  for (const relationship of options.relationships) {
    const path = options.relationshipPaths[relationship.id];
    if (!path) continue;
    parts.push(`<path d="${escapeXml(path)}">` + `<title>${escapeXml(`${relationship.sourceTable}.${relationship.sourceColumn} -> ${relationship.targetTable}.${relationship.targetColumn}`)}</title>` + "</path>");
  }
  parts.push("</g>");

  parts.push('<g class="diagram-cardinality">');
  for (const relationship of options.relationships) {
    const points = options.relationshipPolylines?.[relationship.id];
    if (!points || points.length < 2) continue;
    const sourcePos = pointAlongPolyline(points, SOURCE_CARDINALITY_T);
    const targetPos = pointAlongPolyline(points, TARGET_CARDINALITY_T);
    const sourceCard = relationship.sourceCardinality || "N";
    const targetCard = relationship.targetCardinality || "1";
    parts.push(
      svgText(sourceCard, sourcePos.x, sourcePos.y, {
        size: 11,
        weight: "700",
        anchor: "middle",
        fill: "#18181b",
      }),
    );
    parts.push(
      svgText(targetCard, targetPos.x, targetPos.y, {
        size: 11,
        weight: "700",
        anchor: "middle",
        fill: "#18181b",
      }),
    );
  }
  parts.push("</g>");

  for (const table of options.tables) {
    const position = options.positions[table.name] ?? { x: 0, y: 0 };
    const height = svgCardHeight(table.columns.length, options);
    parts.push(`<g transform="translate(${svgNumber(position.x)} ${svgNumber(position.y)})">`);
    parts.push(`<rect width="${options.cardWidth}" height="${svgNumber(height)}" rx="6" fill="#ffffff" stroke="#d4d4d8"/>`);
    parts.push(`<rect width="${options.cardWidth}" height="${options.cardHeaderHeight}" rx="6" fill="#f4f4f5"/>`);
    parts.push(`<path d="M 0 ${options.cardHeaderHeight} H ${options.cardWidth}" stroke="#e4e4e7"/>`);
    parts.push(svgText(table.name, 36, options.cardHeaderHeight / 2, { size: 13, weight: "600" }));
    parts.push(
      svgText(String(table.columns.length), options.cardWidth - 18, options.cardHeaderHeight / 2, {
        size: 10,
        anchor: "end",
        fill: "#52525b",
      }),
    );

    table.columns.forEach((column, index) => {
      const rowTop = options.cardHeaderHeight + index * options.columnRowHeight;
      const rowCenter = rowTop + options.columnRowHeight / 2;
      parts.push(`<path d="M 0 ${svgNumber(rowTop)} H ${options.cardWidth}" stroke="#f0f0f1"/>`);
      if (column.is_primary_key) {
        parts.push(svgText("PK", 14, rowCenter, { size: 9, fill: "#d97706", weight: "700" }));
      } else if (isForeignKeyColumn(table, column.name)) {
        parts.push(svgText("FK", 14, rowCenter, { size: 9, fill: "#2563eb", weight: "700" }));
      }
      parts.push(svgText(column.name, 38, rowCenter, { size: 11, family: "Menlo, Consolas, monospace" }));
      parts.push(
        svgText(column.data_type, options.cardWidth - 12, rowCenter, {
          size: 10,
          fill: "#71717a",
          anchor: "end",
        }),
      );
    });
    parts.push("</g>");
  }

  parts.push("</g>");
  parts.push("</svg>");
  return parts.join("");
}

function nodeCenter(node: { x: number; y: number; width: number; height: number }): DiagramPosition {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function cardinalityPoint(from: DiagramPosition, to: DiagramPosition): DiagramPosition {
  return {
    x: from.x + (to.x - from.x) * 0.72,
    y: from.y + (to.y - from.y) * 0.72,
  };
}

function entityCenterMap(entities: EngineeringEntityNode[]): Map<string, DiagramPosition> {
  return new Map(entities.map((entity) => [entity.name, nodeCenter(entity)]));
}

export function buildEngineeringDiagramSvg(diagram: EngineeringDiagram): string {
  const parts = [svgHeader(diagram.canvas)];
  const centers = entityCenterMap(diagram.entities);

  parts.push('<g stroke="#52525b" stroke-width="1.2">');
  for (const attribute of diagram.attributes) {
    const from = centers.get(attribute.tableName);
    if (!from) continue;
    const to = nodeCenter(attribute);
    parts.push(`<line x1="${svgNumber(from.x)}" y1="${svgNumber(from.y)}" x2="${svgNumber(to.x)}" y2="${svgNumber(to.y)}"/>`);
  }
  for (const relationship of diagram.relationships) {
    const source = centers.get(relationship.sourceTable);
    const target = centers.get(relationship.targetTable);
    if (!source || !target) continue;
    const middle = nodeCenter(relationship);
    parts.push(`<line x1="${svgNumber(source.x)}" y1="${svgNumber(source.y)}" x2="${svgNumber(middle.x)}" y2="${svgNumber(middle.y)}"/>`);
    parts.push(`<line x1="${svgNumber(middle.x)}" y1="${svgNumber(middle.y)}" x2="${svgNumber(target.x)}" y2="${svgNumber(target.y)}"/>`);
    const sourceLabel = cardinalityPoint(middle, source);
    const targetLabel = cardinalityPoint(middle, target);
    parts.push(
      svgText(relationship.sourceCardinality, sourceLabel.x, sourceLabel.y - 8, {
        size: 13,
        weight: "700",
        anchor: "middle",
      }),
    );
    parts.push(
      svgText(relationship.targetCardinality, targetLabel.x, targetLabel.y - 8, {
        size: 13,
        weight: "700",
        anchor: "middle",
      }),
    );
  }
  parts.push("</g>");

  for (const attribute of diagram.attributes) {
    parts.push(`<ellipse cx="${svgNumber(attribute.x + attribute.width / 2)}" cy="${svgNumber(attribute.y + attribute.height / 2)}" ` + `rx="${svgNumber(attribute.width / 2)}" ry="${svgNumber(attribute.height / 2)}" fill="#dcfce7" stroke="#16a34a" stroke-opacity="0.65"/>`);
    parts.push(
      svgText(attribute.label, attribute.x + attribute.width / 2, attribute.y + attribute.height / 2, {
        size: 11,
        fill: "#052e16",
        weight: attribute.primaryKey ? "700" : undefined,
        anchor: "middle",
        decoration: attribute.primaryKey ? "underline" : undefined,
      }),
    );
  }

  for (const relationship of diagram.relationships) {
    const cx = relationship.x + relationship.width / 2;
    const cy = relationship.y + relationship.height / 2;
    const points = [
      [cx, relationship.y],
      [relationship.x + relationship.width, cy],
      [cx, relationship.y + relationship.height],
      [relationship.x, cy],
    ]
      .map(([x, y]) => `${svgNumber(x)},${svgNumber(y)}`)
      .join(" ");
    parts.push(`<polygon points="${points}" fill="#fee2e2" stroke="#ef4444" stroke-opacity="0.7"/>`);
    parts.push(
      svgText(relationship.label, cx, cy, {
        size: 11,
        fill: "#450a0a",
        weight: "600",
        anchor: "middle",
      }),
    );
  }

  for (const entity of diagram.entities) {
    parts.push(`<rect x="${svgNumber(entity.x)}" y="${svgNumber(entity.y)}" width="${entity.width}" height="${entity.height}" fill="#dbeafe" stroke="#3b82f6" stroke-opacity="0.7"/>`);
    parts.push(
      svgText(entity.name, entity.x + entity.width / 2, entity.y + entity.height / 2, {
        size: 13,
        fill: "#172554",
        weight: "700",
        anchor: "middle",
      }),
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

type DiagramSvgMode = "table" | "engineering";

function fileToken(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Stable download name for SVG exports (shared with upstream contract tests). */
export function diagramSvgFileName(connectionName: string, databaseName: string, mode: DiagramSvgMode): string {
  const context = [connectionName, databaseName].map(fileToken).filter(Boolean);
  const suffix = mode === "engineering" ? "engineering-er" : "table-structure";
  return ["dbx", ...(context.length > 0 ? context : ["diagram"]), suffix].join("-") + ".svg";
}
