import { describe, expect, it } from "vitest";
import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";
import { buildPlanCanvas, categorizePlanNode, edgeStrokeWidth, extractActualRows, formatPlanRows, heatLevel, parsePlanNumber, PLAN_CANVAS_NODE_H, PLAN_CANVAS_NODE_W, PLAN_CANVAS_PAD } from "@/lib/diagram/planCanvas";

function planNode(node: Partial<ExplainPlanNode> & { id: string; nodeType: string }): ExplainPlanNode {
  return { title: node.nodeType, details: [], children: [], ...node };
}

describe("categorizePlanNode", () => {
  const expectations: Array<[string, string[]]> = [
    ["tscan", ["Seq Scan", "ALL", "Full Table Scan", "Table Scan", "Clustered Index Scan", "TABLE ACCESS FULL", "CSCN2"]],
    ["iscan", ["Index Scan", "Index Only Scan", "Bitmap Index Scan", "Bitmap Heap Scan", "Index Seek", "INDEX RANGE SCAN", "INDEX UNIQUE SCAN", "INDEX FULL SCAN", "range", "ref", "SSEK2", "CSEK2", "Clustered Index Seek"]],
    ["lookup", ["Key Lookup", "RID Lookup", "TABLE ACCESS BY INDEX ROWID", "eq_ref", "Unique Key Lookup"]],
    ["join", ["Nested Loop", "Nested Loops", "Hash Join", "Merge Join", "Hash Match", "HASH JOIN", "NESTED LOOPS", "HASH2", "NEST LOOP", "hash join"]],
    ["sort", ["Sort", "Incremental Sort", "filesort", "Filesort", "ordering_operation", "SORT ORDER BY"]],
    ["agg", ["Aggregate", "HashAggregate", "GroupAggregate", "Partial Aggregate", "Stream Aggregate", "grouping_operation", "HASH GROUP BY", "SORT AGGREGATE", "HAGR2", "SAGR2"]],
    ["mat", ["Hash", "Materialize", "CTE Scan", "Table Spool", "Index Spool", "materialized_from_subquery", "TEMP TABLE TRANSFORMATION"]],
    ["xchg", ["Gather", "Gather Merge", "Parallelism", "PX SEND", "PX RECEIVE", "Exchange"]],
    ["mod", ["Insert", "Update", "Delete", "Merge", "Table Insert", "Clustered Index Update"]],
    ["result", ["Result", "Limit", "SELECT", "SELECT STATEMENT", "query_block", "NSET2", "PRJT2", "union_result"]],
  ];

  for (const [category, operators] of expectations) {
    it(`maps every engine's ${category} operators`, () => {
      for (const operator of operators) {
        expect(categorizePlanNode(operator), operator).toBe(category);
      }
    });
  }

  it("falls back to other for unknown operators", () => {
    expect(categorizePlanNode("Compute Scalar")).toBe("other");
    expect(categorizePlanNode("")).toBe("other");
    expect(categorizePlanNode("   ")).toBe("other");
  });

  it("resolves the operators whose names overlap across categories", () => {
    expect(categorizePlanNode("Merge Join")).toBe("join");
    expect(categorizePlanNode("Merge")).toBe("mod");
    expect(categorizePlanNode("Merge Append")).toBe("other");
    expect(categorizePlanNode("Gather Merge")).toBe("xchg");
    expect(categorizePlanNode("Clustered Index Scan")).toBe("tscan");
    expect(categorizePlanNode("Index Scan")).toBe("iscan");
    expect(categorizePlanNode("Index Spool")).toBe("mat");
    expect(categorizePlanNode("eq_ref")).toBe("lookup");
    expect(categorizePlanNode("ref")).toBe("iscan");
    expect(categorizePlanNode("SORT AGGREGATE")).toBe("agg");
    expect(categorizePlanNode("SORT ORDER BY")).toBe("sort");
    expect(categorizePlanNode("HashAggregate")).toBe("agg");
    expect(categorizePlanNode("Hash")).toBe("mat");
    expect(categorizePlanNode("TABLE ACCESS FULL")).toBe("tscan");
    expect(categorizePlanNode("TABLE ACCESS BY INDEX ROWID")).toBe("lookup");
  });
});

