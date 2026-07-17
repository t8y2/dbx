import { describe, expect, it } from "vitest";
import { doubleClickRowAction, isSourceOnlyObjectBrowserRow, resolveRowClickAction, shouldDeferSingleClick, singleClickRowAction } from "@/lib/table/objectBrowserRowAction";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

function row(type: ObjectBrowserRow["type"], name = "test"): ObjectBrowserRow {
  return { id: `${type}-${name}`, name, displayName: name, type };
}

describe("singleClickRowAction", () => {
  it("returns table-info for TABLE", () => {
    expect(singleClickRowAction(row("TABLE", "users"))).toBe("table-info");
  });

  it("returns open-source for VIEW", () => {
    expect(singleClickRowAction(row("VIEW", "v_users"))).toBe("open-source");
  });

  it("returns open-source for PROCEDURE", () => {
    expect(singleClickRowAction(row("PROCEDURE", "sp_test"))).toBe("open-source");
  });

  it("returns open-source for FUNCTION", () => {
    expect(singleClickRowAction(row("FUNCTION", "fn_test"))).toBe("open-source");
  });

  it("returns open-source for SEQUENCE", () => {
    expect(singleClickRowAction(row("SEQUENCE", "seq_test"))).toBe("open-source");
  });

  it("returns open-source for MATERIALIZED_VIEW", () => {
    expect(singleClickRowAction(row("MATERIALIZED_VIEW", "mv_test"))).toBe("open-source");
  });

  it("returns open-source for PACKAGE", () => {
    expect(singleClickRowAction(row("PACKAGE", "pkg_test"))).toBe("open-source");
  });

  it("returns open-source for PACKAGE_BODY", () => {
    expect(singleClickRowAction(row("PACKAGE_BODY", "pkg_body_test"))).toBe("open-source");
  });

  it.each(["TRIGGER", "TYPE", "TYPE_BODY"] as const)("returns open-source for %s", (type) => {
    expect(singleClickRowAction(row(type, "programmable_test"))).toBe("open-source");
  });

  it("returns none for null/undefined", () => {
    expect(singleClickRowAction(null)).toBe("none");
    expect(singleClickRowAction(undefined)).toBe("none");
  });
});

describe("doubleClickRowAction", () => {
  it("returns open-table for TABLE", () => {
    expect(doubleClickRowAction(row("TABLE", "orders"))).toBe("open-table");
  });

  it("returns open-source for VIEW", () => {
    expect(doubleClickRowAction(row("VIEW", "v_orders"))).toBe("open-source");
  });

  it("returns open-source for PROCEDURE", () => {
    expect(doubleClickRowAction(row("PROCEDURE", "sp_run"))).toBe("open-source");
  });

  it("returns none for null/undefined", () => {
    expect(doubleClickRowAction(null)).toBe("none");
  });
});

describe("isSourceOnlyObjectBrowserRow", () => {
  it.each(["TRIGGER", "TYPE", "TYPE_BODY"] as const)("marks %s as source-only", (type) => {
    expect(isSourceOnlyObjectBrowserRow(row(type))).toBe(true);
  });

  it("keeps procedure and function mutation menus separate", () => {
    expect(isSourceOnlyObjectBrowserRow(row("PROCEDURE"))).toBe(false);
    expect(isSourceOnlyObjectBrowserRow(row("FUNCTION"))).toBe(false);
  });
});

describe("resolveRowClickAction", () => {
  const tableRow = row("TABLE", "users");
  const viewRow = row("VIEW", "v_users");

  describe("single-click activation mode", () => {
    it("single click on TABLE returns table-info", () => {
      const result = resolveRowClickAction(tableRow, 1, "single");
      expect(result.action).toBe("table-info");
      expect(result.isDouble).toBe(false);
    });

    it("double click on TABLE returns open-table", () => {
      const result = resolveRowClickAction(tableRow, 2, "single");
      expect(result.action).toBe("open-table");
      expect(result.isDouble).toBe(true);
    });

    it("single click on VIEW returns open-source", () => {
      const result = resolveRowClickAction(viewRow, 1, "single");
      expect(result.action).toBe("open-source");
      expect(result.isDouble).toBe(false);
    });

    it("double click on VIEW returns open-source", () => {
      const result = resolveRowClickAction(viewRow, 2, "single");
      expect(result.action).toBe("open-source");
      expect(result.isDouble).toBe(true);
    });
  });

  describe("double-click activation mode", () => {
    it("single click (detail=1) on TABLE returns table-info (side panel)", () => {
      const result = resolveRowClickAction(tableRow, 1, "double");
      expect(result.action).toBe("table-info");
      expect(result.isDouble).toBe(false);
    });

    it("single click (detail=1) on VIEW returns open-source (side panel)", () => {
      const result = resolveRowClickAction(viewRow, 1, "double");
      expect(result.action).toBe("open-source");
      expect(result.isDouble).toBe(false);
    });

    it("double click on TABLE returns open-table", () => {
      const result = resolveRowClickAction(tableRow, 2, "double");
      expect(result.action).toBe("open-table");
      expect(result.isDouble).toBe(true);
    });

    it("double click on VIEW returns open-source", () => {
      const result = resolveRowClickAction(viewRow, 2, "double");
      expect(result.action).toBe("open-source");
      expect(result.isDouble).toBe(true);
    });
  });
});

describe("shouldDeferSingleClick", () => {
  const tableRow = row("TABLE", "users");
  const viewRow = row("VIEW", "v_users");

  it("defers TABLE table-info (distinct single/double actions)", () => {
    expect(shouldDeferSingleClick(tableRow, "table-info")).toBe(true);
  });

  it("does not defer VIEW open-source (same single/double action)", () => {
    expect(shouldDeferSingleClick(viewRow, "open-source")).toBe(false);
  });

  it("does not defer none action", () => {
    expect(shouldDeferSingleClick(tableRow, "none")).toBe(false);
  });

  it("does not defer when action is not the single-click action", () => {
    expect(shouldDeferSingleClick(tableRow, "open-table")).toBe(false);
  });

  it("handles null/undefined row", () => {
    expect(shouldDeferSingleClick(null, "table-info")).toBe(false);
    expect(shouldDeferSingleClick(undefined, "open-source")).toBe(false);
  });
});
