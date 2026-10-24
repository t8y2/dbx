import { describe, expect, it } from "vitest";
import { parseExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

function textPlanResult(lines: string[]): QueryResult {
  return { columns: ["QUERY PLAN"], rows: lines.map((line) => [line]), affected_rows: 0, execution_time_ms: 1 };
}

describe("openGauss explain plan (#13055)", () => {
  it("supports the opengauss database type", () => {
    expect(supportsExplainPlan("opengauss")).toBe(true);
  });

  it("builds a tree from indented text plan rows", () => {
    const result = parseExplainResult("opengauss", textPlanResult(["Data Node Scan  (cost=0.00..0.00 rows=10 width=4)", "  Node/s: All datanodes", "  ->  Seq Scan on t  (cost=0.00..14.10 rows=410 width=4)"]));

    expect(result.databaseType).toBe("opengauss");
    expect(result.nodes).toHaveLength(1);
    const root = result.nodes[0]!;
    expect(root.title).toContain("Data Node Scan");
    expect(root.children).toHaveLength(2);
    expect(root.children[0]!.title).toBe("Node/s: All datanodes");
    expect(root.children[0]!.children).toHaveLength(0);
    expect(root.children[1]!.title).toContain("Seq Scan on t");
  });

  it("keeps consecutive same-indent detail lines as siblings under their node", () => {
    // PG-style plans put a node's detail lines several levels under the `->` row;
    // consecutive same-indent lines must stay siblings, not chain parent→child.
    const result = parseExplainResult("opengauss", textPlanResult(["Nested Loop  (cost=0.00..1.00 rows=1 width=4)", "  ->  Seq Scan on a  (cost=0.00..1.00 rows=1 width=4)", "        Filter: (id = 1)", "        Rows Removed by Filter: 3"]));

    const seqScan = result.nodes[0]!.children[0]!;
    expect(seqScan.title).toContain("Seq Scan on a");
    expect(seqScan.children).toHaveLength(2);
    expect(seqScan.children[0]!.title).toBe("Filter: (id = 1)");
    expect(seqScan.children[1]!.title).toBe("Rows Removed by Filter: 3");
    expect(seqScan.children[0]!.children).toHaveLength(0);
  });

  it("keeps top-level rows as siblings", () => {
    const result = parseExplainResult("opengauss", textPlanResult(["Seq Scan on a  (cost=0.00..1.00 rows=1 width=4)", "Seq Scan on b  (cost=0.00..2.00 rows=2 width=4)"]));
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]!.children).toHaveLength(0);
    expect(result.nodes[1]!.children).toHaveLength(0);
  });
});
