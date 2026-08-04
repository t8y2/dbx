import type { ExplainPlanNode } from "./explainPlan";

export type PlanCanvasCategory = "result" | "sort" | "join" | "tscan" | "iscan" | "lookup" | "mat" | "agg" | "xchg" | "mod" | "other";

export const PLAN_CANVAS_NODE_W = 212;
export const PLAN_CANVAS_NODE_H = 76;
export const PLAN_CANVAS_GAP_X = 84;
export const PLAN_CANVAS_GAP_Y = 26;
export const PLAN_CANVAS_PAD = 36;

/**
 * Ordered because operator names overlap across engines: "Merge Join" is a join
 * while a bare "Merge" is DML, "Clustered Index Scan" reads a whole table while
 * "Index Scan" does not, and "SORT AGGREGATE" is an aggregate, not a sort.
 */
const CATEGORY_RULES: Array<[RegExp, PlanCanvasCategory]> = [
  // MySQL access types are single ambiguous words, so they only match exactly.
  [/^(?:eq_ref|const|system)$/, "lookup"],
  [/^(?:ref|range|index|index_merge|ref_or_null|fulltext)$/, "iscan"],
  [/^all$/, "tscan"],

  [/(?:key|rid|row|rowid|heap)\s+lookup|table access by .*rowid/, "lookup"],
  [/hash join|hash match|merge join|nested loops?|nest loop|hash2|cartesian/, "join"],
  [/aggregate|group by|grouping_operation|hagr\d*|sagr\d*|\bagg\b/, "agg"],
  [/sort|ordering_operation/, "sort"],
  [/gather|parallelism|px send|px receive|px block|exchange|repartition|distribute/, "xchg"],
  [/^(?:insert|update|delete|replace)\b|^merge$|modifytable|table (?:insert|update|delete|merge)|clustered index (?:insert|update|delete|merge)|load table|\bdml\b/, "mod"],
  [/materiali[sz]|spool|\bhash\b|\bcte\b|temp table transformation|worktable/, "mat"],
  [/clustered index scan|seq scan|sequential scan|table scan|table access full|table access storage full|cscn\d*/, "tscan"],
  [/index.*(?:scan|seek)|bitmap heap scan|ssek\d*|csek\d*|bmsk\d*/, "iscan"],
  [/result|^select\b|select statement|limit|query_block|nset\d*|prjt\d*|union|\btop\b/, "result"],
];

export function categorizePlanNode(nodeType: string): PlanCanvasCategory {
  const normalized = nodeType.trim().toLowerCase();
  if (!normalized) return "other";
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(normalized)) return category;
  }
  return "other";
}

/** Reads the numeric part of an engine-native cost/rows string ("0.29..1830.12", "1,234", "96M"). */
export function parsePlanNumber(value?: string): number | undefined {
  if (value == null) return undefined;
  let text = String(value).trim();
  if (!text) return undefined;

  // PostgreSQL reports "startup..total"; the total is what matters.
  const rangeIndex = text.lastIndexOf("..");
  if (rangeIndex >= 0) text = text.slice(rangeIndex + 2).trim();

  const match = text.match(/^([+-]?[\d,]*\.?\d+)\s*(?:([kmgt])\b)?/i);
  if (!match) return undefined;
  const base = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(base)) return undefined;

  const scales: Record<string, number> = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return base * (scales[match[2]?.toLowerCase() ?? ""] ?? 1);
}

export function extractActualRows(node: ExplainPlanNode): number | undefined {
  // Estimates are per execution, so the per-execution detail wins when the engine
  // reports cumulative actuals (SQL Server). PostgreSQL never emits that key.
  let total: number | undefined;
  for (const detail of node.details) {
    const perExecution = detail.match(/Actual Rows Per Execution:\s*(\S+)/i);
    if (perExecution) return parsePlanNumber(perExecution[1]);
    if (total !== undefined) continue;
    const match = detail.match(/Actual Rows:\s*(\S+)/i);
    if (match) total = parsePlanNumber(match[1]);
  }
  return total;
}

