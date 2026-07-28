import { DOMParser } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult, sqlServerExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

const SHOWPLAN_XML = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
    <RelOp NodeId="0" PhysicalOp="Sort" LogicalOp="Sort" EstimateRows="2" EstimatedTotalSubtreeCost="0.029466" AvgRowSize="36">
      <Sort>
        <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedRowsRead="4" EstimateIO="0.003125" EstimateCPU="0.0001581" EstimatedTotalSubtreeCost="0.0034412" AvgRowSize="16">
          <IndexScan>
            <Object Database="[dbx_explain_plan_test]" Schema="[dbo]" Table="[orders]" Index="[ix_orders_customer_status]" />
            <SeekPredicates><SeekPredicateNew><SeekKeys><Prefix>
              <RangeExpressions><ScalarOperator ScalarString="[orders].[status]='paid'" /></RangeExpressions>
            </Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>
          </IndexScan>
        </RelOp>
      </Sort>
    </RelOp>
  </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("SQL Server explain plan", () => {
  beforeEach(() => {
    vi.stubGlobal("DOMParser", DOMParser);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is enabled by the driver capability manifest", () => {
    expect(supportsExplainPlan("sqlserver")).toBe(true);
  });

  it("parses SHOWPLAN XML into its operator hierarchy", () => {
    const planResult = result(["Microsoft SQL Server 2005 XML Showplan"], [[SHOWPLAN_XML]]);
    expect(sqlServerExplainResult([result([], []), planResult, result([], [])])).toEqual({ result: planResult });
    const plan = parseExplainResult("sqlserver", planResult);
    const nodes = flattenExplainPlanNodes(plan.nodes);

    expect(plan.databaseType).toBe("sqlserver");
    expect(plan.raw).toBe(SHOWPLAN_XML);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "0", nodeType: "Sort", rows: "2", cost: "0.029466" });
    expect(nodes[1]).toMatchObject({
      id: "1",
      nodeType: "Index Seek",
      relation: "dbo.orders",
      index: "ix_orders_customer_status",
      rows: "1",
      cost: "0.0034412",
    });
    expect(nodes[1].details).toContain("Estimated Rows Read: 4");
    expect(nodes[1].details).toContain("Expression: [orders].[status]='paid'");
  });

  it("surfaces a SQL Server batch error instead of treating it as a plan", () => {
    expect(sqlServerExplainResult([result(["Error"], [["Invalid object name 'missing_table'"]])])).toEqual({
      error: "Invalid object name 'missing_table'",
    });
  });

  it("rejects malformed SHOWPLAN XML", () => {
    const malformed = result(["Microsoft SQL Server 2005 XML Showplan"], [["<ShowPlanXML><RelOp></ShowPlanXML>"]]);

    expect(() => parseExplainResult("sqlserver", malformed)).toThrow("Invalid SQL Server ShowPlan XML");
  });

  it("rejects truncated SHOWPLAN XML", () => {
    const truncated = result(["Microsoft SQL Server 2005 XML Showplan"], [["<ShowPlanXML><RelOp>"]]);

    expect(() => parseExplainResult("sqlserver", truncated)).toThrow("Invalid SQL Server ShowPlan XML");
  });

  it("rejects XML that is not a SHOWPLAN document", () => {
    const unrelated = result(["XML"], [["<Root><RelOp /></Root>"]]);

    expect(() => parseExplainResult("sqlserver", unrelated)).toThrow("SQL Server did not return ShowPlan XML");
    expect(sqlServerExplainResult([unrelated])).toEqual({ error: "SQL Server did not return ShowPlan XML" });
  });

  it("rejects SHOWPLAN XML without RelOp nodes", () => {
    const emptyPlan = result(["Microsoft SQL Server 2005 XML Showplan"], [[`<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence /></ShowPlanXML>`]]);

    expect(() => parseExplainResult("sqlserver", emptyPlan)).toThrow("SQL Server ShowPlan XML contains no RelOp nodes");
  });
});
