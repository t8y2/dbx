import { describe, expect, it } from "vitest";
import { inferCompareKeyColumns, intersectCompareColumns, matchColumnNameIgnoreCase } from "../dataCompare";

describe("inferCompareKeyColumns", () => {
  it("returns all primary-key columns when a primary key exists", () => {
    expect(
      inferCompareKeyColumns([
        { name: "id", is_primary_key: true },
        { name: "name", is_primary_key: false },
      ]),
    ).toEqual(["id"]);
  });

  it("returns a composite primary key as-is", () => {
    expect(
      inferCompareKeyColumns([
        { name: "tenant_id", is_primary_key: true },
        { name: "user_id", is_primary_key: true },
        { name: "name", is_primary_key: false },
      ]),
    ).toEqual(["tenant_id", "user_id"]);
  });

  it("returns an empty array instead of falling back to the first column when there is no primary key", () => {
    expect(
      inferCompareKeyColumns([
        { name: "category", is_primary_key: false },
        { name: "name", is_primary_key: false },
      ]),
    ).toEqual([]);
  });

  it("returns an empty array for an empty column list", () => {
    expect(inferCompareKeyColumns([])).toEqual([]);
  });
});

describe("intersectCompareColumns", () => {
  it("matches lower-case source columns against upper-case target columns", () => {
    const intersection = intersectCompareColumns([{ name: "snid" }, { name: "username" }, { name: "amount" }], [{ name: "SNID" }, { name: "USERNAME" }, { name: "AMOUNT" }]);
    expect(intersection.columns).toEqual(["SNID", "USERNAME", "AMOUNT"]);
    expect(intersection.sourceColumns).toEqual(["snid", "username", "amount"]);
  });

  it("keeps source order and omits columns missing on either side", () => {
    const intersection = intersectCompareColumns([{ name: "Amount" }, { name: "snid" }, { name: "extra" }], [{ name: "SNID" }, { name: "AMOUNT" }]);
    expect(intersection.columns).toEqual(["AMOUNT", "SNID"]);
    expect(intersection.sourceColumns).toEqual(["Amount", "snid"]);
  });

  it("returns an empty intersection when no column names match ignoring case", () => {
    const intersection = intersectCompareColumns([{ name: "snid" }], [{ name: "id" }]);
    expect(intersection.columns).toEqual([]);
    expect(intersection.sourceColumns).toEqual([]);
  });

  it("deduplicates duplicated source columns", () => {
    const intersection = intersectCompareColumns([{ name: "snid" }, { name: "SNID" }], [{ name: "SNID" }]);
    expect(intersection.columns).toEqual(["SNID"]);
    expect(intersection.sourceColumns).toEqual(["snid"]);
  });
});

describe("matchColumnNameIgnoreCase", () => {
  it("resolves a name to the canonical entry ignoring case", () => {
    expect(matchColumnNameIgnoreCase("SNID", ["snid", "name"])).toBe("snid");
    expect(matchColumnNameIgnoreCase("Name", ["SNID", "NAME"])).toBe("NAME");
  });

  it("returns undefined when no column matches", () => {
    expect(matchColumnNameIgnoreCase("missing", ["snid"])).toBeUndefined();
  });
});
