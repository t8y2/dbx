import { describe, expect, it } from "vitest";
import { containsHan, matchesPinyinInitials, orderedSubsequenceSpan, pinyinAwareMatchScore, pinyinFirstLetters } from "@/lib/common/pinyin";
import { completionMatchRanges } from "@/lib/common/completionMatch";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";
import { identifierMatchScore, matchesIdentifierSearch } from "@/lib/sql/identifierSearch";

describe("identifier search", () => {
  it("matches camel-case initials and ranks them above loose fuzzy matches", () => {
    expect(matchesIdentifierSearch("userProfile", "up")).toBe(true);
    expect(identifierMatchScore("userProfile", "up")).toBeGreaterThan(identifierMatchScore("userPreference", "up"));
  });

  it("matches an identifier from any position", () => {
    expect(matchesIdentifierSearch("order_id", "id")).toBe(true);
    expect(matchesIdentifierSearch("created_at", "id")).toBe(false);
    expect(matchesIdentifierSearch("customer_order_total", "cot")).toBe(true);
  });

  it("keeps unrelated identifiers out of the result", () => {
    expect(matchesIdentifierSearch("userProfile", "xyz")).toBe(false);
  });
});

describe("pinyinAwareMatchScore", () => {
  it("ranks prefix above pinyin prefix above substring above pinyin subsequence", () => {
    const prefix = pinyinAwareMatchScore("总租金", "总");
    const pinyinPrefix = pinyinAwareMatchScore("总租金", "zz");
    const substring = pinyinAwareMatchScore("总租金", "金");
    const subsequence = pinyinAwareMatchScore("总租金", "zj");
    expect(prefix).toBeGreaterThan(pinyinPrefix);
    expect(pinyinPrefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it("returns -1 when nothing matches", () => {
    expect(pinyinAwareMatchScore("总租金", "jz")).toBe(-1);
    expect(pinyinAwareMatchScore("amount", "zz")).toBe(-1);
    expect(pinyinAwareMatchScore("amount", "")).toBe(0);
  });
});

describe("ordered subsequence span", () => {
  it("matches initials subsequences", () => {
    expect(orderedSubsequenceSpan("zzj", "zj")).toEqual({ first: 0, span: 3 });
    expect(orderedSubsequenceSpan("zzj", "j")).toEqual({ first: 2, span: 1 });
    expect(orderedSubsequenceSpan("zzj", "jz")).toBeNull();
    expect(orderedSubsequenceSpan("zzj", "")).toBeNull();
  });
});

describe("completion match highlight ranges", () => {
  it("highlights a Han substring match", () => {
    expect(completionMatchRanges("总租金", "金")).toEqual([2, 3]);
  });

  it("highlights every Han character matched by pinyin initials", () => {
    expect(completionMatchRanges("总租金", "zzj")).toEqual([0, 1, 1, 2, 2, 3]);
    expect(completionMatchRanges("总租金", "zz")).toEqual([0, 1, 1, 2]);
  });

  it("highlights only the Han characters hit by an initials subsequence", () => {
    expect(completionMatchRanges("总租金", "zj")).toEqual([0, 1, 2, 3]);
    expect(completionMatchRanges("总租金", "j")).toEqual([2, 3]);
  });

  it("highlights ASCII substrings and falls back to in-order fuzzy", () => {
    expect(completionMatchRanges("amount", "am")).toEqual([0, 2]);
    expect(completionMatchRanges("order_detail", "od")).toEqual([0, 1, 2, 3]);
    expect(completionMatchRanges("amount", "zz")).toEqual([]);
  });
});

describe("pinyin first letters", () => {
  it("maps Han characters to their pinyin initials", () => {
    expect(pinyinFirstLetters("总租金")).toBe("zzj");
    expect(pinyinFirstLetters("租赁日期")).toBe("zlrq");
  });

  it("keeps ASCII alphanumerics and drops other characters", () => {
    expect(pinyinFirstLetters("order明细")).toBe("ordermx");
    expect(pinyinFirstLetters("Amount")).toBe("amount");
  });

  it("matches only ASCII queries against Han candidates", () => {
    expect(matchesPinyinInitials("总租金", "zzj")).toBe(true);
    expect(matchesPinyinInitials("总租金", "zz")).toBe(true);
    expect(matchesPinyinInitials("总租金", "zj")).toBe(false);
    expect(matchesPinyinInitials("总租金", "租金")).toBe(false);
    expect(matchesPinyinInitials("amount", "am")).toBe(false);
    expect(containsHan("amount")).toBe(false);
  });
});

describe("sqlCompletion Chinese column matching", () => {
  function completionItems(typedPrefix: string) {
    const sql = `SELECT * FROM orders WHERE ${typedPrefix}`;
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map([
        [
          "orders",
          [
            { name: "总租金", table: "orders" },
            { name: "租赁日期", table: "orders" },
            { name: "amount", table: "orders" },
          ],
        ],
      ]),
    });
  }

  it("matches a single Han character anywhere in the column name", () => {
    const items = completionItems("金");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "总租金", type: "column" })]));
  });

  it("matches pinyin initials like DataGrip", () => {
    const items = completionItems("zzj");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "总租金", type: "column" })]));
    expect(items.some((item) => item.label === "租赁日期")).toBe(false);
    expect(items.some((item) => item.label === "amount")).toBe(false);
  });

  it("matches a single ASCII letter via pinyin initials", () => {
    const items = completionItems("z");
    const labels = items.filter((item) => item.type === "column").map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["总租金", "租赁日期"]));
  });

  it("matches initials subsequences like DataGrip", () => {
    const subsequenceItems = completionItems("zj");
    expect(subsequenceItems).toEqual(expect.arrayContaining([expect.objectContaining({ label: "总租金", type: "column" })]));
    expect(subsequenceItems.some((item) => item.label === "租赁日期")).toBe(false);

    const lastInitialItems = completionItems("j");
    expect(lastInitialItems).toEqual(expect.arrayContaining([expect.objectContaining({ label: "总租金", type: "column" })]));
    expect(lastInitialItems.some((item) => item.label === "租赁日期")).toBe(false);
  });

  it("keeps plain English matching unchanged", () => {
    const items = completionItems("am");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "amount", type: "column" })]));
    expect(items.some((item) => item.label === "总租金")).toBe(false);
  });
});

describe("sqlCompletion identifier column matching", () => {
  function completionItems(typedPrefix: string) {
    const sql = `SELECT * FROM orders WHERE ${typedPrefix}`;
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map([
        [
          "orders",
          [
            { name: "userProfile", table: "orders" },
            { name: "order_id", table: "orders" },
            { name: "created_at", table: "orders" },
          ],
        ],
      ]),
    });
  }

  it("matches camel-case initials in WHERE column completion", () => {
    const items = completionItems("up");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "userProfile", type: "column" })]));
    expect(items.some((item) => item.label === "order_id")).toBe(false);
  });

  it("matches WHERE columns from any position", () => {
    const items = completionItems("id");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "order_id", type: "column" })]));
    expect(items.some((item) => item.label === "created_at")).toBe(false);
  });
});
