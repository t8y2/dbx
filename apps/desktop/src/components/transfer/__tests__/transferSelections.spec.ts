import { describe, expect, it } from "vitest";
import { buildTransferObjectSelections, matchBulkObjectNames, parseBulkObjectNames } from "../transferSelections";

function setOf(names: string[]): Set<string> {
  return new Set(names);
}

describe("buildTransferObjectSelections", () => {
  it("serializes non-table selections in request order", () => {
    const result = buildTransferObjectSelections(
      {
        VIEW: setOf(["v1", "v2"]),
        SEQUENCE: setOf(["s1"]),
        TABLE: setOf(["t1"]),
      },
      [],
    );
    expect(result).toEqual([
      { objectType: "VIEW", names: ["v1", "v2"] },
      { objectType: "SEQUENCE", names: ["s1"] },
    ]);
  });

  it("drops TABLE selections (handled by the tables field)", () => {
    const result = buildTransferObjectSelections({ TABLE: setOf(["t1", "t2"]) }, []);
    expect(result).toEqual([]);
  });

  it("filters disabled object types even when stale selections remain", () => {
    const result = buildTransferObjectSelections(
      {
        VIEW: setOf(["v1"]),
        SEQUENCE: setOf(["s1"]),
        PROCEDURE: setOf(["p1"]),
      },
      ["VIEW", "SEQUENCE"],
    );
    expect(result).toEqual([{ objectType: "PROCEDURE", names: ["p1"] }]);
  });

  it("returns an empty payload when nothing is selected", () => {
    expect(buildTransferObjectSelections({}, [])).toEqual([]);
  });
});

describe("parseBulkObjectNames", () => {
  it("splits on newlines, commas, semicolons and tabs, dropping blanks", () => {
    expect(parseBulkObjectNames("orders, users;\npayments\t\tlogs\n\n  ")).toEqual(["orders", "users", "payments", "logs"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseBulkObjectNames("  \n\t ")).toEqual([]);
  });
});

describe("matchBulkObjectNames", () => {
  const groups = [
    { kind: "TABLE", items: ["orders", "users", "Order_Items"] },
    { kind: "VIEW", items: ["v_orders"] },
  ];

  it("matches case-insensitively and ignores surrounding quotes", () => {
    const result = matchBulkObjectNames('"ORDERS"\n`users`', groups);
    expect(result.matched).toEqual({ TABLE: ["orders", "users"] });
    expect(result.matchedCount).toBe(2);
    expect(result.unmatchedNames).toEqual([]);
  });

  it("keeps the catalog spelling of matched items", () => {
    expect(matchBulkObjectNames("order_items", groups).matched).toEqual({ TABLE: ["Order_Items"] });
  });

  it("collects names missing from the catalog", () => {
    const result = matchBulkObjectNames("orders, missing_table", groups);
    expect(result.matchedCount).toBe(1);
    expect(result.unmatchedNames).toEqual(["missing_table"]);
  });

  it("deduplicates repeated names across separators and case", () => {
    const result = matchBulkObjectNames("orders\nORDERS, orders", groups);
    expect(result.matched).toEqual({ TABLE: ["orders"] });
    expect(result.matchedCount).toBe(1);
    expect(result.unmatchedNames).toEqual([]);
  });

  it("accepts schema-qualified names for the current schema only", () => {
    const result = matchBulkObjectNames("public.orders\nother.orders\ncatalog.public.users", groups, [], ["public"]);
    expect(result.matched).toEqual({ TABLE: ["orders", "users"] });
    expect(result.unmatchedNames).toEqual(["other.orders"]);
  });

  it("falls back to plain name matching when no qualifier is available", () => {
    expect(matchBulkObjectNames("public.orders", groups).matched).toEqual({ TABLE: ["orders"] });
  });

  it("treats a fully quoted dotted name as a literal name", () => {
    const result = matchBulkObjectNames('"my.table"', [{ kind: "TABLE", items: ["my.table"] }]);
    expect(result.matched).toEqual({ TABLE: ["my.table"] });
  });

  it("skips disabled object kinds and reports their names as unmatched", () => {
    const result = matchBulkObjectNames("orders\nv_orders", groups, ["VIEW"]);
    expect(result.matched).toEqual({ TABLE: ["orders"] });
    expect(result.unmatchedNames).toEqual(["v_orders"]);
  });

  it("selects a duplicated name in the first matching group only", () => {
    const duplicated = [
      { kind: "TABLE", items: ["orders"] },
      { kind: "VIEW", items: ["orders"] },
    ];
    expect(matchBulkObjectNames("orders", duplicated).matched).toEqual({ TABLE: ["orders"] });
  });

  it("returns no matches for blank input", () => {
    expect(matchBulkObjectNames("   \n", groups)).toEqual({ matched: {}, matchedCount: 0, unmatchedNames: [] });
  });
});
