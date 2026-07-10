import { describe, expect, it } from "vitest";
import { flattenExplainPlanNodes, parseOracleExplainText, supportsExplainPlan } from "@/lib/diagram/explainPlan";

const ORACLE_PLAN = `Plan hash value: 321708281

-----------------------------------------------------------------------------------------
| Id  | Operation                     | Name    | Rows  | Bytes | Cost (%CPU)| Time     |
-----------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT              |         |     1 |    34 |     5   (0)| 00:00:01 |
|   1 |  NESTED LOOPS                 |         |     1 |    34 |     5   (0)| 00:00:01 |
|   2 |   NESTED LOOPS                |         |     1 |    31 |     4   (0)| 00:00:01 |
|*  3 |    TABLE ACCESS BY INDEX ROWID| USER$   |     1 |    28 |     3   (0)| 00:00:01 |
|*  4 |     INDEX RANGE SCAN          | I_USER1 |     3 |       |     1   (0)| 00:00:01 |
|   5 |    TABLE ACCESS CLUSTER       | TS$     |     1 |     3 |     1   (0)| 00:00:01 |
|*  6 |     INDEX UNIQUE SCAN         | I_TS#   |     1 |       |     0   (0)| 00:00:01 |
|   7 |   TABLE ACCESS CLUSTER        | TS$     |     1 |     3 |     1   (0)| 00:00:01 |
|*  8 |    INDEX UNIQUE SCAN          | I_TS#   |     1 |       |     0   (0)| 00:00:01 |
-----------------------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------

   3 - filter("U"."TYPE#"=1 AND "U"."USER#">0)
   4 - access("U"."NAME" LIKE 'S%' AND
       "U"."CREATED_AT">=TO_DATE(' 2025-12-01 00:00:00',
       'syyyy-mm-dd hh24:mi:ss'))
       filter("U"."NAME" LIKE 'S%')`;

describe("Oracle explain plan", () => {
  it("is enabled by the driver capability manifest", () => {
    expect(supportsExplainPlan("oracle")).toBe(true);
  });

  it("parses DBMS_XPLAN text into a hierarchy with predicates", () => {
    const plan = parseOracleExplainText(ORACLE_PLAN);
    const nodes = flattenExplainPlanNodes(plan.nodes);

    expect(plan.databaseType).toBe("oracle");
    expect(plan.raw).toBe(ORACLE_PLAN);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].nodeType).toBe("SELECT STATEMENT");
    expect(plan.nodes[0].children[0].nodeType).toBe("NESTED LOOPS");
    expect(plan.nodes[0].children[0].children.map((node) => node.id)).toEqual(["2", "7"]);

    const tableAccess = nodes.find((node) => node.id === "3");
    expect(tableAccess).toMatchObject({ relation: "USER$", rows: "1", cost: "3   (0)" });
    expect(tableAccess?.details).toContain('Predicate: filter("U"."TYPE#"=1 AND "U"."USER#">0)');

    const indexScan = nodes.find((node) => node.id === "4");
    expect(indexScan?.index).toBe("I_USER1");
    expect(indexScan?.details).toEqual(["Time: 00:00:01", 'Predicate: access("U"."NAME" LIKE \'S%\' AND "U"."CREATED_AT">=TO_DATE(\' 2025-12-01 00:00:00\', \'syyyy-mm-dd hh24:mi:ss\'))', 'Predicate: filter("U"."NAME" LIKE \'S%\')']);
  });

  it("keeps unrecognized text available in the raw view", () => {
    expect(parseOracleExplainText("Oracle plan unavailable")).toEqual({
      databaseType: "oracle",
      raw: "Oracle plan unavailable",
      nodes: [],
    });
  });
});
