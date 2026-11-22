import { describe, expect, it } from "vitest";
import { analyzeSelectStructureForDisplay, flattenSimpleDerivedTablesForDisplay } from "@/lib/sql/sqlAnalysis";

describe("flattenSimpleDerivedTablesForDisplay", () => {
  it("flattens joined star derived tables into base tables", () => {
    const sql = "SELECT * FROM (SELECT * FROM DDS.FDS_FWS_CFG_FUND WHERE last_etl_dt ='9999-12-31' AND workway ='1') A LEFT JOIN (SELECT * FROM DDS.FDS_FWS_CFG_MANAGER WHERE last_etl_dt ='9999-12-31') B ON A.managercode=B.managercode";
    expect(flattenSimpleDerivedTablesForDisplay(sql)).toBe("SELECT * FROM DDS.FDS_FWS_CFG_FUND A LEFT JOIN DDS.FDS_FWS_CFG_MANAGER B ON A.managercode=B.managercode");
  });

  it("keeps the outer WHERE clause and single derived tables intact", () => {
    const sql = "SELECT A.* FROM (SELECT * FROM s.t WHERE x = 1) A WHERE A.y = 2";
    expect(flattenSimpleDerivedTablesForDisplay(sql)).toBe("SELECT A.* FROM s.t A WHERE A.y = 2");
  });

  it("supports AS aliases and quoted identifiers", () => {
    const sql = "SELECT * FROM (SELECT * FROM [dbo].[t]) AS A";
    expect(flattenSimpleDerivedTablesForDisplay(sql)).toBe("SELECT * FROM [dbo].[t] AS A");
  });

  it("returns the original string when there is nothing to flatten", () => {
    const sql = "SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON A.x=B.x WHERE A.y = 1";
    expect(flattenSimpleDerivedTablesForDisplay(sql)).toBe(sql);
  });

  it("leaves non-star projections and joined derived tables untouched", () => {
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM (SELECT fundcode AS fc FROM DDS.T) A")).toBe("SELECT * FROM (SELECT fundcode AS fc FROM DDS.T) A");
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM (SELECT * FROM DDS.T1 JOIN DDS.T2 ON DDS.T1.id = DDS.T2.id) A")).toBe("SELECT * FROM (SELECT * FROM DDS.T1 JOIN DDS.T2 ON DDS.T1.id = DDS.T2.id) A");
  });

  it("only rewrites paren groups at a source position", () => {
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM a LEFT JOIN b ON a.id=b.id AND EXISTS (SELECT * FROM c)")).toBe("SELECT * FROM a LEFT JOIN b ON a.id=b.id AND EXISTS (SELECT * FROM c)");
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM (SELECT * FROM (SELECT * FROM t) x) A")).toBe("SELECT * FROM (SELECT * FROM (SELECT * FROM t) x) A");
  });

  it("ignores parens inside literals in the FROM body", () => {
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM (SELECT * FROM DDS.T) A LEFT JOIN DDS.M B ON A.x=B.x AND A.note = '('")).toBe("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON A.x=B.x AND A.note = '('");
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM (SELECT * FROM DDS.T) A LEFT JOIN DDS.M B ON A.x=B.x AND A.note = '(SELECT * FROM x)'")).toBe("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON A.x=B.x AND A.note = '(SELECT * FROM x)'");
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON A.note = ')'")).toBe("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON A.note = ')'");
  });

  it("ignores CTE queries and parens inside literals or ON conditions", () => {
    expect(flattenSimpleDerivedTablesForDisplay("WITH c AS (SELECT * FROM t) SELECT * FROM c")).toBe("WITH c AS (SELECT * FROM t) SELECT * FROM c");
    expect(flattenSimpleDerivedTablesForDisplay("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON (A.note = '(unclosed' AND A.x = B.x)")).toBe("SELECT * FROM DDS.T A LEFT JOIN DDS.M B ON (A.note = '(unclosed' AND A.x = B.x)");
  });
});

describe("analyzeSelectStructureForDisplay via flattening", () => {
  it("resolves derived-table join sources for result comments", () => {
    const sql = "SELECT * FROM (SELECT * FROM DDS.FDS_FWS_CFG_FUND WHERE last_etl_dt ='9999-12-31') A LEFT JOIN (SELECT * FROM DDS.FDS_FWS_CFG_MANAGER WHERE last_etl_dt ='9999-12-31') B ON A.managercode=B.managercode";
    const analysis = analyzeSelectStructureForDisplay(flattenSimpleDerivedTablesForDisplay(sql));
    expect(analysis).not.toBeNull();
    expect(analysis!.selectStar).toBe(true);
    expect(analysis!.sources?.map((source) => `${source.schema}.${source.tableName}:${source.alias}`)).toEqual(["DDS.FDS_FWS_CFG_FUND:A", "DDS.FDS_FWS_CFG_MANAGER:B"]);
  });

  it("still returns null for unflattenable derived tables", () => {
    const sql = "SELECT * FROM (SELECT fundcode FROM DDS.T) A";
    expect(analyzeSelectStructureForDisplay(flattenSimpleDerivedTablesForDisplay(sql))).toBeNull();
  });
});
