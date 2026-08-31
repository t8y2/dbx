import { describe, expect, it } from "vitest";
import { inferCompareKeyColumns } from "../dataCompare";

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
