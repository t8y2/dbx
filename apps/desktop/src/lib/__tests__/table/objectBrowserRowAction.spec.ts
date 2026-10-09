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

  it.each(["TRIGGER", "TYPE", "TYPE_BODY"] as const)("returns open-source for %s on Xugu", (type) => {
    expect(singleClickRowAction(row(type, "programmable_test"), "xugu")).toBe("open-source");
  });

  it("only Xugu TYPE rows open source", () => {
    expect(singleClickRowAction(row("TYPE", "app_status"), "xugu")).toBe("open-source");
    expect(doubleClickRowAction(row("TYPE", "app_status"), "xugu")).toBe("open-source");
    expect(singleClickRowAction(row("TYPE_BODY", "app_status"), "xugu")).toBe("open-source");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      // Verified PG-family TYPE rows open the read-only details panel.
      expect(singleClickRowAction(row("TYPE", "app_status"), dbType), String(dbType)).toBe("type-info");
      expect(doubleClickRowAction(row("TYPE", "app_status"), dbType), String(dbType)).toBe("type-info");
      // TYPE_BODY has no backend getter on these databases.
      expect(singleClickRowAction(row("TYPE_BODY", "app_status"), dbType), String(dbType)).toBe("none");
    }
    // Unknown connection type keeps the conservative no-action behavior.
    expect(singleClickRowAction(row("TYPE", "app_status"), undefined)).toBe("none");
    expect(doubleClickRowAction(row("TYPE", "app_status"), undefined)).toBe("none");
  });

  it("keeps source actions for non-type rows on PG-family databases", () => {
    for (const type of ["VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"] as const) {
      expect(singleClickRowAction(row(type), "postgres"), type).toBe("open-source");
    }
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

  it.each(["VIEW", "MATERIALIZED_VIEW"] as const)("returns open-table for %s like the sidebar data nodes", (type) => {
    expect(doubleClickRowAction(row(type, "v_orders"))).toBe("open-table");
  });

  it.each(["PROCEDURE", "FUNCTION"] as const)("returns open-source-tab for %s (editable source tab, not the side panel)", (type) => {
    expect(doubleClickRowAction(row(type, "sp_run"))).toBe("open-source-tab");
  });

  it("keeps routines on the source tab across database types", () => {
    for (const dbType of ["mysql", "postgres", "oracle", "xugu"] as const) {
      expect(doubleClickRowAction(row("PROCEDURE", "sp_run"), dbType), String(dbType)).toBe("open-source-tab");
      expect(doubleClickRowAction(row("FUNCTION", "fn_run"), dbType), String(dbType)).toBe("open-source-tab");
    }
  });

  it("leaves the other source-backed types on the side panel", () => {
    expect(doubleClickRowAction(row("EVENT", "ev_nightly"))).toBe("open-source");
    expect(doubleClickRowAction(row("SEQUENCE", "seq_test"))).toBe("open-source");
    expect(doubleClickRowAction(row("PACKAGE", "pkg_test"))).toBe("open-source");
    expect(doubleClickRowAction(row("PACKAGE_BODY", "pkg_body_test"))).toBe("open-source");
    expect(doubleClickRowAction(row("TRIGGER", "trg_test"), "xugu")).toBe("open-source");
    expect(doubleClickRowAction(row("TYPE", "app_status"), "xugu")).toBe("open-source");
    expect(doubleClickRowAction(row("TYPE_BODY", "app_status"), "xugu")).toBe("open-source");
    expect(doubleClickRowAction(row("VIEW", "v_users"))).toBe("open-table");
    expect(doubleClickRowAction(row("MATERIALIZED_VIEW", "mv_users"))).toBe("open-table");
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

    it("double click on VIEW returns open-table", () => {
      const result = resolveRowClickAction(viewRow, 2, "single");
      expect(result.action).toBe("open-table");
      expect(result.isDouble).toBe(true);
    });

    it.each(["PROCEDURE", "FUNCTION"] as const)("single click on %s returns open-source, double click returns open-source-tab", (type) => {
      const routineRow = row(type, "sp_run");
      expect(resolveRowClickAction(routineRow, 1, "single")).toEqual({ action: "open-source", isDouble: false });
      expect(resolveRowClickAction(routineRow, 2, "single")).toEqual({ action: "open-source-tab", isDouble: true });
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

    it("double click on VIEW returns open-table", () => {
      const result = resolveRowClickAction(viewRow, 2, "double");
      expect(result.action).toBe("open-table");
      expect(result.isDouble).toBe(true);
    });

    it.each(["PROCEDURE", "FUNCTION"] as const)("single click on %s returns open-source, double click returns open-source-tab", (type) => {
      const routineRow = row(type, "sp_run");
      expect(resolveRowClickAction(routineRow, 1, "double")).toEqual({ action: "open-source", isDouble: false });
      expect(resolveRowClickAction(routineRow, 2, "double")).toEqual({ action: "open-source-tab", isDouble: true });
    });
  });
});

describe("shouldDeferSingleClick", () => {
  const tableRow = row("TABLE", "users");
  const viewRow = row("VIEW", "v_users");

  it("defers TABLE table-info (distinct single/double actions)", () => {
    expect(shouldDeferSingleClick(tableRow, "table-info")).toBe(true);
  });

  it("defers VIEW open-source (distinct single/double actions)", () => {
    expect(shouldDeferSingleClick(viewRow, "open-source")).toBe(true);
  });

  it.each(["PROCEDURE", "FUNCTION"] as const)("defers %s open-source so a second click can cancel the side panel", (type) => {
    // single → open-source, double → open-source-tab: the 250ms deferral is what
    // keeps a fast double click from also opening the side panel (issue #10202).
    expect(shouldDeferSingleClick(row(type, "sp_run"), "open-source")).toBe(true);
    expect(shouldDeferSingleClick(row(type, "sp_run"), "open-source-tab")).toBe(false);
  });

  it("does not defer SEQUENCE open-source (same single/double action)", () => {
    expect(shouldDeferSingleClick(row("SEQUENCE", "seq_run"), "open-source")).toBe(false);
  });

  it("does not defer none action", () => {
    expect(shouldDeferSingleClick(tableRow, "none")).toBe(false);
  });

  it("does not defer when action is not the single-click action", () => {
    expect(shouldDeferSingleClick(tableRow, "open-table")).toBe(false);
  });

  it("opens MongoDB collections instead of SQL table-info", () => {
    expect(singleClickRowAction(tableRow, "mongodb")).toBe("open-table");
    expect(doubleClickRowAction(tableRow, "mongodb")).toBe("open-table");
    expect(singleClickRowAction(viewRow, "mongodb")).toBe("open-table");
    expect(doubleClickRowAction(viewRow, "mongodb")).toBe("open-table");
    expect(shouldDeferSingleClick(tableRow, "open-table", "mongodb")).toBe(false);
  });

  it("handles null/undefined row", () => {
    expect(shouldDeferSingleClick(null, "table-info")).toBe(false);
    expect(shouldDeferSingleClick(undefined, "open-source")).toBe(false);
  });
});
