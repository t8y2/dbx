import { describe, expect, it } from "vitest";
import { shouldNavigateFromTableInfoColumnClick } from "@/lib/table/tableInfoColumnNavigation";

describe("shouldNavigateFromTableInfoColumnClick", () => {
  it("keeps ordinary row clicks navigable", () => {
    expect(shouldNavigateFromTableInfoColumnClick(null)).toBe(true);
    expect(shouldNavigateFromTableInfoColumnClick({ isCollapsed: true, toString: () => "" })).toBe(true);
  });

  it("does not navigate after selecting a column name", () => {
    expect(shouldNavigateFromTableInfoColumnClick({ isCollapsed: false, toString: () => "customer_name" })).toBe(false);
  });
});
