import { describe, expect, it } from "vitest";
import { buildColumnForeignKeyMap, foreignKeyCellNavigable, foreignKeyNavigationTarget } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { ForeignKeyInfo } from "@/types/database";

function fk(overrides: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo {
  return {
    name: "fk_orders_customer",
    column: "customer_id",
    ref_schema: "public",
    ref_table: "customers",
    ref_column: "id",
    ...overrides,
  };
}

describe("buildColumnForeignKeyMap", () => {
  it("indexa por nombre de columna en minúsculas", () => {
    const map = buildColumnForeignKeyMap([fk({ column: "Customer_ID" })]);
    expect(map.get("customer_id")?.ref_table).toBe("customers");
    expect(map.has("Customer_ID")).toBe(false);
  });

  it("ante columnas duplicadas gana la primera entrada", () => {
    const map = buildColumnForeignKeyMap([fk({ name: "fk_a", ref_table: "customers" }), fk({ name: "fk_b", ref_table: "accounts" })]);
    expect(map.get("customer_id")?.name).toBe("fk_a");
  });

  it("FK compuesta genera una entrada por columna con su ref_column propia", () => {
    const map = buildColumnForeignKeyMap([fk({ name: "fk_comp", column: "order_id", ref_table: "order_items", ref_column: "order_id" }), fk({ name: "fk_comp", column: "line_no", ref_table: "order_items", ref_column: "line_no" })]);
    expect(map.size).toBe(2);
    expect(map.get("order_id")?.ref_column).toBe("order_id");
    expect(map.get("line_no")?.ref_column).toBe("line_no");
  });

  it("ignora entradas incompletas", () => {
    const map = buildColumnForeignKeyMap([fk({ column: "" }), fk({ column: "a", ref_table: "" }), fk({ column: "b", ref_column: "" })]);
    expect(map.size).toBe(0);
  });
});

describe("foreignKeyCellNavigable", () => {
  it("null y undefined no son navegables", () => {
    expect(foreignKeyCellNavigable(null)).toBe(false);
    expect(foreignKeyCellNavigable(undefined)).toBe(false);
  });

  it("0, cadena vacía y false son valores FK legítimos", () => {
    expect(foreignKeyCellNavigable(0)).toBe(true);
    expect(foreignKeyCellNavigable("")).toBe(true);
    expect(foreignKeyCellNavigable(false)).toBe(true);
  });
});

describe("foreignKeyNavigationTarget", () => {
  it("usa ref_schema cuando está presente", () => {
    const target = foreignKeyNavigationTarget({ connectionId: "c1", database: "db", currentSchema: "app", fk: fk({ ref_schema: "sales" }) });
    expect(target.schema).toBe("sales");
    expect(target.tableName).toBe("customers");
    expect(target.columnName).toBe("id");
    expect(target.connectionId).toBe("c1");
    expect(target.database).toBe("db");
  });

  it("sin ref_schema cae al schema actual", () => {
    const target = foreignKeyNavigationTarget({ connectionId: "c1", database: "db", currentSchema: "app", fk: fk({ ref_schema: null }) });
    expect(target.schema).toBe("app");
  });

  it("sin ref_schema ni schema actual queda undefined", () => {
    const target = foreignKeyNavigationTarget({ connectionId: "c1", database: "db", fk: fk({ ref_schema: undefined }) });
    expect(target.schema).toBeUndefined();
  });

  it("propaga whereInput", () => {
    const target = foreignKeyNavigationTarget({ connectionId: "c1", database: "db", fk: fk(), whereInput: '"id" = 7' });
    expect(target.whereInput).toBe('"id" = 7');
  });
});
