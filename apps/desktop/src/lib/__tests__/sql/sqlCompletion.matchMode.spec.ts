import { describe, expect, it } from "vitest";
import { normalizeCompletionMatchMode } from "@/lib/sql/sqlCompletionMatchMode";
import { identifierMatchScore, matchesIdentifierSearch } from "@/lib/sql/identifierSearch";
import { completionMatchRanges } from "@/lib/common/completionMatch";
import { buildSqlCompletionItems, matchesTableSearch, buildPostgresSequenceLiteralCompletionItems, getPostgresSequenceLiteralCompletionContext, buildSqlCompletionItemsFromContext, getSqlCompletionContext } from "@/lib/sql/sqlCompletion";

describe("sqlCompletionMatchMode normalization", () => {
  it("normalizes default and invalid modes to fuzzy", () => {
    expect(normalizeCompletionMatchMode(undefined)).toBe("fuzzy");
    expect(normalizeCompletionMatchMode(null)).toBe("fuzzy");
    expect(normalizeCompletionMatchMode("")).toBe("fuzzy");
    expect(normalizeCompletionMatchMode("invalid" as any)).toBe("fuzzy");
    expect(normalizeCompletionMatchMode("contains")).toBe("contains");
    expect(normalizeCompletionMatchMode("fuzzy")).toBe("fuzzy");
  });
});

describe("identifier search match mode", () => {
  const scatteredCandidate = "ibps_bpm_task_sign";
  const acronymCandidate = "medium_account_income_notice";
  const continuousCandidate1 = "oc_main_sub_cust_contrast";
  const continuousCandidate2 = "yuncang_main";

  it("in contains mode: rejects scattered subsequence, rejects word initials, and accepts contiguous substrings", () => {
    expect(matchesIdentifierSearch(scatteredCandidate, "main", "contains")).toBe(false);
    expect(identifierMatchScore(scatteredCandidate, "main", "contains")).toBe(-1);

    expect(matchesIdentifierSearch(acronymCandidate, "main", "contains")).toBe(false);
    expect(identifierMatchScore(acronymCandidate, "main", "contains")).toBe(-1);

    expect(matchesIdentifierSearch(continuousCandidate1, "main", "contains")).toBe(true);
    expect(identifierMatchScore(continuousCandidate1, "main", "contains")).toBeGreaterThan(0);

    expect(matchesIdentifierSearch(continuousCandidate2, "main", "contains")).toBe(true);
    expect(identifierMatchScore(continuousCandidate2, "main", "contains")).toBeGreaterThan(0);
  });

  it("in fuzzy mode: accepts scattered subsequence, word initials, and contiguous substrings", () => {
    expect(matchesIdentifierSearch(scatteredCandidate, "main", "fuzzy")).toBe(true);
    expect(identifierMatchScore(scatteredCandidate, "main", "fuzzy")).toBeGreaterThan(0);

    expect(matchesIdentifierSearch(acronymCandidate, "main", "fuzzy")).toBe(true);
    expect(identifierMatchScore(acronymCandidate, "main", "fuzzy")).toBeGreaterThan(0);

    expect(matchesIdentifierSearch(continuousCandidate1, "main", "fuzzy")).toBe(true);
    expect(matchesIdentifierSearch(continuousCandidate2, "main", "fuzzy")).toBe(true);
  });
});

