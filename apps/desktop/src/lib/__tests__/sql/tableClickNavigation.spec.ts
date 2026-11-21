import { describe, expect, it } from "vitest";
import { resolveTableClickAction } from "@/lib/sql/tableClickNavigation";

describe("resolveTableClickAction", () => {
  it("opens the data view for plain tables", () => {
    expect(resolveTableClickAction(undefined, "data")).toEqual({ kind: "data" });
    expect(resolveTableClickAction(undefined, "ddl")).toEqual({ kind: "data" });
  });

  it("follows the navigation setting for views", () => {
    expect(resolveTableClickAction("VIEW", "ddl")).toEqual({ kind: "dialog", objectType: "VIEW" });
    expect(resolveTableClickAction("VIEW", "data")).toEqual({ kind: "data" });
  });

  it("follows the navigation setting for materialized views", () => {
    expect(resolveTableClickAction("MATERIALIZED_VIEW", "ddl")).toEqual({ kind: "dialog", objectType: "MATERIALIZED_VIEW" });
    expect(resolveTableClickAction("MATERIALIZED_VIEW", "data")).toEqual({ kind: "data" });
  });

  it("keeps opening the definition dialog for objects that have no data surface", () => {
    for (const sourceKind of ["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "SEQUENCE", "SYNONYM", "TRIGGER"] as const) {
      expect(resolveTableClickAction(sourceKind, "data")).toEqual({ kind: "dialog", objectType: sourceKind });
      expect(resolveTableClickAction(sourceKind, "ddl")).toEqual({ kind: "dialog", objectType: sourceKind });
    }
  });

  it("never treats the remaining object kinds as having a data surface", () => {
    for (const sourceKind of ["EVENT", "JOB", "TYPE", "TYPE_BODY"] as const) {
      expect(resolveTableClickAction(sourceKind, "data")).toEqual({ kind: "dialog", objectType: sourceKind });
      expect(resolveTableClickAction(sourceKind, "ddl")).toEqual({ kind: "dialog", objectType: sourceKind });
    }
  });

  it("falls back to the data view for an unexpected setting value", () => {
    expect(resolveTableClickAction("VIEW", "DDL" as never)).toEqual({ kind: "data" });
  });
});
