import { DOMParser } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult, sqlServerExplainResult } from "@/lib/diagram/explainPlan";
import { extractActualRows } from "@/lib/diagram/planCanvas";
import type { QueryResult } from "@/types/database";

// SET STATISTICS XML output: the SHOWPLAN_XML schema plus <RunTimeInformation>.
// Gather Streams and its subtree run on 3 worker threads; the nested loop inner
// seek runs 100 times in total and returns 10 rows per execution against a
// 10-row estimate, so its cumulative 1000 rows are a 100x apparent overrun.
const STATISTICS_XML = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.customers c JOIN dbo.orders o ON o.customer_id = c.id">
    <QueryPlan DegreeOfParallelism="3">
      <RelOp NodeId="0" PhysicalOp="Parallelism" LogicalOp="Gather Streams" EstimateRows="1000" EstimatedTotalSubtreeCost="1.24" AvgRowSize="24">
        <RunTimeInformation>
          <RunTimeCountersPerThread Thread="1" ActualRows="400" ActualExecutions="1" ActualElapsedms="118" ActualCPUms="40" />
          <RunTimeCountersPerThread Thread="2" ActualRows="350" ActualExecutions="1" ActualElapsedms="121" ActualCPUms="38" />
          <RunTimeCountersPerThread Thread="3" ActualRows="250" ActualExecutions="1" ActualElapsedms="119" ActualCPUms="36" />
        </RunTimeInformation>
        <Parallelism>
          <RelOp NodeId="1" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="1000" EstimatedTotalSubtreeCost="1.2" AvgRowSize="24">
            <RunTimeInformation>
              <RunTimeCountersPerThread Thread="1" ActualRows="400" ActualExecutions="1" ActualElapsedms="110" ActualCPUms="30" />
              <RunTimeCountersPerThread Thread="2" ActualRows="350" ActualExecutions="1" ActualElapsedms="112" ActualCPUms="28" />
              <RunTimeCountersPerThread Thread="3" ActualRows="250" ActualExecutions="1" ActualElapsedms="109" ActualCPUms="26" />
            </RunTimeInformation>
            <NestedLoops>
              <RelOp NodeId="2" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="100" EstimatedTotalSubtreeCost="0.3" AvgRowSize="16">
                <RunTimeInformation>
                  <RunTimeCountersPerThread Thread="1" ActualRows="40" ActualExecutions="1" ActualElapsedms="8" ActualCPUms="3" />
                  <RunTimeCountersPerThread Thread="2" ActualRows="35" ActualExecutions="1" ActualElapsedms="9" ActualCPUms="4" />
                  <RunTimeCountersPerThread Thread="3" ActualRows="25" ActualExecutions="1" ActualElapsedms="7" ActualCPUms="2" />
                </RunTimeInformation>
                <IndexScan>
                  <Object Database="[shop]" Schema="[dbo]" Table="[customers]" Index="[ix_customers_region]" />
                </IndexScan>
              </RelOp>
              <RelOp NodeId="3" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="10" EstimatedRowsRead="12" EstimatedTotalSubtreeCost="0.85" AvgRowSize="20">
                <RunTimeInformation>
                  <RunTimeCountersPerThread Thread="1" ActualRows="400" ActualRowsRead="420" ActualExecutions="40" ActualElapsedms="95" ActualCPUms="24" />
                  <RunTimeCountersPerThread Thread="2" ActualRows="350" ActualRowsRead="360" ActualExecutions="35" ActualElapsedms="97" ActualCPUms="22" />
                  <RunTimeCountersPerThread Thread="3" ActualRows="250" ActualRowsRead="260" ActualExecutions="25" ActualElapsedms="93" ActualCPUms="20" />
                </RunTimeInformation>
                <IndexScan>
                  <Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[ix_orders_customer]" />
                  <SeekPredicates><SeekPredicateNew><SeekKeys><Prefix>
                    <RangeExpressions><ScalarOperator ScalarString="[orders].[customer_id]=[customers].[id]" /></RangeExpressions>
                  </Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>
                </IndexScan>
              </RelOp>
            </NestedLoops>
          </RelOp>
        </Parallelism>
      </RelOp>
    </QueryPlan>
  </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

