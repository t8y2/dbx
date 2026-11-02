import { describe, expect, it } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import { parseXuguExplainText } from "@/lib/diagram/xuguExplainPlan";
import { buildPlanCanvas, categorizePlanNode } from "@/lib/diagram/planCanvas";
import type { QueryResult } from "@/types/database";

const PLAN = `1   LimitScan[(9 1) cost=0,result_num=1]
2     Sort[(7 1) cost=0,result_num=1]
3       HashGroup[(5 1) cost=0,result_num=1]
4         IndexJoin[(4 1) cost=210,result_num=2]
5           BtIdxScan[(2 1) cost=300,result_num=1](table=TAB_HINT_1)(index=IDX_HINT)
6           SeqScan[(1 2) cost=0,result_num=1](table=TAB_HINT_2)
-----------------------Tips--------------------------
4   join_filter: (TAB_HINT_1.ID)=(TAB_HINT_2.ID)
5   scan_filter: (TAB_HINT_1.ID)=(3)
6   scan_filter: (TAB_HINT_2.ID)=(3)`;

function result(rows: unknown[][], columns = ["plan_path"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("Xugu estimated explain plan", () => {
  it("is enabled by the Xugu capability only, without enabling unrelated engines", () => {
    expect(supportsExplainPlan("xugu")).toBe(true);
    for (const type of ["mysql", "postgres", "dameng", "questdb", "doris", "oracle", "oceanbase-oracle", "sqlserver"] as const) expect(supportsExplainPlan(type), type).toBe(true);
    expect(supportsExplainPlan("redis")).toBe(false);
    expect(supportsExplainPlan(undefined)).toBe(false);
  });

  it.each(["cell", "rows"])("parses the %s transport without JSON decoding", (transport) => {
    const parsed = parseExplainResult("xugu", result(transport === "cell" ? [[PLAN]] : PLAN.split("\n").map((line) => [line])));
    expect(parsed.raw).toBe(PLAN);
    expect(parsed.databaseType).toBe("xugu");
    const flat = flattenExplainPlanNodes(parsed.nodes);
    expect(flat.map((node) => node.nodeType)).toEqual(["LimitScan", "Sort", "HashGroup", "IndexJoin", "BtIdxScan", "SeqScan"]);
    expect(parsed.nodes).toHaveLength(1);
    const join = flat[3];
    expect(join.children.map((node) => node.id)).toEqual(["xugu-5", "xugu-6"]);
    expect(join.details).toContain("join_filter: (TAB_HINT_1.ID)=(TAB_HINT_2.ID)");
    expect(flat[4]).toMatchObject({ relation: "TAB_HINT_1", index: "IDX_HINT", cost: "300", rows: "1" });
    expect(flat[4].details).toContain("scan_filter: (TAB_HINT_1.ID)=(3)");
    expect(flat[5].cost).toBe("0");
    expect(flat.some((node) => node.details.some((detail) => detail.startsWith("Actual Rows:")))).toBe(false);
  });

  it("accepts the live DUAL plan with no metrics", () => {
    const [node] = parseExplainResult("xugu", result([["1   VTScan\n\n"]])).nodes;
    expect(node.nodeType).toBe("VTScan");
    expect(node.cost).toBeUndefined();
    expect(node.rows).toBeUndefined();
    expect(node.estimatedTimeUs).toBeUndefined();
  });

  it("parses a live catalog plan and preserves wrapped predicates", () => {
    const raw = `1   Sort[(3 1) cost=304,result_num=3]\r\n2     BtIdxScan[(1 1) cost=300,result_num=3](table=SYS_TABLES)(index=TAB_IDX1)\r\n-----------------------Tips--------------------------\r\n2   scan_filter: (TABLE_NAME)LIKE('TEST%')\r\n    AND CHECK_AUTH(TABLE_ID)\r\n`;
    const parsed = parseXuguExplainText(raw);
    expect(parsed.raw).toBe(raw);
    expect(parsed.nodes[0].children[0].details).toContain("scan_filter: (TABLE_NAME)LIKE('TEST%')\nAND CHECK_AUTH(TABLE_ID)");
    expect(parsed.nodes[0].cost).toBe("304");
  });

  it("finds plan_path case insensitively and ignores NULL cells", () => {
    expect(
      parseExplainResult(
        "xugu",
        result(
          [
            [null, "1   VTScan"],
            [42, null],
          ],
          ["other", "PLAN_PATH"],
        ),
      ).nodes[0].nodeType,
    ).toBe("VTScan");
  });

  it("preserves quoted identifiers and decimal/scientific estimates", () => {
    const [node] = parseXuguExplainText('1   BtIdxScan[(1 1) cost=1.25e+3,result_num=0](table="模式"."订单(历史)")(index="idx""quoted")').nodes;
    expect(node).toMatchObject({ relation: '"模式"."订单(历史)"', index: '"idx""quoted"', cost: "1.25e+3", rows: "0" });
  });

  it("uses indentation rather than printed or execution numbers", () => {
    const parsed = parseXuguExplainText("9   IndexJoin[(1 2) cost=1,result_num=1]\n10    SeqScan[(99 1)]\n11    FutureScan[(3 2)]\n12  VTScan");
    expect(parsed.nodes.map((node) => node.id)).toEqual(["xugu-9", "xugu-12"]);
    expect(parsed.nodes[0].children.map((node) => node.id)).toEqual(["xugu-10", "xugu-11"]);
    expect(categorizePlanNode(parsed.nodes[0].children[1].nodeType)).toBe("other");
  });

  it("preserves live CTE sections, restarted IDs and section-local Tips", () => {
    const raw = `With Query(Q)
1   HashJoin[(4 1) cost=3900,result_num=1600]
2     SeqScan[(3 1) cost=1000,result_num=500](table=SYS_OBJECTS)
3     BtIdxScan[(1 2) cost=300,result_num=320](table=SYS_TABLES)(index=TAB_IDX2)
-----------------------Tips--------------------------
1   join_filter: CTE_PREDICATE

Main Query
1   LimitScan[(25 1) cost=37,result_num=10]
2     Sort[(23 1) cost=152,result_num=41]
3       HashGroup[(21 1) cost=0,result_num=41]
4         HashJoin[(20 1) cost=8160,result_num=41]
5           HashJoin[(19 1) cost=6224,result_num=256]
6             WithRef[(18 1) cost=1600,result_num=1600](WithQry=Q)
7             SubQuery[(17 2) cost=1344,result_num=16]
8               IndexJoin[(16 1) cost=972,result_num=16]
9                 BtIdxScan[(14 1) cost=1000,result_num=500](table=SYS_OBJECTS)(index=OBJ_IDX2)
10                BtIdxScan[(12 2) cost=300,result_num=3](table=SYS_TABLES)(index=TAB_IDX2)
11          SubQuery[(11 2) cost=1344,result_num=16]
12            IndexJoin[(10 1) cost=972,result_num=16]
13              BtIdxScan[(8 1) cost=1000,result_num=500](table=SYS_OBJECTS)(index=OBJ_IDX2)
14              BtIdxScan[(6 2) cost=300,result_num=3](table=SYS_TABLES)(index=TAB_IDX2)
-----------------------Tips--------------------------
4   join_filter: MAIN_PREDICATE`;
    const plan = parseXuguExplainText(raw);
    expect(plan.nodes.map((node) => node.title)).toEqual(["With Query(Q)", "Main Query"]);
    expect(plan.nodes[0].children[0].details).toContain("join_filter: CTE_PREDICATE");
    const flat = flattenExplainPlanNodes(plan.nodes);
    expect(flat).toHaveLength(19);
    expect(new Set(flat.map((node) => node.id)).size).toBe(19);
    expect(flat.find((node) => node.id === "xugu-2-4")?.details).toContain("join_filter: MAIN_PREDICATE");
    expect(flat.find((node) => node.id === "xugu-2-8")?.children.map((node) => node.id)).toEqual(["xugu-2-9", "xugu-2-10"]);
    expect(flat.find((node) => node.id === "xugu-2-4")?.children.map((node) => node.id)).toEqual(["xugu-2-5", "xugu-2-11"]);
    expect(plan.raw).toBe(raw);
  });

  it("preserves multiword operators and rejects heading-only plans", () => {
    expect(parseXuguExplainText("1   Union All[(11 1) cost=15800,result_num=3200]\n2     SubQuery[(5 1)]").nodes[0].nodeType).toBe("Union All");
    expect(() => parseXuguExplainText("With Query(Q)\nMain Query")).toThrow("no plan nodes");
  });

  it("maps Xugu operators and keeps unknown operators visible", () => {
    const categories = buildPlanCanvas(parseXuguExplainText(PLAN).nodes).nodes.map((node) => node.category);
    expect(categories).toEqual(["result", "sort", "agg", "join", "iscan", "tscan"]);
    for (const operator of ["SeqScan", "VTScan", "BtIdxScan", "BitmapScan", "HashJoin", "HashGroup"]) {
      expect(categorizePlanNode(operator, "xugu"), operator).not.toBe("other");
      expect(categorizePlanNode(operator, "postgres"), operator).toBe("other");
      expect(categorizePlanNode(operator, "mysql"), operator).toBe("other");
    }
  });

  it("does not invent cumulative-cost shares or actual stats for Xugu", () => {
    const canvas = buildPlanCanvas(parseXuguExplainText(PLAN).nodes);
    expect(canvas.edges).toHaveLength(5);
    expect(canvas.nodes.every((node) => node.costShare === undefined && node.actualRows === undefined)).toBe(true);
    expect(canvas.nodes[4].node.cost).toBe("300");
    expect(canvas.nodes[4].rows).toBe(1);
    const [postgres] = buildPlanCanvas([{ id: "pg", title: "Seq Scan", nodeType: "Seq Scan", cost: "300", children: [], details: [] }]).nodes;
    expect(postgres.costShare).toBe(1);
  });

  it.each(["", "\n\r\n", "not an execution plan", "1 VTScan\n1 SeqScan"])("rejects empty or malformed plans: %j", (text) => {
    expect(() => parseXuguExplainText(text)).toThrow();
  });

  it("surfaces explicit query errors rather than drawing a successful empty plan", () => {
    expect(() => parseExplainResult("xugu", { ...result([["[E1007] permission denied"]], ["Error"]), execution_error: true })).toThrow("[E1007] permission denied");
    expect(() => parseExplainResult("xugu", result([["data"]], ["other"]))).toThrow("plan_path");
    expect(() => parseExplainResult("xugu", result([]))).toThrow("no plan nodes");
  });
});
