import { describe, expect, it } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult } from "@/lib/diagram/explainPlan";
import { extractActualRows } from "@/lib/diagram/planCanvas";
import type { QueryResult } from "@/types/database";

function explainResult(plan: unknown): QueryResult {
  return { columns: ["QUERY PLAN"], rows: [[JSON.stringify(plan)]], affected_rows: 0, execution_time_ms: 1 };
}

const ANALYZE_PLAN = [
  {
    Plan: {
      "Node Type": "Sort",
      "Startup Cost": 24000.0,
      "Total Cost": 24102.11,
      "Plan Rows": 42000,
      "Plan Width": 96,
      "Actual Startup Time": 812.44,
      "Actual Total Time": 851.09,
      "Actual Rows": 84000,
      "Actual Loops": 1,
      "Sort Key": ["o.created_at DESC"],
      Plans: [
        {
          "Node Type": "Hash Join",
          "Join Type": "Inner",
          "Startup Cost": 0.29,
          "Total Cost": 23800.0,
          "Plan Rows": 42000,
          "Actual Startup Time": 12.5,
          "Actual Total Time": 700.25,
          "Actual Rows": 84000,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              "Startup Cost": 0.0,
              "Total Cost": 18000.0,
              "Plan Rows": 1200000,
              Filter: "(created_at >= '2026-01-01'::date)",
              "Actual Startup Time": 0.011,
              "Actual Total Time": 402.9,
              "Actual Rows": 1187423,
              "Actual Loops": 1,
            },
            {
              "Node Type": "Index Scan",
              "Relation Name": "customers",
              "Index Name": "idx_customers_region",
              "Startup Cost": 0.29,
              "Total Cost": 1100.0,
              "Plan Rows": 18500,
              "Actual Startup Time": 0.02,
              "Actual Total Time": 0.31,
              "Actual Rows": 5,
              "Actual Loops": 3700,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.482,
    "Execution Time": 862.104,
  },
];

const PLAIN_PLAN = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      "Startup Cost": 0.0,
      "Total Cost": 18000.0,
      "Plan Rows": 1200000,
      "Plan Width": 96,
    },
  },
];

describe("PostgreSQL EXPLAIN ANALYZE parsing", () => {
  const parsed = parseExplainResult("postgres", explainResult(ANALYZE_PLAN));
  const nodes = flattenExplainPlanNodes(parsed.nodes);
  const byType = new Map(nodes.map((node) => [node.nodeType, node]));

  it("keeps the existing tree shape and cost/rows fields", () => {
    expect(parsed.databaseType).toBe("postgres");
    expect(nodes).toHaveLength(4);
    expect(byType.get("Sort")?.cost).toBe("24000..24102.11");
    expect(byType.get("Seq Scan")?.relation).toBe("orders");
    expect(byType.get("Index Scan")?.index).toBe("idx_customers_region");
  });

  it("records measured rows in the shared 'Actual Rows' detail convention", () => {
    expect(byType.get("Sort")?.details).toContain("Actual Rows: 84000");
    expect(byType.get("Seq Scan")?.details).toContain("Actual Rows: 1187423");
    expect(byType.get("Index Scan")?.details).toContain("Actual Rows: 5");
  });

  it("reports loops only when the node ran more than once", () => {
    expect(byType.get("Index Scan")?.details).toContain("Actual Loops: 3700");
    expect(byType.get("Sort")?.details.some((detail) => detail.startsWith("Actual Loops"))).toBe(false);
    expect(byType.get("Seq Scan")?.details.some((detail) => detail.startsWith("Actual Loops"))).toBe(false);
  });

  it("records the per-node timing range", () => {
    expect(byType.get("Sort")?.details).toContain("Actual Time: 812.44..851.09 ms");
    expect(byType.get("Seq Scan")?.details).toContain("Actual Time: 0.011..402.9 ms");
  });

  it("puts planning and execution time on the root node only", () => {
    expect(parsed.nodes[0].details).toContain("Planning Time: 0.482 ms");
    expect(parsed.nodes[0].details).toContain("Execution Time: 862.104 ms");
    expect(byType.get("Seq Scan")?.details.some((detail) => detail.startsWith("Execution Time"))).toBe(false);
  });

  it("keeps the engine-native details ahead of the measured ones", () => {
    expect(byType.get("Hash Join")?.details[0]).toBe("Join: Inner");
    expect(byType.get("Seq Scan")?.details[0]).toBe("Filter: (created_at >= '2026-01-01'::date)");
  });

  it("feeds the plan canvas mismatch detection", () => {
    const sort = byType.get("Sort")!;
    expect(extractActualRows(sort)).toBe(84000);
    // 84000 measured against 42000 estimated is exactly the 2x mismatch threshold.
    expect(extractActualRows(sort)! / Number(sort.rows)).toBe(2);
    expect(extractActualRows(byType.get("Index Scan")!)).toBe(5);
  });
});

describe("PostgreSQL plain EXPLAIN parsing", () => {
  it("adds no ANALYZE details when the plan has no measured fields", () => {
    const parsed = parseExplainResult("postgres", explainResult(PLAIN_PLAN));
    const [root] = parsed.nodes;

    expect(root.details).toEqual([]);
    expect(extractActualRows(root)).toBeUndefined();
    expect(root.cost).toBe("0..18000");
    expect(root.rows).toBe("1200000");
  });
});