export interface PlanCanvasNode {
  node: ExplainPlanNode;
  category: PlanCanvasCategory;
  x: number;
  y: number;
  costShare?: number;
  rows?: number;
  actualRows?: number;
}

export interface PlanCanvasEdge {
  from: PlanCanvasNode;
  to: PlanCanvasNode;
  rows?: number;
}

export interface PlanCanvasLayout {
  nodes: PlanCanvasNode[];
  edges: PlanCanvasEdge[];
  width: number;
  height: number;
}

export function buildPlanCanvas(roots: ExplainPlanNode[]): PlanCanvasLayout {
  const nodes: PlanCanvasNode[] = [];
  const edges: PlanCanvasEdge[] = [];
  const selfCosts = new Map<PlanCanvasNode, number>();
  let leafOffset = 0;

  function place(node: ExplainPlanNode, depth: number, parent?: PlanCanvasNode): PlanCanvasNode {
    const placed: PlanCanvasNode = {
      node,
      category: categorizePlanNode(node.nodeType),
      x: PLAN_CANVAS_PAD + depth * (PLAN_CANVAS_NODE_W + PLAN_CANVAS_GAP_X),
      y: 0,
      rows: parsePlanNumber(node.rows),
      actualRows: extractActualRows(node),
    };
    nodes.push(placed);
    if (parent) edges.push({ from: parent, to: placed, rows: placed.rows });

    const children = node.children.map((child) => place(child, depth + 1, placed));
    if (children.length === 0) {
      placed.y = PLAN_CANVAS_PAD + leafOffset;
      leafOffset += PLAN_CANVAS_NODE_H + PLAN_CANVAS_GAP_Y;
    } else {
      placed.y = (children[0].y + children[children.length - 1].y) / 2;
    }

    const cost = parsePlanNumber(node.cost);
    if (cost !== undefined) {
      // Costs are cumulative over the subtree in PG / SQL Server / Oracle.
      const childCost = node.children.reduce((total, child) => total + (parsePlanNumber(child.cost) ?? 0), 0);
      selfCosts.set(placed, Math.max(0, cost - childCost));
    }
    return placed;
  }

  roots.forEach((root) => place(root, 0));

  const totalSelfCost = [...selfCosts.values()].reduce((total, cost) => total + cost, 0);
  if (totalSelfCost > 0) {
    for (const [placed, cost] of selfCosts) placed.costShare = cost / totalSelfCost;
  }

  const width = nodes.reduce((max, placed) => Math.max(max, placed.x + PLAN_CANVAS_NODE_W), 0) + PLAN_CANVAS_PAD;
  const height = nodes.reduce((max, placed) => Math.max(max, placed.y + PLAN_CANVAS_NODE_H), 0) + PLAN_CANVAS_PAD;
  return { nodes, edges, width: nodes.length ? width : 0, height: nodes.length ? height : 0 };
}

export function heatLevel(share?: number): "none" | "cool" | "warm" | "hot" {
  if (share === undefined) return "none";
  if (share > 0.2) return "hot";
  return share >= 0.05 ? "warm" : "cool";
}

export function edgeStrokeWidth(rows?: number): number {
  if (rows === undefined || !Number.isFinite(rows)) return 1.6;
  return Math.min(8, Math.max(1.6, 1.6 + Math.log10(Math.max(0, rows) + 1) * 1.05));
}

export function formatPlanRows(rows?: number): string {
  if (rows === undefined || !Number.isFinite(rows)) return "—";
  const trim = (value: string) => value.replace(/\.0$/, "");
  const magnitude = Math.abs(rows);
  if (magnitude >= 1e6) return `${trim((rows / 1e6).toFixed(1))}M`;
  if (magnitude >= 1e3) return `${trim((rows / 1e3).toFixed(1))}K`;
  return String(Math.round(rows));
}