describe("parsePlanNumber", () => {
  it("reads plain, grouped and ranged numbers", () => {
    expect(parsePlanNumber("12.34")).toBe(12.34);
    expect(parsePlanNumber("1,234")).toBe(1234);
    expect(parsePlanNumber("42000")).toBe(42000);
    expect(parsePlanNumber("0.29..1830.12")).toBe(1830.12);
  });

  it("applies Oracle-style magnitude suffixes", () => {
    expect(parsePlanNumber("1200K")).toBe(1_200_000);
    expect(parsePlanNumber("96M")).toBe(96_000_000);
    expect(parsePlanNumber("4032K")).toBe(4_032_000);
  });

  it("ignores trailing engine annotations", () => {
    expect(parsePlanNumber("5842 (1)")).toBe(5842);
  });

  it("returns undefined for missing or non-numeric values", () => {
    expect(parsePlanNumber(undefined)).toBeUndefined();
    expect(parsePlanNumber("")).toBeUndefined();
    expect(parsePlanNumber("   ")).toBeUndefined();
    expect(parsePlanNumber("N/A")).toBeUndefined();
    expect(parsePlanNumber("Good Enough Plan Found")).toBeUndefined();
  });
});

describe("extractActualRows", () => {
  it("reads the actual row count out of the detail list", () => {
    expect(extractActualRows(planNode({ id: "1", nodeType: "Sort", details: ["Sort: a", "Actual Rows: 83,911"] }))).toBe(83911);
    expect(extractActualRows(planNode({ id: "1", nodeType: "Sort", details: ["Sort: a"] }))).toBeUndefined();
  });
});

