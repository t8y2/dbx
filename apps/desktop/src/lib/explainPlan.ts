import type { DatabaseType, QueryResult } from "@/types/database";
import * as api from "@/lib/api";
import { supportsDatabaseFeature } from "./databaseDriverManifest";

export interface ExplainPlanNode {
  id: string;
  title: string;
  nodeType: string;
  relation?: string;
  index?: string;
  cost?: string;
  rows?: string;
  width?: string;
  details: string[];
  children: ExplainPlanNode[];
}

export interface ParsedExplainPlan {
  databaseType: "mysql" | "postgres" | "dameng";
  raw: unknown;
  nodes: ExplainPlanNode[];
}

export type BuildExplainSqlResult = { ok: true; sql: string } | { ok: false; reason: "unsupported" | "empty" | "unsafe" };

const SUPPORTED_EXPLAIN_TYPES = new Set<DatabaseType>(["mysql", "postgres", "dameng"]);
export function supportsExplainPlan(databaseType?: DatabaseType): databaseType is "mysql" | "postgres" | "dameng" {
  return !!databaseType && supportsDatabaseFeature(databaseType, "sqlExplain") && SUPPORTED_EXPLAIN_TYPES.has(databaseType);
}

export function buildExplainSql(databaseType: DatabaseType | undefined, sql: string): Promise<BuildExplainSqlResult> {
  return api.buildExplainSql({ databaseType, sql }) as Promise<BuildExplainSqlResult>;
}

export function parseExplainResult(databaseType: "mysql" | "postgres" | "dameng", result: QueryResult): ParsedExplainPlan {
  if (databaseType === "dameng") {
    return parseDamengExplain(result);
  }
  const raw = parseExplainCell(result.rows[0]?.[0]);
  const nodes = databaseType === "postgres" ? parsePostgresExplain(raw) : parseMysqlExplain(raw);
  return { databaseType, raw, nodes };
}

/**
 * Parse DM's getExplainInfo() text output.
 * Format (flat list with indentation):
 *   1   #NSET2: [cost, rows, width]
 *   2     #PIPE2: [cost, rows, width]
 *   3       #PRJT2: [cost, rows, width]; props...
 *   ...
 *   Statistics
 *       logical reads
 *       exec time(ms)
 *
 * For autotrace, rows include ->actual: [cost, estRows->actualRows, width]
 */
export function parseDamengExplainText(planText: string): ParsedExplainPlan {
  const lines = planText.split("\n");
  const operatorLines: { indent: number; line: string; raw: string }[] = [];
  const stats: Record<string, string> = {};
  let inStats = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Check for Statistics section
    if (trimmed.toLowerCase() === "statistics") {
      inStats = true;
      continue;
    }
    if (inStats) {
      const m = trimmed.match(/^(\d+)\s+(.+)$/);
      if (m) {
        stats[m[2].trim()] = m[1];
      }
      continue;
    }

    // Try to parse operator line: <line_number><spaces>#OPERATOR...
    const opMatch = trimmed.match(/^\d+(\s+)#/);
    if (opMatch) {
      // indent = number of spaces between line number and #
      const indent = opMatch[1].length;
      operatorLines.push({ indent, line: trimmed.substring(trimmed.indexOf("#")), raw: rawLine });
    }
  }

  // Build tree from flat operator lines using indent spacing
  // First line's indent = baseline (depth 0), each +2 spaces = +1 depth
  const baseIndent = operatorLines.length > 0 ? operatorLines[0].indent : 0;
  const rootNodes: ExplainPlanNode[] = [];
  const parentStack: ExplainPlanNode[] = [];

  for (const { indent, line } of operatorLines) {
    const nodeInfo = parseDamengPlanLine(line);
    if (!nodeInfo) continue;

    const depth = Math.max(0, Math.round((indent - baseIndent) / 2));
    while (parentStack.length > depth) parentStack.pop();

    const childIndex = parentStack.length === 0 ? rootNodes.length + 1 : parentStack[parentStack.length - 1].children.length + 1;
    const id = parentStack.length === 0 ? String(childIndex) : `${parentStack[parentStack.length - 1].id}.${childIndex}`;

    const details: string[] = [];
    if (nodeInfo.props) details.push(nodeInfo.props);
    if (nodeInfo.actualRows) details.push(`Actual Rows: ${nodeInfo.actualRows}`);
    if (nodeInfo.memUsed) details.push(`Memory: ${nodeInfo.memUsed}`);
    if (nodeInfo.diskUsed) details.push(`Disk: ${nodeInfo.diskUsed}`);

    const node: ExplainPlanNode = {
      id,
      title: nodeInfo.relation ? `${nodeInfo.nodeType} on ${nodeInfo.relation}` : nodeInfo.nodeType,
      nodeType: nodeInfo.operation,
      cost: nodeInfo.cost || undefined,
      rows: nodeInfo.rows || undefined,
      relation: nodeInfo.relation || undefined,
      details,
      children: [],
    };

    if (parentStack.length === 0) {
      rootNodes.push(node);
    } else {
      parentStack[parentStack.length - 1].children.push(node);
    }
    parentStack.push(node);
  }

  // Add stats summary to root node
  if (Object.keys(stats).length > 0) {
    const statsDetail = Object.entries(stats)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (rootNodes.length > 0 && !rootNodes[0].details.some((d) => d.startsWith("Statistics:"))) {
      rootNodes[0].details.push(`Statistics: ${statsDetail}`);
    }
  }

  return { databaseType: "dameng", raw: planText, nodes: rootNodes };
}

