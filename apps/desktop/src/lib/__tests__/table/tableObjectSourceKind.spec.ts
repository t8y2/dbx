import { describe, expect, it } from "vitest";
import { tableObjectSourceKind } from "@/lib/table/tableObjectSourceKind";

describe("tableObjectSourceKind", () => {
  it("routes views to object-source DDL", () => {
    expect(tableObjectSourceKind("VIEW")).toBe("VIEW");
    expect(tableObjectSourceKind("materialized view")).toBe("MATERIALIZED_VIEW");
  });

  it("keeps regular tables on table DDL generation", () => {
    expect(tableObjectSourceKind("BASE TABLE")).toBeUndefined();
    expect(tableObjectSourceKind("TABLE")).toBeUndefined();
  });
});