// root(Limit) → Sort → Hash Join → [Seq Scan, Hash → Index Scan]
function postgresPlan(): ExplainPlanNode[] {
  return [
    planNode({
      id: "0",
      nodeType: "Limit",
      cost: "24102.11..24180.37",
      rows: "100",
      children: [
        planNode({
          id: "0.0",
          nodeType: "Sort",
          cost: "24000.00..24102.11",
          rows: "42000",
          details: ["Sort: o.created_at DESC", "Actual Rows: 83911"],
          children: [
            planNode({
              id: "0.0.0",
              nodeType: "Hash Join",
              cost: "0.29..23800.00",
              rows: "42000",
              children: [
                planNode({ id: "0.0.0.0", nodeType: "Seq Scan", relation: "orders", cost: "0.00..18000.00", rows: "1200000" }),
                planNode({
                  id: "0.0.0.1",
                  nodeType: "Hash",
                  cost: "0.29..1200.00",
                  rows: "18500",
                  children: [planNode({ id: "0.0.0.1.0", nodeType: "Index Scan", relation: "customers", index: "idx_customers_region", cost: "0.29..1100.00", rows: "18500" })],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ];
}

describe("buildPlanCanvas", () => {
  const layout = buildPlanCanvas(postgresPlan());

  it("places every node once and connects each non-root to its parent", () => {
    expect(layout.nodes).toHaveLength(6);
    expect(layout.edges).toHaveLength(layout.nodes.length - 1);
    expect(layout.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it("grows to the right and centers a parent between its children", () => {
    const byType = new Map(layout.nodes.map((node) => [node.node.nodeType, node]));
    const root = byType.get("Limit")!;
    const join = byType.get("Hash Join")!;
    const seqScan = byType.get("Seq Scan")!;
    const hash = byType.get("Hash")!;

    expect(root.x).toBe(PLAN_CANVAS_PAD);
    expect(root.x).toBeLessThan(byType.get("Sort")!.x);
    expect(byType.get("Sort")!.x).toBeLessThan(join.x);
    expect(join.y).toBe((seqScan.y + hash.y) / 2);
    expect(hash.y).toBe(byType.get("Index Scan")!.y);
  });

  it("keeps every card clear of every other card", () => {
    for (const first of layout.nodes) {
      for (const second of layout.nodes) {
        if (first === second) continue;
        const overlaps = Math.abs(first.x - second.x) < PLAN_CANVAS_NODE_W && Math.abs(first.y - second.y) < PLAN_CANVAS_NODE_H;
        expect(overlaps, `${first.node.nodeType} overlaps ${second.node.nodeType}`).toBe(false);
      }
    }
  });

  it("sizes the canvas so it covers every card", () => {
    for (const node of layout.nodes) {
      expect(node.x + PLAN_CANVAS_NODE_W).toBeLessThanOrEqual(layout.width);
      expect(node.y + PLAN_CANVAS_NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it("splits the cumulative cost into self-cost shares that sum to one", () => {
    const shares = layout.nodes.map((node) => node.costShare);
    expect(shares.every((share) => share !== undefined)).toBe(true);
    expect(shares.reduce((total, share) => total + (share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it("clamps a self-cost below zero when a child reports more than its parent", () => {
    const clamped = buildPlanCanvas([
      planNode({
        id: "0",
        nodeType: "Limit",
        cost: "10",
        children: [planNode({ id: "0.0", nodeType: "Seq Scan", cost: "40" })],
      }),
    ]);
    const [root, child] = clamped.nodes;
    expect(root.costShare).toBe(0);
    expect(child.costShare).toBe(1);
  });

  it("leaves the cost share undefined when no node reports a numeric cost", () => {
    const costless = buildPlanCanvas([planNode({ id: "0", nodeType: "Plan", children: [planNode({ id: "0.0", nodeType: "Plan" })] })]);
    expect(costless.nodes.every((node) => node.costShare === undefined)).toBe(true);
  });

  it("stacks multiple roots vertically", () => {
    const twoRoots = buildPlanCanvas([planNode({ id: "0", nodeType: "Limit" }), planNode({ id: "1", nodeType: "Limit" })]);
    expect(twoRoots.nodes[0].x).toBe(twoRoots.nodes[1].x);
    expect(twoRoots.nodes[1].y - twoRoots.nodes[0].y).toBeGreaterThanOrEqual(PLAN_CANVAS_NODE_H);
  });

  it("returns an empty canvas for an empty plan", () => {
    expect(buildPlanCanvas([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("carries the parsed row counts onto nodes and edges", () => {
    const seqScan = layout.nodes.find((node) => node.node.nodeType === "Seq Scan")!;
    expect(seqScan.rows).toBe(1_200_000);
    expect(layout.edges.find((edge) => edge.to === seqScan)?.rows).toBe(1_200_000);
    expect(layout.nodes.find((node) => node.node.nodeType === "Sort")!.actualRows).toBe(83911);
  });
});

describe("heatLevel", () => {
  it("maps a share onto the four heat steps", () => {
    expect(heatLevel(undefined)).toBe("none");
    expect(heatLevel(0)).toBe("cool");
    expect(heatLevel(0.049)).toBe("cool");
    expect(heatLevel(0.05)).toBe("warm");
    expect(heatLevel(0.2)).toBe("warm");
    expect(heatLevel(0.201)).toBe("hot");
    expect(heatLevel(1)).toBe("hot");
  });
});

describe("edgeStrokeWidth", () => {
  it("scales with the row count inside a fixed range", () => {
    expect(edgeStrokeWidth(undefined)).toBe(1.6);
    expect(edgeStrokeWidth(0)).toBe(1.6);
    expect(edgeStrokeWidth(100)).toBeCloseTo(1.6 + Math.log10(101) * 1.05, 10);
    expect(edgeStrokeWidth(1e12)).toBe(8);
    expect(edgeStrokeWidth(1e6)).toBeGreaterThan(edgeStrokeWidth(1e3));
  });
});

describe("formatPlanRows", () => {
  it("shortens large counts and marks unknown ones", () => {
    expect(formatPlanRows(undefined)).toBe("—");
    expect(formatPlanRows(Number.NaN)).toBe("—");
    expect(formatPlanRows(100)).toBe("100");
    expect(formatPlanRows(999)).toBe("999");
    expect(formatPlanRows(84_200)).toBe("84.2K");
    expect(formatPlanRows(1_000)).toBe("1K");
    expect(formatPlanRows(1_200_000)).toBe("1.2M");
    expect(formatPlanRows(1_000_000)).toBe("1M");
  });
});
