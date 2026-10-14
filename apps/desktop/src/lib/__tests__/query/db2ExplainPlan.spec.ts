import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { flattenExplainPlanNodes, parseDb2ExplainText, parseExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import { buildPlanCanvas, categorizePlanNode } from "@/lib/diagram/planCanvas";
import { explainPlanExportRows } from "@/lib/export/explainPlanExport";

const base = () => ({
  version: 1,
  databaseType: "db2",
  requestTag: "dbx8834test",
  operators: [
    { id: "1", type: "RETURN", totalCost: "12.34567890123456789" },
    { id: "2", type: "HSJOIN", totalCost: "12" },
    { id: "3", type: "TBSCAN", totalCost: "0" },
    { id: "4", type: "FETCH" },
    { id: "5", type: "IXSCAN", ioCost: "1.5", cpuCost: "0.25", firstRowCost: "0.5" },
  ],
  streams: [
    { id: "1", sourceType: "O", sourceId: "2", targetType: "O", targetId: "1", rowCount: "2.25" },
    { id: "2", sourceType: "O", sourceId: "3", targetType: "O", targetId: "2", rowCount: "9007199254740993" },
    { id: "3", sourceType: "O", sourceId: "4", targetType: "O", targetId: "2", rowCount: "10" },
    { id: "4", sourceType: "O", sourceId: "5", targetType: "O", targetId: "4", rowCount: "10" },
    { id: "5", sourceType: "D", sourceId: "-1", targetType: "O", targetId: "3", objectSchema: "APP_A", objectName: "ORDERS" },
    { id: "6", sourceType: "D", sourceId: "-1", targetType: "O", targetId: "5", objectSchema: "APP_A", objectName: "CUSTOMERS_IDX" },
  ],
  predicates: [{ operatorId: "2", text: '"O"."CUSTOMER_ID" = "C"."ID"', howApplied: "JOIN" }],
  arguments: [{ operatorId: "5", type: "SCAN_DIRECTION", value: "FORWARD" }],
});

function edge(id: string, sourceId: string, targetId: string) {
  return { id, sourceType: "O", sourceId, targetType: "O", targetId };
}

describe("DB2 native explain plans", () => {
  it("enables the registered capability", () => {
    expect(supportsExplainPlan("db2")).toBe(true);
  });

  it("builds the consumer hierarchy, attaches objects, and preserves decimal/bigint estimates", () => {
    const raw = JSON.stringify(base(), null, 2);
    const plan = parseDb2ExplainText(raw);
    expect(plan.raw).toBe(raw);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]).toMatchObject({ id: "db2-operator-1", nodeType: "RETURN", cost: "12.34567890123456789 timerons", costModel: "unknown" });
    expect(plan.nodes[0].rows).toBeUndefined();
    const join = plan.nodes[0].children[0];
    expect(join.nodeType).toBe("HSJOIN");
    expect(join.rows).toBe("2.25");
    expect(join.details).toContain('Predicate (JOIN): "O"."CUSTOMER_ID" = "C"."ID"');
    expect(join.children.map((node) => node.nodeType)).toEqual(["TBSCAN", "FETCH"]);
    expect(join.children[0]).toMatchObject({ relation: "APP_A.ORDERS", rows: "9007199254740993", cost: "0 timerons" });
    expect(join.children[1].children[0]).toMatchObject({ index: "APP_A.CUSTOMERS_IDX", details: ["I/O Cost: 1.5 page I/Os", "CPU Cost: 0.25 instructions", "First Row Cost: 0.5 timerons", "Object: APP_A.CUSTOMERS_IDX", "SCAN_DIRECTION: FORWARD"] });
    expect(flattenExplainPlanNodes(plan.nodes).every((node) => node.estimatedTimeUs === undefined)).toBe(true);
  });

  it("parses a real DB2 LUW 11.5.9 Agent plan with a shared TEMP input", () => {
    const raw = readFileSync(new URL("./fixtures/db2-shared-temp-plan.json", import.meta.url), "utf8");
    const plan = parseDb2ExplainText(raw);
    const join = plan.nodes[0].children[0];
    expect(plan.raw).toBe(raw);
    expect(plan.nodes[0].nodeType).toBe("RETURN");
    expect(join).toMatchObject({ nodeType: "MSJOIN", rows: "0.0015999999595806003" });
    expect(join.children.map((node) => node.id)).toEqual(["db2-operator-3", "db2-operator-7"]);
    expect(join.children[0].children[0]).toMatchObject({ id: "db2-operator-4", nodeType: "TEMP", rows: "1.0" });
    expect(join.children[0].children[0].children[0]).toMatchObject({ nodeType: "TBSCAN", relation: "SYSIBM.GENROW", cost: "1.1336263924022205E-5 timerons" });
    expect(join.children[1].children[0]).toMatchObject({ id: "db2-reference-5", nodeType: "TEMP", children: [] });
    expect(join.details).toContain("CPU Cost: 94451.4375 instructions");
    expect(flattenExplainPlanNodes(plan.nodes)).toHaveLength(7);
    expect(buildPlanCanvas(plan.nodes).nodes.every((node) => node.costShare === undefined)).toBe(true);
  });

  it("preserves whitespace and punctuation in quoted object identifiers", () => {
    const payload = base();
    payload.streams[4].objectSchema = " Odd Schema ";
    payload.streams[4].objectName = ' Orders"Archive ';
    const plan = parseDb2ExplainText(JSON.stringify(payload));
    expect(plan.nodes[0].children[0].children[0].relation).toBe(' Odd Schema . Orders"Archive ');
  });

  it("uses the same native parser for serialized QueryResult entry points", () => {
    const raw = JSON.stringify(base());
    expect(parseExplainResult("db2", { columns: ["plan"], rows: [[raw]], affected_rows: 0, execution_time_ms: 0 }).raw).toBe(raw);
  });

  it("projects a shared subtree once and keeps disconnected roots and unknown operators", () => {
    const payload = {
      ...base(),
      operators: [
        { id: "1", type: "RETURN" },
        { id: "2", type: "RETURN" },
        { id: "3", type: "CUSTOM_OPERATOR" },
        { id: "4", type: "TBSCAN" },
      ],
      streams: [edge("a", "3", "1"), edge("b", "3", "2"), edge("c", "4", "3")],
      predicates: [],
      arguments: [],
    };
    const plan = parseDb2ExplainText(JSON.stringify(payload));
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0].children[0].children).toHaveLength(1);
    expect(plan.nodes[1].children[0]).toMatchObject({ id: "db2-reference-b", nodeType: "CUSTOM_OPERATOR", children: [] });
    expect(plan.nodes[1].children[0].details).toContain("Reference to operator 3");
    expect(new Set(flattenExplainPlanNodes(plan.nodes).map((node) => node.id)).size).toBe(5);
  });

  it("does not invent estimates for malformed numbers or conflicting output streams", () => {
    const payload = base();
    payload.operators[0].totalCost = "N/A";
    payload.streams[0].rowCount = "NaN";
    payload.streams.push({ ...payload.streams[1], id: "7", rowCount: "1" });
    const plan = parseDb2ExplainText(JSON.stringify(payload));
    expect(plan.nodes[0].cost).toBeUndefined();
    expect(plan.nodes[0].children[0].rows).toBeUndefined();
    expect(plan.nodes[0].children[0].children[0].rows).toBeUndefined();
    expect(plan.nodes[0].children[0].children).toHaveLength(2);
  });

  it("accepts an operator-only plan without fabricating rows or time", () => {
    const plan = parseDb2ExplainText(JSON.stringify({ ...base(), operators: [{ id: "999999999999999999", type: "UNKNOWN" }], streams: [], predicates: [], arguments: [] }));
    expect(plan.nodes[0]).toMatchObject({ id: "db2-operator-999999999999999999", nodeType: "UNKNOWN", cost: undefined, children: [] });
    expect(plan.nodes[0].rows).toBeUndefined();
  });

  it("reuses canvas categories and exports costs with their units without fake heat", () => {
    const plan = parseDb2ExplainText(JSON.stringify(base()));
    const canvas = buildPlanCanvas(plan.nodes);
    expect(canvas.nodes.map((node) => node.category)).toEqual(["result", "join", "tscan", "lookup", "iscan"]);
    expect(canvas.nodes.every((node) => node.costShare === undefined && node.actualRows === undefined)).toBe(true);
    expect(explainPlanExportRows(plan.nodes, "Estimated time")[0][3]).toBe("12.34567890123456789 timerons");
    for (const [operator, category] of [
      ["NLJOIN", "join"],
      ["MSJOIN", "join"],
      ["SORT", "sort"],
      ["GRPBY", "agg"],
      ["TEMP", "mat"],
      ["TQUEUE", "xchg"],
    ])
      expect(categorizePlanNode(operator, "db2")).toBe(category);
  });

  it.each(["", "[]", "not JSON", "null"])("rejects invalid plan %s", (raw) => {
    expect(() => parseDb2ExplainText(raw)).toThrow("DB2 EXPLAIN:");
  });

  it.each([
    [{ version: 2 }, "unsupported plan version"],
    [{ databaseType: "mysql" }, "invalid database type"],
    [{ requestTag: "" }, "request tag"],
    [{ operators: [] }, "no plan operators"],
    [
      {
        operators: [
          { id: "1", type: "RETURN" },
          { id: "1", type: "TBSCAN" },
        ],
      },
      "duplicate operator",
    ],
    [{ operators: [{ type: "RETURN" }] }, "operator ID"],
    [{ streams: [edge("1", "missing", "1")] }, "dangling operator"],
    [{ streams: [edge("1", "2", "1"), edge("1", "3", "1")] }, "duplicate stream"],
    [{ streams: [edge("1", "2", "1"), edge("2", "1", "2")] }, "cycle"],
    [{ streams: [edge("1", "4", "3"), edge("2", "3", "4")] }, "cycle"],
    [{ predicates: [{ operatorId: "missing", text: "ID = 1" }] }, "dangling operator"],
  ])("rejects malformed graph %j", (override, message) => {
    expect(() => parseDb2ExplainText(JSON.stringify({ ...base(), ...override }))).toThrow(message);
  });

  it("bounds depth and operator count before the viewer recurses", () => {
    const operators = Array.from({ length: 130 }, (_, id) => ({ id: String(id), type: "SORT" }));
    const streams = operators.slice(1).map((operator, index) => edge(String(index), operator.id, String(index)));
    expect(() => parseDb2ExplainText(JSON.stringify({ ...base(), operators, streams, predicates: [], arguments: [] }))).toThrow("supported depth");
    expect(() => parseDb2ExplainText(JSON.stringify({ ...base(), operators: Array.from({ length: 2001 }, (_, id) => ({ id: String(id), type: "TBSCAN" })) }))).toThrow("supported size");
  });
});
