import { describe, expect, it } from "vitest";
import { filterTableNames, isEveryFilteredSelected, toggleSelectFiltered, toggleTableName } from "@/lib/diff/tableMultiSelect";

describe("tableMultiSelect helpers", () => {
  const tables = ["users", "active_users", "orders", "audit_log", "payments"];

  describe("filterTableNames", () => {
    it("returns all tables for an empty/whitespace query", () => {
      expect(filterTableNames(tables, "")).toEqual(tables);
      expect(filterTableNames(tables, "   ")).toEqual(tables);
    });

    it("filters by case-insensitive substring", () => {
      expect(filterTableNames(tables, "USER")).toEqual(["users", "active_users"]);
      expect(filterTableNames(tables, "pay")).toEqual(["payments"]);
    });

    it("returns an empty list when nothing matches", () => {
      expect(filterTableNames(tables, "zzz")).toEqual([]);
    });
  });

  describe("toggleTableName", () => {
    it("adds a table to the selection", () => {
      expect(toggleTableName([], "users")).toEqual(["users"]);
      expect(toggleTableName(["orders"], "users")).toEqual(["orders", "users"]);
    });

    it("removes a table from the selection", () => {
      expect(toggleTableName(["users", "orders"], "users")).toEqual(["orders"]);
    });

    it("returns a new array and never duplicates", () => {
      const input = ["users"];
      const next = toggleTableName(input, "users");
      expect(next).toEqual([]);
      expect(next).not.toBe(input);
    });
  });

  describe("isEveryFilteredSelected", () => {
    it("is false for an empty filtered set", () => {
      expect(isEveryFilteredSelected(["users"], [])).toBe(false);
    });

    it("is true only when every filtered table is selected", () => {
      expect(isEveryFilteredSelected(["users", "orders"], ["users", "orders"])).toBe(true);
      expect(isEveryFilteredSelected(["users"], ["users", "orders"])).toBe(false);
      expect(isEveryFilteredSelected([], ["users"])).toBe(false);
    });
  });

  describe("toggleSelectFiltered", () => {
    it("selects all filtered tables when not all are selected (select-all)", () => {
      const result = toggleSelectFiltered(["users"], [...tables]);
      expect(result).toEqual([...tables]);
    });

    it("deselects all filtered tables when all are already selected (deselect-all)", () => {
      const result = toggleSelectFiltered([...tables], [...tables]);
      expect(result).toEqual([]);
    });

    it("only affects the filtered subset and preserves other selections", () => {
      const filtered = ["users", "orders"];
      const result = toggleSelectFiltered(["payments"], filtered);
      expect(result).toEqual(["payments", "users", "orders"]);
    });

    it("after a search, select-all only toggles the current filtered subset", () => {
      const filtered = filterTableNames(tables, "user"); // users, active_users
      const selected = ["orders", "payments"];
      const afterSelect = toggleSelectFiltered(selected, filtered);
      expect([...afterSelect].sort()).toEqual(["active_users", "orders", "payments", "users"]);
    });

    it("keeps already-selected tables untouched by the filtered subset change", () => {
      // simulating: selected [users, orders], search narrowed to [users], deselect-all removes only users
      const filtered = ["users"];
      const result = toggleSelectFiltered(["users", "orders"], filtered);
      expect(result).toEqual(["orders"]);
    });
  });

  it("selection persists across a changing search query (search is independent of selection)", () => {
    // selection state is external; filtering only selects which rows are visible
    const selected = ["users", "audit_log"];
    const visibleA = filterTableNames(tables, "user");
    const visibleB = filterTableNames(tables, "audit");
    expect(visibleA).toEqual(["users", "active_users"]);
    expect(visibleB).toEqual(["audit_log"]);
    // both still reflect the same underlying selection
    expect(isEveryFilteredSelected(selected, ["users"])).toBe(true);
    expect(isEveryFilteredSelected(selected, ["audit_log"])).toBe(true);
  });
});
