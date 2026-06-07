import type { EngineeringDiagram, EngineeringEntityNode } from "./engineeringDiagram";
import type { DiagramPosition, DiagramRelationship, DiagramTable } from "./erDiagram";

type DiagramSvgMode = "table" | "engineering";

interface DiagramCanvas {
  width: number;
  height: number;
}

export interface TableDiagramSvgOptions {
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
  positions: Record<string, DiagramPosition>;
  relationshipPaths: Record<string, string>;
  canvas: DiagramCanvas;
  cardWidth: number;
  cardHeaderHeight: number;
  columnRowHeight: number;
  maxVisibleColumns: number;
  cardBottomPadding?: number;
  moreColumnsLabel?: (count: number) => string;
}

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function svgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function svgHeader(canvas: DiagramCanvas): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(canvas.width)}" height="${svgNumber(canvas.height)}" viewBox="0 0 ${svgNumber(canvas.width)} ${svgNumber(canvas.height)}">`,
    '<rect width="100%" height="100%" fill="#fafafa"/>',
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
  const attrs = [
    `x="${svgNumber(x)}"`,
    `y="${svgNumber(y)}"`,
    `fill="${options.fill ?? "#18181b"}"`,
    `font-size="${options.size ?? 12}"`,
    `font-family="${options.family ?? "Arial, Helvetica, sans-serif"}"`,
    'dominant-baseline="middle"',
  ];
  if (options.weight) attrs.push(`font-weight="${options.weight}"`);
  if (options.anchor) attrs.push(`text-anchor="${options.anchor}"`);
  if (options.decoration) attrs.push(`text-decoration="${options.decoration}"`);
  return `<text ${attrs.join(" ")}>${escapeXml(label)}</text>`;
}

function tableHeight(table: DiagramTable, options: TableDiagramSvgOptions): number {
  const visibleCount = Math.min(table.columns.length, options.maxVisibleColumns);
  const overflowHeight = table.columns.length > options.maxVisibleColumns ? options.columnRowHeight : 0;
  return (
    options.cardHeaderHeight +
    visibleCount * options.columnRowHeight +
    overflowHeight +
    (options.cardBottomPadding ?? 12)
  );
}

function tableDiagramDefs(): string {
  return [
    "<defs>",
    '<marker id="dbx-diagram-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">',
    '<path d="M 0 0 L 8 4 L 0 8 z" fill="#2563eb"/>',
    "</marker>",
    "</defs>",
  ].join("");
}

function isForeignKeyColumn(table: DiagramTable, columnName: string): boolean {
  return table.foreignKeys.some((fk) => fk.column === columnName);
}

export function buildTableDiagramSvg(options: TableDiagramSvgOptions): string {
  const parts = [
    svgHeader(options.canvas),
    tableDiagramDefs(),
    '<g fill="none" stroke="#2563eb" stroke-opacity="0.58" stroke-width="1.6">',
  ];

  for (const relationship of options.relationships) {
    const path = options.relationshipPaths[relationship.id];
    if (!path) continue;
    parts.push(
      `<path d="${escapeXml(path)}" marker-end="url(#dbx-diagram-arrow)">` +
        `<title>${escapeXml(`${relationship.sourceTable}.${relationship.sourceColumn} -> ${relationship.targetTable}.${relationship.targetColumn}`)}</title>` +
        "</path>",
    );
  }
  parts.push("</g>");

  for (const table of options.tables) {
    const position = options.positions[table.name] ?? { x: 0, y: 0 };
    const height = tableHeight(table, options);
    const visibleColumns = table.columns.slice(0, options.maxVisibleColumns);
    const hiddenCount = Math.max(0, table.columns.length - options.maxVisibleColumns);
    parts.push(`<g transform="translate(${svgNumber(position.x)} ${svgNumber(position.y)})">`);
    parts.push(
      `<rect width="${options.cardWidth}" height="${svgNumber(height)}" rx="6" fill="#ffffff" stroke="#d4d4d8"/>`,
    );
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

    visibleColumns.forEach((column, index) => {
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

    if (hiddenCount > 0) {
      const y =
        options.cardHeaderHeight + visibleColumns.length * options.columnRowHeight + options.columnRowHeight / 2;
      parts.push(
        svgText(options.moreColumnsLabel?.(hiddenCount) ?? `+ ${hiddenCount} columns`, 12, y, {
          size: 11,
          fill: "#71717a",
        }),
      );
    }
    parts.push("</g>");
  }

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
    parts.push(
      `<line x1="${svgNumber(from.x)}" y1="${svgNumber(from.y)}" x2="${svgNumber(to.x)}" y2="${svgNumber(to.y)}"/>`,
    );
  }
  for (const relationship of diagram.relationships) {
    const source = centers.get(relationship.sourceTable);
    const target = centers.get(relationship.targetTable);
    if (!source || !target) continue;
    const middle = nodeCenter(relationship);
    parts.push(
      `<line x1="${svgNumber(source.x)}" y1="${svgNumber(source.y)}" x2="${svgNumber(middle.x)}" y2="${svgNumber(middle.y)}"/>`,
    );
    parts.push(
      `<line x1="${svgNumber(middle.x)}" y1="${svgNumber(middle.y)}" x2="${svgNumber(target.x)}" y2="${svgNumber(target.y)}"/>`,
    );
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
    parts.push(
      `<ellipse cx="${svgNumber(attribute.x + attribute.width / 2)}" cy="${svgNumber(attribute.y + attribute.height / 2)}" ` +
        `rx="${svgNumber(attribute.width / 2)}" ry="${svgNumber(attribute.height / 2)}" fill="#dcfce7" stroke="#16a34a" stroke-opacity="0.65"/>`,
    );
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
    parts.push(
      `<rect x="${svgNumber(entity.x)}" y="${svgNumber(entity.y)}" width="${entity.width}" height="${entity.height}" fill="#dbeafe" stroke="#3b82f6" stroke-opacity="0.7"/>`,
    );
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

function fileToken(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function diagramSvgFileName(connectionName: string, databaseName: string, mode: DiagramSvgMode): string {
  const context = [connectionName, databaseName].map(fileToken).filter(Boolean);
  const suffix = mode === "engineering" ? "engineering-er" : "table-structure";
  return ["dbx", ...(context.length > 0 ? context : ["diagram"]), suffix].join("-") + ".svg";
}