describe("completion match highlight ranges", () => {
  it("in contains mode: highlights contiguous match and returns empty for scattered/initial matches", () => {
    expect(completionMatchRanges("oc_main_sub_cust_contrast", "main", "contains")).toEqual([3, 7]);
    expect(completionMatchRanges("yuncang_main", "main", "contains")).toEqual([8, 12]);
    expect(completionMatchRanges("ibps_bpm_task_sign", "main", "contains")).toEqual([]);
    expect(completionMatchRanges("medium_account_income_notice", "main", "contains")).toEqual([]);
  });

  it("in contains mode: supports Chinese pinyin initials", () => {
    expect(completionMatchRanges("总租金", "zzj", "contains")).toEqual([0, 1, 1, 2, 2, 3]);
    expect(completionMatchRanges("用户收货地址", "yhs", "contains")).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it("in fuzzy mode: highlights scattered characters across the candidate", () => {
    const ranges = completionMatchRanges("ibps_bpm_task_sign", "main", "fuzzy");
    expect(ranges.length).toBeGreaterThan(0);

    const acronymRanges = completionMatchRanges("medium_account_income_notice", "main", "fuzzy");
    expect(acronymRanges.length).toBeGreaterThan(0);
  });
});

describe("table completion with matchMode", () => {
  const tables = [
    { name: "oc_main_sub_cust_contrast", type: "table" as const },
    { name: "yc_main_sub_cust_contrast", type: "table" as const },
    { name: "yuncang_main", type: "table" as const },
    { name: "ibps_bpm_task_sign", type: "table" as const },
    { name: "medium_account_income_notice", type: "table" as const },
  ];

  it("matchesTableSearch respects matchMode", () => {
    expect(matchesTableSearch({ name: "ibps_bpm_task_sign", type: "table" }, "main", "contains")).toBe(false);
    expect(matchesTableSearch({ name: "ibps_bpm_task_sign", type: "table" }, "main", "fuzzy")).toBe(true);

    expect(matchesTableSearch({ name: "medium_account_income_notice", type: "table" }, "main", "contains")).toBe(false);
    expect(matchesTableSearch({ name: "medium_account_income_notice", type: "table" }, "main", "fuzzy")).toBe(true);

    expect(matchesTableSearch({ name: "oc_main_sub_cust_contrast", type: "table" }, "main", "contains")).toBe(true);
  });

  it("buildSqlCompletionItems in contains mode does not suggest scattered fuzzy table names or word initials", () => {
    const sql = "SELECT * FROM main";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables,
      columnsByTable: new Map(),
      completionMatchMode: "contains",
    });

    const labels = items.map((item) => item.label);
    expect(labels).toContain("oc_main_sub_cust_contrast");
    expect(labels).toContain("yc_main_sub_cust_contrast");
    expect(labels).toContain("yuncang_main");
    expect(labels).not.toContain("ibps_bpm_task_sign");
    expect(labels).not.toContain("medium_account_income_notice");
  });

  it("buildSqlCompletionItems in fuzzy mode suggests scattered fuzzy table names and word initials", () => {
    const sql = "SELECT * FROM main";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables,
      columnsByTable: new Map(),
      completionMatchMode: "fuzzy",
    });

    const labels = items.map((item) => item.label);
    expect(labels).toContain("oc_main_sub_cust_contrast");
    expect(labels).toContain("yc_main_sub_cust_contrast");
    expect(labels).toContain("yuncang_main");
    expect(labels).toContain("ibps_bpm_task_sign");
    expect(labels).toContain("medium_account_income_notice");
  });

  it("column completion respects contains matchMode", () => {
    const sql = "SELECT main FROM test_tbl";
    const columnsByTable = new Map([
      [
        "test_tbl",
        [
          { name: "main_account", table: "test_tbl" },
          { name: "sub_main_id", table: "test_tbl" },
          { name: "ibps_bpm_task_sign", table: "test_tbl" },
          { name: "medium_account_income_notice", table: "test_tbl" },
        ],
      ],
    ]);

    const containsItems = buildSqlCompletionItems(sql, "SELECT main".length, {
      databaseType: "mysql",
      tables: [{ name: "test_tbl", type: "table" }],
      columnsByTable,
      completionMatchMode: "contains",
    });
    const containsLabels = containsItems.map((item) => item.label);
    expect(containsLabels).toContain("main_account");
    expect(containsLabels).toContain("sub_main_id");
    expect(containsLabels).not.toContain("ibps_bpm_task_sign");
    expect(containsLabels).not.toContain("medium_account_income_notice");

    const fuzzyItems = buildSqlCompletionItems(sql, "SELECT main".length, {
      databaseType: "mysql",
      tables: [{ name: "test_tbl", type: "table" }],
      columnsByTable,
      completionMatchMode: "fuzzy",
    });
    const fuzzyLabels = fuzzyItems.map((item) => item.label);
    expect(fuzzyLabels).toContain("main_account");
    expect(fuzzyLabels).toContain("sub_main_id");
    expect(fuzzyLabels).toContain("ibps_bpm_task_sign");
    expect(fuzzyLabels).toContain("medium_account_income_notice");
  });

  describe("dialect completion with matchMode", () => {
    it("oracle sequence pseudo-column in contains mode rejects non-contiguous nv prefix", () => {
      const sql = "SELECT seq.nv";
      const items = buildSqlCompletionItems(sql, sql.length, {
        databaseType: "oracle",
        tables: [],
        objects: [{ name: "seq", type: "sequence" }],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      const labels = items.map((item) => item.label);
      expect(labels).not.toContain("NEXTVAL");
    });

    it("oracle sequence pseudo-column in fuzzy mode accepts non-contiguous nv prefix", () => {
      const sql = "SELECT seq.nv";
      const items = buildSqlCompletionItems(sql, sql.length, {
        databaseType: "oracle",
        tables: [],
        objects: [{ name: "seq", type: "sequence" }],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      const labels = items.map((item) => item.label);
      expect(labels).toContain("NEXTVAL");
    });

    it("clickhouse function completion in contains mode suggests substring match lengthUTF8 for UTF8", () => {
      const sql = "SELECT UTF8";
      const items = buildSqlCompletionItems(sql, sql.length, {
        databaseType: "clickhouse",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      const labels = items.map((item) => item.label);
      expect(labels).toContain("lengthUTF8");
    });

    it("clickhouse function completion in contains mode rejects scattered lu prefix for lengthUTF8", () => {
      const sql = "SELECT lu";
      const containsItems = buildSqlCompletionItems(sql, sql.length, {
        databaseType: "clickhouse",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(containsItems.map((item) => item.label)).not.toContain("lengthUTF8");

      const fuzzyItems = buildSqlCompletionItems(sql, sql.length, {
        databaseType: "clickhouse",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      expect(fuzzyItems.map((item) => item.label)).toContain("lengthUTF8");
    });

    it("oracle table functions respect contains mode", () => {
      const sqlContiguous = "SELECT * FROM xml";
      const contiguousItems = buildSqlCompletionItems(sqlContiguous, sqlContiguous.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(contiguousItems.map((item) => item.label)).toContain("XMLTABLE");

      const sqlScattered = "SELECT * FROM xt";
      const containsItems = buildSqlCompletionItems(sqlScattered, sqlScattered.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(containsItems.map((item) => item.label)).not.toContain("XMLTABLE");

      const fuzzyItems = buildSqlCompletionItems(sqlScattered, sqlScattered.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      expect(fuzzyItems.map((item) => item.label)).toContain("XMLTABLE");
    });

    it("oracle system values respect contains mode", () => {
      const sqlContiguous = "SELECT date";
      const contiguousItems = buildSqlCompletionItems(sqlContiguous, sqlContiguous.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(contiguousItems.map((item) => item.label)).toContain("SYSDATE");

      const sqlScattered = "SELECT ste";
      const containsItems = buildSqlCompletionItems(sqlScattered, sqlScattered.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(containsItems.map((item) => item.label)).not.toContain("SYSDATE");

      const fuzzyItems = buildSqlCompletionItems(sqlScattered, sqlScattered.length, {
        databaseType: "oracle",
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      expect(fuzzyItems.map((item) => item.label)).toContain("SYSDATE");
    });

    it("local variables respect contains mode", () => {
      const sqlContiguous = "SELECT var";
      const baseContext = getSqlCompletionContext(sqlContiguous, sqlContiguous.length, { databaseType: "mysql" });
      const contextWithVars = { ...baseContext, localVariables: ["my_variable_count", "system_status_var"] };

      const containsItems = buildSqlCompletionItemsFromContext(contextWithVars, {
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(containsItems.map((i: any) => i.label)).toContain("my_variable_count");

      const sqlScattered = "SELECT mvc";
      const scatteredContext = { ...getSqlCompletionContext(sqlScattered, sqlScattered.length, { databaseType: "mysql" }), localVariables: ["my_variable_count"] };
      const scatteredContainsItems = buildSqlCompletionItemsFromContext(scatteredContext, {
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(scatteredContainsItems.map((i: any) => i.label)).not.toContain("my_variable_count");

      const scatteredFuzzyItems = buildSqlCompletionItemsFromContext(scatteredContext, {
        tables: [],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      expect(scatteredFuzzyItems.map((i: any) => i.label)).toContain("my_variable_count");
    });

    it("postgres sequence literal completion respects match mode", () => {
      const sql = "SELECT nextval('mst";
      const context = getPostgresSequenceLiteralCompletionContext(sql, sql.length, "postgres");
      expect(context).not.toBeNull();
      const objects = [{ name: "my_seq_test", schema: "public", type: "sequence" as const }];

      const containsItems = buildPostgresSequenceLiteralCompletionItems(context!, objects, "contains");
      expect(containsItems.map((i: any) => i.label)).not.toContain("my_seq_test");

      const fuzzyItems = buildPostgresSequenceLiteralCompletionItems(context!, objects, "fuzzy");
      expect(fuzzyItems.map((i: any) => i.label)).toContain("my_seq_test");

      const subSql = "SELECT nextval('seq";
      const subContext = getPostgresSequenceLiteralCompletionContext(subSql, subSql.length, "postgres");
      const contiguousItems = buildPostgresSequenceLiteralCompletionItems(subContext!, objects, "contains");
      expect(contiguousItems.map((i: any) => i.label)).toContain("my_seq_test");
    });

    it("referenced table aliases respect match mode", () => {
      const sql = "SELECT * FROM orders ot_detail WHERE od";
      const containsItems = buildSqlCompletionItems(sql, sql.length, {
        tables: [{ name: "orders" }],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(containsItems.map((i) => i.label)).not.toContain("ot_detail");

      const fuzzyItems = buildSqlCompletionItems(sql, sql.length, {
        tables: [{ name: "orders" }],
        columnsByTable: new Map(),
        completionMatchMode: "fuzzy",
      });
      expect(fuzzyItems.map((i) => i.label)).toContain("ot_detail");

      const contiguousSql = "SELECT * FROM orders ot_detail WHERE ot";
      const contiguousContainsItems = buildSqlCompletionItems(contiguousSql, contiguousSql.length, {
        tables: [{ name: "orders" }],
        columnsByTable: new Map(),
        completionMatchMode: "contains",
      });
      expect(contiguousContainsItems.map((i) => i.label)).toContain("ot_detail");
    });
  });
});