interface DamengOpInfo {
  operation: string;
  nodeType: string;
  cost?: string;
  rows?: string;
  actualRows?: string;
  width?: string;
  relation?: string;
  props?: string;
  memUsed?: string;
  diskUsed?: string;
}

/**
 * Parse a single DM operator line:
 *   #NSET2: [cost, rows, width]; props
 *   #HASH2 INNER JOIN: [cost, rows->actual, width]; KEY_NUM(1), MEM_USED(20352KB)
 *   #CSCN2: [cost, rows, width]; INDEX_NAME; btr_scan(1)
 */
function parseDamengPlanLine(line: string): DamengOpInfo | null {
  // Remove leading #
  const content = line.replace(/^#+/, "").trim();

  // Split at first colon
  const colonIdx = content.indexOf(":");
  if (colonIdx < 0) return null;

  const operator = content.substring(0, colonIdx).trim();
  const rest = content.substring(colonIdx + 1).trim();

  // Extract [cost, rows, width] or [cost, estRows->actualRows, width]
  let costPart = "";
  let afterBracket = rest;
  const bracketMatch = rest.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    costPart = bracketMatch[1];
    afterBracket = rest.substring(bracketMatch[0].length).trim();
  }

  // Parse cost part
  let cost: string | undefined;
  let rows: string | undefined;
  let actualRows: string | undefined;
  let width: string | undefined;

  if (costPart) {
    const parts = costPart.split(",").map((s) => s.trim());
    if (parts.length >= 1) cost = parts[0];
    if (parts.length >= 2) {
      const rowPart = parts[1];
      const arrowIdx = rowPart.indexOf("->");
      if (arrowIdx >= 0) {
        rows = rowPart.substring(0, arrowIdx).trim();
        actualRows = rowPart.substring(arrowIdx + 2).trim();
      } else {
        rows = rowPart;
      }
    }
    if (parts.length >= 3) width = parts[2];
  }

  // Extract props after semicolons
  const semiParts = afterBracket
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let relation: string | undefined;
  let memUsed: string | undefined;
  let diskUsed: string | undefined;
  const otherProps: string[] = [];

  for (const part of semiParts) {
    if (/^[A-Za-z_]\w*\(/.test(part) || part.includes("(")) {
      otherProps.push(part);
    } else if (part.toUpperCase().includes("MEM_USED")) {
      const m = part.match(/MEM_USED\((\d+)(KB|MB)\)/i);
      if (m) memUsed = `${m[1]}${m[2]}`;
      otherProps.push(part);
    } else if (part.toUpperCase().includes("DISK_USED")) {
      const m = part.match(/DISK_USED\((\d+)(KB|MB)\)/i);
      if (m) diskUsed = `${m[1]}${m[2]}`;
      otherProps.push(part);
    } else if (!relation && part.length > 0 && part.length < 100 && !part.includes(" ")) {
      relation = part; // likely an index or table name
    } else if (part.length > 0) {
      otherProps.push(part);
    }
  }

  return {
    operation: operator,
    nodeType: operator,
    cost,
    rows,
    actualRows,
    width,
    relation,
    props: otherProps.length > 0 ? otherProps.join("; ") : undefined,
    memUsed,
    diskUsed,
  };
}

export function flattenExplainPlanNodes(nodes: ExplainPlanNode[]): ExplainPlanNode[] {
  const rows: ExplainPlanNode[] = [];
  function visit(node: ExplainPlanNode) {
    rows.push(node);
    node.children.forEach((child) => visit(child));
  }
  nodes.forEach((node) => visit(node));
  return rows;
}

function parseExplainCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ── DM (达梦) tabular explain parser ──────────────────────────────────

interface DamengExplainRow {
  id: string;
  operation: string;
  options: string;
  objectName: string;
  objectType: string;
  cost: string;
  cardinality: string;
  [key: string]: unknown;
}

/**
 * DM's EXPLAIN returns a tabular result set.
 * Columns: EXPLAIN_ID, ID, OPERATION, OPTIONS, OBJECT_NAME, OBJECT_TYPE,
 *          COST, CARDINALITY, CPU_COST, IO_COST, etc.
 * ID is hierarchical dot-notation (1, 2, 2.1, 2.2, 3).
 */
function parseDamengExplain(result: QueryResult): ParsedExplainPlan {
  const colIndex = buildColumnIndex(result.columns);
  const rows: DamengExplainRow[] = result.rows.map((row: unknown[]) => ({
    id: String(row[colIndex.id] ?? ""),
    operation: String(row[colIndex.operation] ?? ""),
    options: String(row[colIndex.options] ?? ""),
    objectName: String(row[colIndex.objectName] ?? ""),
    objectType: String(row[colIndex.objectType] ?? ""),
    cost: String(row[colIndex.cost] ?? ""),
    cardinality: String(row[colIndex.cardinality] ?? ""),
  }));

  const nodes = buildDamengTree(rows);
  return { databaseType: "dameng", raw: rows, nodes };
}

function buildColumnIndex(columns: string[]): Record<string, number> {
  const lower = columns.map((c) => c.toLowerCase());
  const idx = (name: string) => {
    const i = lower.indexOf(name);
    // fallback search for similar names
    if (i >= 0) return i;
    if (name === "id") return lower.findIndex((c) => c === "id" || c === "step" || c === "step_id");
    if (name === "operation") return lower.findIndex((c) => c.includes("operation"));
    if (name === "options") return lower.findIndex((c) => c === "options" || c === "option");
    if (name === "objectName") return lower.findIndex((c) => c.includes("object_name"));
    if (name === "objectType") return lower.findIndex((c) => c.includes("object_type"));
    if (name === "cost") return lower.findIndex((c) => c === "cost" || c === "total_cost");
    if (name === "cardinality") return lower.findIndex((c) => c === "cardinality" || c.includes("cardinality") || c === "rows");
    return -1;
  };
  return {
    id: idx("id"),
    operation: idx("operation"),
    options: idx("options"),
    objectName: idx("objectName"),
    objectType: idx("objectType"),
    cost: idx("cost"),
    cardinality: idx("cardinality"),
  };
}

/**
 * Build a tree from flat DM explain rows using dot-notation ID hierarchy.
 * Root nodes have IDs like "1", "2", "3".
 * Children have IDs like "1.1", "1.2", "2.1.1".
 */
function buildDamengTree(rows: DamengExplainRow[]): ExplainPlanNode[] {
  const nodes: ExplainPlanNode[] = [];

  // First pass: create all nodes
  const nodeMap = new Map<string, ExplainPlanNode>();
  for (const row of rows) {
    const nodeType = [row.operation, row.options].filter(Boolean).join(" ");
    const relation = row.objectName || undefined;
    const index = row.objectType === "INDEX" ? row.objectName : undefined;

    const details: string[] = [];
    if (row.objectType && row.objectType !== "TABLE" && row.objectType !== "INDEX") {
      details.push(`Object Type: ${row.objectType}`);
    }
    if (row.cardinality && row.cardinality !== "0") {
      details.push(`Cardinality: ${row.cardinality}`);
    }

    const node: ExplainPlanNode = {
      id: row.id,
      title: relation ? `${nodeType} on ${relation}` : nodeType || "Plan",
      nodeType: row.operation || "Plan",
      relation,
      index,
      cost: row.cost || undefined,
      rows: row.cardinality || undefined,
      details,
      children: [],
    };
    nodeMap.set(row.id, node);
  }

  // Second pass: build parent-child relationships based on dot notation
  for (const row of rows) {
    const node = nodeMap.get(row.id);
    if (!node) continue;

    const parts = row.id.split(".");
    if (parts.length === 1) {
      // Root-level node
      nodes.push(node);
    } else {
      // Child node: find parent
      const parentId = parts.slice(0, -1).join(".");
      const parent = nodeMap.get(parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan — treat as root
        nodes.push(node);
      }
    }
  }

  // Sort children by their last ID segment (numerically)
  function sortChildren(nodes: ExplainPlanNode[]) {
    for (const n of nodes) {
      sortChildren(n.children);
    }
    nodes.sort((a, b) => {
      const aLast = parseInt(a.id.split(".").pop() || "0", 10);
      const bLast = parseInt(b.id.split(".").pop() || "0", 10);
      return aLast - bLast;
    });
  }
  sortChildren(nodes);

  return nodes;
}

// ── PostgreSQL JSON explain parser ────────────────────────────────────

function parsePostgresExplain(raw: unknown): ExplainPlanNode[] {
  const plans = Array.isArray(raw) ? raw : [raw];
  return plans
    .map((item, index) => {
      const root = objectValue(item);
      if (!root) return null;
      const plan = objectValue(root.Plan) || root;
      return parsePostgresNode(plan, String(index));
    })
    .filter((node): node is ExplainPlanNode => !!node);
}

function parsePostgresNode(plan: Record<string, unknown> | null, id: string): ExplainPlanNode | null {
  if (!plan) return null;
  const nodeType = stringValue(plan["Node Type"]) || "Plan";
  const relation = stringValue(plan["Relation Name"]);
  const index = stringValue(plan["Index Name"]);
  const startupCost = numberLike(plan["Startup Cost"]);
  const totalCost = numberLike(plan["Total Cost"]);
  const rows = numberLike(plan["Plan Rows"]);
  const width = numberLike(plan["Plan Width"]);
  const filter = stringValue(plan.Filter);
  const joinType = stringValue(plan["Join Type"]);
  const sortKey = arrayValue(plan["Sort Key"])?.map(String).join(", ");

  const children =
    arrayValue(plan.Plans)
      ?.map((child, childIndex) => parsePostgresNode(objectValue(child), `${id}.${childIndex}`))
      .filter((node): node is ExplainPlanNode => !!node) ?? [];

  return {
    id,
    title: relation ? `${nodeType} on ${relation}` : nodeType,
    nodeType,
    relation,
    index,
    cost: [startupCost, totalCost].every(Boolean) ? `${startupCost}..${totalCost}` : totalCost,
    rows,
    width,
    details: [joinType ? `Join: ${joinType}` : "", filter ? `Filter: ${filter}` : "", sortKey ? `Sort: ${sortKey}` : ""].filter(Boolean),
    children,
  };
}

// ── MySQL JSON explain parser ─────────────────────────────────────────

function parseMysqlExplain(raw: unknown): ExplainPlanNode[] {
  const root = objectValue(raw);
  if (!root) return [];
  const block = objectValue(root.query_block) || root;
  return [parseMysqlBlock(block, "0", "query_block")];
}

function parseMysqlBlock(block: Record<string, unknown>, id: string, nodeType: string): ExplainPlanNode {
  const costInfo = objectValue(block.cost_info);
  const children: ExplainPlanNode[] = [];

  const table = objectValue(block.table);
  if (table) children.push(parseMysqlTable(table, `${id}.0`));

  const nestedLoop = arrayValue(block.nested_loop);
  if (nestedLoop) {
    nestedLoop.forEach((item) => {
      const itemObject = objectValue(item);
      if (!itemObject) return;
      const nestedTable = objectValue(itemObject.table);
      if (nestedTable) {
        children.push(parseMysqlTable(nestedTable, `${id}.${children.length}`));
        return;
      }
      children.push(parseMysqlBlock(itemObject, `${id}.${children.length}`, "operation"));
    });
  }

  ["ordering_operation", "grouping_operation", "duplicates_removal", "union_result", "materialized_from_subquery"].forEach((key) => {
    const child = objectValue(block[key]);
    if (child) children.push(parseMysqlBlock(child, `${id}.${children.length}`, key));
  });

  return {
    id,
    title: nodeType,
    nodeType,
    cost: stringValue(costInfo?.query_cost),
    rows: numberLike(block.select_id),
    details: [stringValue(block.message)].filter(nonEmptyString),
    children,
  };
}

function parseMysqlTable(table: Record<string, unknown>, id: string): ExplainPlanNode {
  const relation = stringValue(table.table_name);
  const accessType = stringValue(table.access_type) || "table";
  const costInfo = objectValue(table.cost_info);
  const rows = numberLike(table.rows_examined_per_scan) || numberLike(table.rows_produced_per_join);
  const cost = stringValue(costInfo?.query_cost) || stringValue(costInfo?.read_cost) || stringValue(costInfo?.eval_cost);
  const details = [stringValue(table.attached_condition) ? `Condition: ${stringValue(table.attached_condition)}` : "", arrayValue(table.used_columns)?.length ? `Columns: ${arrayValue(table.used_columns)!.map(String).join(", ")}` : "", table.using_index === true ? "Using index" : ""].filter(Boolean);

  return {
    id,
    title: relation ? `${accessType} on ${relation}` : accessType,
    nodeType: accessType,
    relation,
    index: stringValue(table.key),
    cost,
    rows,
    details,
    children: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function nonEmptyString(value: string | undefined): value is string {
  return !!value;
}

function numberLike(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}
