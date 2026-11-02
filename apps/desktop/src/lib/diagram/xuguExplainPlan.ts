import type { QueryResult } from "@/types/database";
import type { ExplainPlanNode, ParsedExplainPlan } from "./explainPlan";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";

/** Xugu EXPLAIN VERBOSE returns plan_path text, as one multiline cell or rows. */
export function parseXuguExplainResult(result: QueryResult): ParsedExplainPlan {
  if (isQueryExecutionErrorResult(result)) {
    throw new Error(String(result.rows[0]?.[0] ?? "XuguDB EXPLAIN failed"));
  }
  const columnIndex = result.columns.findIndex((column) => column.trim().toLowerCase() === "plan_path");
  if (columnIndex < 0) throw new Error("XuguDB EXPLAIN did not return plan_path");
  const raw = result.rows
    .map((row) => row[columnIndex])
    .filter((value) => value !== null && value !== undefined)
    .map(String)
    .join("\n");
  return parseXuguExplainText(raw);
}

export function parseXuguExplainText(raw: string): ParsedExplainPlan {
  const nodes: ExplainPlanNode[] = [];
  const stack: Array<{ indent: number; node: ExplainPlanNode }> = [];
  const byLine = new Map<string, ExplainPlanNode>();
  let inTips = false;
  let lastTipNode: ExplainPlanNode | undefined;
  let section: ExplainPlanNode | undefined;
  let sectionNumber = 0;

  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    // CTE plans contain independent numbered plans; numbering restarts in each
    // With Query(...) / Main Query section, including after a Tips block.
    const heading = line.trim();
    if (/^With Query\(.+\)$/i.test(heading) || /^Main Query$/i.test(heading)) {
      sectionNumber += 1;
      section = { id: `xugu-section-${sectionNumber}`, title: heading, nodeType: heading, dialect: "xugu", costModel: "unknown", details: [], children: [] };
      nodes.push(section);
      stack.length = 0;
      byLine.clear();
      inTips = false;
      lastTipNode = undefined;
      continue;
    }
    if (/^-+\s*Tips\s*-+$/i.test(line.trim())) {
      inTips = true;
      continue;
    }
    if (inTips) {
      const tip = line.match(/^\s*(\d+)\s+(.+)$/);
      if (tip) {
        lastTipNode = byLine.get(tip[1]);
        lastTipNode?.details.push(tip[2].trim());
      } else if (lastTipNode) {
        // Long predicates may wrap onto unnumbered continuation lines.
        lastTipNode.details[lastTipNode.details.length - 1] += `\n${line.trim()}`;
      }
      continue;
    }

    // The printed number identifies a plan line (and its Tips), not a depth.
    // Execution step/branch numbers inside [(...)] are not hierarchy either.
    const match = line.match(/^(\s*)(\d+)([ \t]+)([A-Za-z][A-Za-z0-9_]*(?:[ \t]+[A-Za-z][A-Za-z0-9_]*)*)(.*)$/);
    if (!match) throw new Error(`Unrecognized XuguDB plan line: ${line.trim()}`);
    const [, prefix, lineId, spacing, operator, suffix] = match;
    if (byLine.has(lineId)) throw new Error(`Duplicate XuguDB plan line: ${lineId}`);
    // Native output compensates spaces when line IDs grow from 9 to 10.
    // Compare the operator's column, not just the whitespace after the ID.
    const indent = (prefix + lineId + spacing).replace(/\t/g, "    ").length;
    const relation = planAttribute(suffix, "table");
    const index = planAttribute(suffix, "index");
    const cost = numericAttribute(suffix, "cost");
    const rows = numericAttribute(suffix, "result_num");
    const node: ExplainPlanNode = {
      id: section ? `xugu-${sectionNumber}-${lineId}` : `xugu-${lineId}`,
      title: relation ? `${operator} on ${relation}` : operator,
      nodeType: operator,
      dialect: "xugu",
      relation,
      index,
      cost,
      costModel: "unknown",
      rows,
      // Preserve native step/branch and unrecognized attributes without inventing stats.
      details: suffix.trim() ? [suffix.trim()] : [],
      children: [],
    };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else if (section) section.children.push(node);
    else nodes.push(node);
    stack.push({ indent, node });
    byLine.set(lineId, node);
  }

  if (!nodes.length || nodes.every((node) => node.id.startsWith("xugu-section-") && !node.children.length)) throw new Error("XuguDB EXPLAIN returned no plan nodes");
  return { databaseType: "xugu", raw, nodes };
}

function numericAttribute(source: string, name: string): string | undefined {
  return source.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?=\\s*[,\\]\\)])`, "i"))?.[1];
}

function planAttribute(source: string, name: string): string | undefined {
  // Quoted identifiers may contain parentheses; do not stop inside a quote.
  const match = source.match(new RegExp(`\\(${name}\\s*=\\s*((?:"(?:""|[^"])*"|'(?:''|[^'])*'|[^)])*)\\)`, "i"));
  return match?.[1].trim() || undefined;
}