// A serial statement: one thread, one execution, no normalization to apply.
const SERIAL_STATISTICS_XML = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
    <RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="500" EstimatedTotalSubtreeCost="0.12" AvgRowSize="18">
      <RunTimeInformation>
        <RunTimeCountersPerThread Thread="0" ActualRows="1200" ActualRowsRead="1200" ActualExecutions="1" ActualElapsedms="14" ActualCPUms="12" />
      </RunTimeInformation>
      <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[pk_orders]" /></IndexScan>
    </RelOp>
  </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("SQL Server actual execution plan", () => {
  beforeEach(() => {
    vi.stubGlobal("DOMParser", DOMParser);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Parsed lazily: the DOMParser stub only exists once beforeEach has run.
  const parse = (xml: string) => flattenExplainPlanNodes(parseExplainResult("sqlserver", result(["Microsoft SQL Server 2005 XML Showplan"], [[xml]])).nodes);
  const node = (id: string) => parse(STATISTICS_XML).find((candidate) => candidate.id === id)!;
  const gatherStreams = () => node("0");
  const innerSeek = () => node("3");

  it("keeps the operator hierarchy the estimated plan already produced", () => {
    expect(parse(STATISTICS_XML).map((relOp) => relOp.nodeType)).toEqual(["Parallelism", "Nested Loops", "Index Scan", "Index Seek"]);
    expect(innerSeek()).toMatchObject({ relation: "dbo.orders", index: "ix_orders_customer", rows: "10", cost: "0.85" });
    expect(innerSeek().details).toContain("Expression: [orders].[customer_id]=[customers].[id]");
  });

  it("sums measured rows across every worker thread", () => {
    expect(gatherStreams().details).toContain("Actual Rows: 1000");
    expect(node("2").details).toContain("Actual Rows: 100");
    expect(innerSeek().details).toContain("Actual Rows: 1000");
  });

  it("reports the slowest thread as elapsed time and the summed CPU work", () => {
    expect(gatherStreams().details).toContain("Actual Time: 121 ms");
    expect(gatherStreams().details).toContain("Actual CPU: 114 ms");
    expect(innerSeek().details).toContain("Actual Time: 97 ms");
    expect(innerSeek().details).toContain("Actual CPU: 66 ms");
  });

  it("normalizes the repeated inner side of the nested loop to a per-execution figure", () => {
    expect(innerSeek().details).toContain("Actual Threads: 3");
    expect(innerSeek().details).toContain("Actual Executions: 100");
    expect(innerSeek().details).toContain("Actual Rows Per Execution: 10");
    // The estimate is per execution, so this is what a mismatch check must read.
    expect(extractActualRows(innerSeek())).toBe(10);
    expect(Number(innerSeek().rows)).toBe(10);
  });

  it("leaves parallel operators unnormalized, one execution per thread is still one execution", () => {
    for (const id of ["0", "1", "2"]) {
      expect(node(id).details.some((detail) => detail.startsWith("Actual Rows Per Execution"))).toBe(false);
    }
    expect(gatherStreams().details).toContain("Actual Threads: 3");
    expect(gatherStreams().details).toContain("Actual Executions: 3");
    expect(extractActualRows(gatherStreams())).toBe(1000);
    expect(extractActualRows(node("2"))).toBe(100);
  });

  it("keeps a serial single-execution operator on the plain measured total", () => {
    const [root] = parseExplainResult("sqlserver", result(["Microsoft SQL Server 2005 XML Showplan"], [[SERIAL_STATISTICS_XML]])).nodes;

    expect(root.details).toContain("Actual Rows: 1200");
    expect(root.details.some((detail) => detail.startsWith("Actual Threads"))).toBe(false);
    expect(root.details.some((detail) => detail.startsWith("Actual Executions"))).toBe(false);
    expect(root.details.some((detail) => detail.startsWith("Actual Rows Per Execution"))).toBe(false);
    expect(extractActualRows(root)).toBe(1200);
  });

  it("adds no measured details to an estimated SHOWPLAN plan", () => {
    const estimated = STATISTICS_XML.replaceAll(/<RunTimeInformation>[\s\S]*?<\/RunTimeInformation>/g, "");
    const parsed = parseExplainResult("sqlserver", result(["Microsoft SQL Server 2005 XML Showplan"], [[estimated]]));

    for (const node of flattenExplainPlanNodes(parsed.nodes)) {
      expect(node.details.some((detail) => detail.startsWith("Actual"))).toBe(false);
      expect(extractActualRows(node)).toBeUndefined();
    }
  });

  it("finds the plan when STATISTICS XML returns the query result set first", () => {
    const rowsResult = result(["id", "total"], [[1, "12.50"]]);
    const planResult = result(["Microsoft SQL Server 2005 XML Showplan"], [[STATISTICS_XML]]);

    expect(sqlServerExplainResult([rowsResult, planResult])).toEqual({ result: planResult });
  });
});
