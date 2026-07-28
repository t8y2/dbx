import { describe, expect, it } from "vitest";
import { buildOpenTableDefaultSort, buildPrimaryKeyOrderBy } from "@/lib/table/tableDefaultSort";

describe("buildPrimaryKeyOrderBy", () => {
  it.each([
    ["postgres", '"Tenant" ASC, "Order" ASC'],
    ["mysql", "`Tenant` ASC, `Order` ASC"],
    ["sqlserver", "[Tenant] ASC, [Order] ASC"],
    ["oracle", '"Tenant" ASC, "Order" ASC'],
    ["neo4j", "n.`Tenant` ASC, n.`Order` ASC"],
  ] as const)("quotes composite keys for %s", (databaseType, expected) => {
    expect(
      buildPrimaryKeyOrderBy({
        databaseType,
        primaryKeys: ["Tenant", "Order"],
        direction: "asc",
      }),
    ).toBe(expected);
  });

  it("quotes every mixed-case or reserved identifier and applies descending to every key", () => {
    expect(
      buildPrimaryKeyOrderBy({
        databaseType: "postgres",
        primaryKeys: ['Tenant"Id', "select"],
        direction: "desc",
      }),
    ).toBe('"Tenant""Id" DESC, "select" DESC');
  });
});

describe("buildOpenTableDefaultSort", () => {
  it("keeps metadata order for all primary-key columns while using the first key as the grid indicator", () => {
    expect(
      buildOpenTableDefaultSort({
        mode: "primary-key-desc",
        databaseType: "postgres",
        primaryKeys: ["tenant_id", "record_id"],
        columns: ["record_id", "tenant_id", "value"],
      }),
    ).toEqual({
      column: "tenant_id",
      columnIndex: 1,
      direction: "desc",
      orderBy: '"tenant_id" DESC, "record_id" DESC',
    });
  });
});
