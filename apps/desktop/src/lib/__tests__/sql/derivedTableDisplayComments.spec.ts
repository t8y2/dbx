import { describe, expect, it } from "vitest";
import { analyzeQueryDisplayStructure, analyzeSelectStructureForDisplay, flattenSimpleDerivedTablesForDisplay, resolveSourceColumnsByOrdinal } from "@/lib/sql/sqlAnalysis";

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

const USER_UNION_SQL = `SELECT * FROM (
  SELECT * FROM NRCBREPORT_WT.YXYTH_2026_CARD_DSF_INSERT --WHERE TB_DATE BETWEEN LEFT('20261125',8)||'01' AND '20261125'
  WHERE STAF_NO ='8866231'
) A
LEFT JOIN (
  SELECT * FROM NFCP.T_CCL_BOOK WHERE EFF_DT<='20261125' AND END_DT>'20261125' AND CON_TYPE='06020001' AND CON_STAT='1'
) B ON A.CH_NL_REAL=B.CHN_ID AND A.ID_CARD=B.ACCT_NO
LEFT JOIN (
  SELECT * FROM NRCBREPORT_WT.YXYTH_2026_CARD_DSF_RUN WHERE DATE_ID='20261125'
) C ON A.CH_NL_REAL=C.CHAN_ID_NL AND A.ID_CARD=C.DBTR_ACCT_ID
LEFT JOIN (
  SELECT CDNOAC19,SUBSTR(CSNOCSID,4) CSNOCSID FROM CORE.BWFMDCIM WHERE EFF_DT<='20261125' AND END_DT>'20261125'
  UNION ALL
  SELECT CARD_NBR,CUSTR_NBR FROM CCRD.CARD WHERE EFF_DT<='20261125' AND END_DT>'20261125'
) D ON A.ID_CARD=D.CDNOAC19`;

function fakeColumns(names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

describe("analyzeQueryDisplayStructure", () => {
  it("parses the user's UNION ALL derived table through a placeholder source", () => {
    const structure = analyzeQueryDisplayStructure(flattenSimpleDerivedTablesForDisplay(USER_UNION_SQL));
    expect(structure).not.toBeNull();
    expect(structure!.analysis.sources!.map((source) => `${source.schema ? `${source.schema}.` : ""}${source.tableName}:${source.alias}`)).toEqual(["NRCBREPORT_WT.YXYTH_2026_CARD_DSF_INSERT:A", "NFCP.T_CCL_BOOK:B", "NRCBREPORT_WT.YXYTH_2026_CARD_DSF_RUN:C", "__dbx_derived_0__:D"]);
    // Output labels come from the derived table's first SELECT only.
    expect([...structure!.derivedOutputColumns.values()]).toEqual([["CDNOAC19", "CSNOCSID"]]);
    // The plain parse still bails, so the store only reaches this as a fallback.
    expect(analyzeSelectStructureForDisplay(flattenSimpleDerivedTablesForDisplay(USER_UNION_SQL))).toBeNull();
  });

  it("keeps result ordinals aligned across the user's derived source", () => {
    const structure = analyzeQueryDisplayStructure(flattenSimpleDerivedTablesForDisplay(USER_UNION_SQL))!;
    const sources = structure.analysis.sources!;
    const tableSources = [
      { source: sources[0]!, columns: fakeColumns(["id", "name"]) },
      { source: sources[1]!, columns: fakeColumns(["id"]) },
      { source: sources[2]!, columns: fakeColumns(["x"]) },
      { source: sources[3]!, columns: fakeColumns(structure.derivedOutputColumns.get(sources[3]!.tableName)!) },
    ];
    const refs = resolveSourceColumnsByOrdinal("db2", structure.analysis, tableSources, 6);
    expect(refs).toEqual([
      { sourceKey: "A:0", sourceColumn: "id" },
      { sourceKey: "A:0", sourceColumn: "name" },
      { sourceKey: "B:1", sourceColumn: "id" },
      { sourceKey: "C:2", sourceColumn: "x" },
      { sourceKey: "D:3", sourceColumn: "CDNOAC19" },
      { sourceKey: "D:3", sourceColumn: "CSNOCSID" },
    ]);
  });

  it("keeps ordinals after a mid-FROM derived source aligned", () => {
    const sql = "SELECT * FROM (SELECT a1, a2 FROM s.ta) A JOIN (SELECT b1 FROM s.tb UNION ALL SELECT b2 FROM s.tc) B ON A.a1 = B.b1 JOIN s.td D ON D.d1 = A.a1";
    const structure = analyzeQueryDisplayStructure(sql)!;
    const sources = structure.analysis.sources!;
    const tableSources = [
      { source: sources[0]!, columns: fakeColumns(["a1", "a2"]) },
      { source: sources[1]!, columns: fakeColumns(["b1"]) },
      { source: sources[2]!, columns: fakeColumns(["d1"]) },
    ];
    const refs = resolveSourceColumnsByOrdinal("db2", structure.analysis, tableSources, 4);
    expect(refs).toEqual([
      { sourceKey: "A:0", sourceColumn: "a1" },
      { sourceKey: "A:0", sourceColumn: "a2" },
      { sourceKey: "B:1", sourceColumn: "b1" },
      { sourceKey: "D:2", sourceColumn: "d1" },
    ]);
  });

  it("bails on derived shapes whose column count it cannot know", () => {
    expect(analyzeQueryDisplayStructure("SELECT * FROM (SELECT * FROM t) A")).toBeNull();
    expect(analyzeQueryDisplayStructure("SELECT * FROM (SELECT DISTINCT id FROM t) A")).toBeNull();
    expect(analyzeQueryDisplayStructure("SELECT id FROM t1 UNION ALL SELECT id FROM t2")).toBeNull();
    expect(analyzeQueryDisplayStructure("WITH c AS (SELECT id FROM t) SELECT * FROM c")).toBeNull();
  });
});
