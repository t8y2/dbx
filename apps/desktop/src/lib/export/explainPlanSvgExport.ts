import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";
import type { PlanCanvasCategory } from "@/lib/diagram/planCanvas";
import { buildPlanCanvas, edgeStrokeWidth, formatPlanRows, heatLevel, PLAN_CATEGORY_COLORS, PLAN_CANVAS_GAP_X, PLAN_CANVAS_NODE_H, PLAN_CANVAS_NODE_W } from "@/lib/diagram/planCanvas";
import { escapeXml, svgNumber, svgText } from "./svgPrimitives";

const HEADER_HEIGHT = 36;
const LEGEND_HEIGHT = 42;
const MIN_EXPORT_WIDTH = 600;

const CATEGORY_COLORS: Record<PlanCanvasCategory, string> = PLAN_CATEGORY_COLORS;

const HEAT_COLORS = {
  none: "#71717a",
  cool: "#22c55e",
  warm: "#f59e0b",
  hot: "#ef4444",
} as const;

export interface ExplainPlanSvgLabels {
  title: string;
  cost: string;
  estimatedRows: string;
  legendHeat: string;
  legendEdge: string;
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function nodeTooltip(node: ExplainPlanNode, labels: ExplainPlanSvgLabels): string {
  return [node.title, node.relation ?? "", node.index ?? "", node.cost ? `${labels.cost}: ${node.cost}` : "", node.rows ? `${labels.estimatedRows}: ${node.rows}` : "", ...node.details].filter(Boolean).join("\n");
}

/** Build a standalone, theme-independent SVG for the complete Explain Plan. */
export function buildExplainPlanSvg(nodes: ExplainPlanNode[], labels: ExplainPlanSvgLabels): string {
  const layout = buildPlanCanvas(nodes);
  const width = Math.max(layout.width, MIN_EXPORT_WIDTH);
  const height = HEADER_HEIGHT + layout.height + LEGEND_HEIGHT;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="0 0 ${svgNumber(width)} ${svgNumber(height)}">`,
    `<title>${escapeXml(labels.title)}</title>`,
    '<defs><pattern id="explain-plan-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="#e4e4e7" stroke-width="1"/></pattern></defs>',
    `<rect width="${svgNumber(width)}" height="${svgNumber(height)}" fill="#fafafa"/>`,
    `<rect y="${HEADER_HEIGHT}" width="${svgNumber(width)}" height="${svgNumber(layout.height)}" fill="url(#explain-plan-grid)"/>`,
    svgText(labels.title, 18, HEADER_HEIGHT / 2, { size: 13, weight: "700" }),
    `<path d="M 0 ${HEADER_HEIGHT} H ${svgNumber(width)}" stroke="#d4d4d8"/>`,
    `<g transform="translate(0 ${HEADER_HEIGHT})">`,
    '<g class="plan-edges" fill="none" stroke="#71717a" stroke-linejoin="round" stroke-linecap="round">',
  ];

  for (const edge of layout.edges) {
    const startX = edge.from.x + PLAN_CANVAS_NODE_W;
    const startY = edge.from.y + PLAN_CANVAS_NODE_H / 2;
    const endY = edge.to.y + PLAN_CANVAS_NODE_H / 2;
    const elbowX = edge.to.x - PLAN_CANVAS_GAP_X / 2;
    const path = `M ${svgNumber(startX)} ${svgNumber(startY)} H ${svgNumber(elbowX)} V ${svgNumber(endY)} H ${svgNumber(edge.to.x)}`;
    const edgeLabel = formatPlanRows(edge.rows);
    parts.push(`<path d="${path}" stroke-width="${svgNumber(edgeStrokeWidth(edge.rows))}"><title>${escapeXml(`${edge.from.node.title} → ${edge.to.node.title}: ${edgeLabel}`)}</title></path>`);
    parts.push(`<text x="${svgNumber(edge.to.x - 8)}" y="${svgNumber(endY - 8)}" text-anchor="end" fill="#52525b" stroke="#fafafa" stroke-width="3" paint-order="stroke" font-size="10" font-family="Menlo, Consolas, monospace">${escapeXml(edgeLabel)}</text>`);
  }
  parts.push("</g>");

  layout.nodes.forEach((item, index) => {
    const { node } = item;
    const heat = heatLevel(item.costShare);
    const heatColor = HEAT_COLORS[heat];
    const categoryColor = CATEGORY_COLORS[item.category];
    const operation = node.nodeType || node.title;
    const objectName = [node.relation, node.index ? `[${node.index}]` : ""].filter(Boolean).join(" ");
    const share = item.costShare === undefined ? "" : `${(item.costShare * 100).toFixed(1)}%`;
    const titleLimit = share ? 21 : 28;
    const x = item.x;
    const y = item.y;

    parts.push(`<g class="plan-node" data-node-index="${index}" transform="translate(${svgNumber(x)} ${svgNumber(y)})">`);
    parts.push(`<title>${escapeXml(nodeTooltip(node, labels))}</title>`);
    parts.push(`<rect width="${PLAN_CANVAS_NODE_W}" height="${PLAN_CANVAS_NODE_H}" rx="8" fill="#ffffff" stroke="#d4d4d8"/>`);
    parts.push(`<path d="M 3 8 V ${PLAN_CANVAS_NODE_H - 8}" stroke="${heatColor}" stroke-width="3" stroke-linecap="round"/>`);
    parts.push(`<rect x="12" y="9" width="20" height="20" rx="5" fill="${categoryColor}" fill-opacity="0.18"/>`);
    parts.push(`<circle cx="22" cy="19" r="4" fill="${categoryColor}"/>`);
    parts.push(svgText(truncate(operation, titleLimit), 39, 19, { size: 12, weight: "700" }));
    if (share) {
      parts.push(`<rect x="166" y="10" width="36" height="18" rx="4" fill="${heatColor}" fill-opacity="0.14"/>`);
      parts.push(svgText(share, 184, 19, { size: 9, fill: heatColor, weight: "700", anchor: "middle", family: "Menlo, Consolas, monospace" }));
    }
    parts.push(svgText(objectName ? truncate(objectName, 32) : " ", 12, 43, { size: 10, fill: "#52525b", family: "Menlo, Consolas, monospace" }));
    parts.push(svgText(`${truncate(labels.estimatedRows, 15)} ${formatPlanRows(item.rows)}`, 12, 62, { size: 10, fill: "#52525b", family: "Menlo, Consolas, monospace" }));
    parts.push(svgText(`${truncate(labels.cost, 8)} ${truncate(node.cost || "—", 13)}`, 202, 62, { size: 10, fill: "#52525b", anchor: "end", family: "Menlo, Consolas, monospace" }));
    parts.push("</g>");
  });

  parts.push("</g>");
  const legendY = HEADER_HEIGHT + layout.height + LEGEND_HEIGHT / 2;
  parts.push(`<path d="M 0 ${HEADER_HEIGHT + layout.height} H ${svgNumber(width)}" stroke="#d4d4d8"/>`);
  parts.push(svgText(labels.legendHeat, 18, legendY, { size: 10, fill: "#52525b" }));
  let legendX = 18 + Math.min(150, Math.max(65, Array.from(labels.legendHeat).length * 6));
  for (const [color, label] of [
    [HEAT_COLORS.cool, "< 5%"],
    [HEAT_COLORS.warm, "5–20%"],
    [HEAT_COLORS.hot, "> 20%"],
  ] as const) {
    parts.push(`<rect x="${svgNumber(legendX)}" y="${svgNumber(legendY - 5)}" width="10" height="10" rx="2" fill="${color}"/>`);
    parts.push(svgText(label, legendX + 15, legendY, { size: 10, fill: "#52525b" }));
    legendX += 65;
  }
  parts.push(svgText(labels.legendEdge, legendX + 8, legendY, { size: 10, fill: "#52525b" }));
  parts.push(`<path d="M ${svgNumber(legendX + 8 + Math.min(120, Array.from(labels.legendEdge).length * 6) + 10)} ${svgNumber(legendY)} h 28" stroke="#71717a" stroke-width="4" stroke-linecap="round"/>`);
  parts.push("</svg>");
  return parts.join("");
}
