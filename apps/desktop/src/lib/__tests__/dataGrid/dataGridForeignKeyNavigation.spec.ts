import { describe, expect, it } from "vitest";
import { buildColumnForeignKeyMap, combineForeignKeyConditions, foreignKeyAssociationCells, foreignKeyCellNavigable, foreignKeyMetadataRequestCurrent, foreignKeyNavigationTarget, foreignKeySourceColumnName, foreignKeyTableIdentity } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
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
    expect(map.get("customer_id")?.foreignKey.ref_table).toBe("customers");
    expect(map.has("Customer_ID")).toBe(false);
  });

  it("ante columnas duplicadas gana la primera entrada", () => {
    const map = buildColumnForeignKeyMap([fk({ name: "fk_a", ref_table: "customers" }), fk({ name: "fk_b", ref_table: "accounts" })]);
    expect(map.get("customer_id")?.foreignKey.name).toBe("fk_a");
  });

  it("agrupa todas las parejas de columnas de una FK compuesta", () => {
    const map = buildColumnForeignKeyMap([fk({ name: "fk_comp", column: "order_id", ref_table: "order_items", ref_column: "order_id" }), fk({ name: "fk_comp", column: "line_no", ref_table: "order_items", ref_column: "line_no" })]);
    expect(map.size).toBe(2);
    expect(map.get("order_id")).toBe(map.get("line_no"));
    expect(map.get("order_id")?.columnPairs.map((pair) => [pair.column, pair.ref_column])).toEqual([
      ["order_id", "order_id"],
      ["line_no", "line_no"],
    ]);
  });

  it("ignora entradas incompletas", () => {
    const map = buildColumnForeignKeyMap([fk({ column: "" }), fk({ column: "a", ref_table: "" }), fk({ column: "b", ref_column: "" })]);
    expect(map.size).toBe(0);
  });
});

describe("foreignKeySourceColumnName", () => {
  it("en resultados SQL solo usa el binding de columna física", () => {
    expect(foreignKeySourceColumnName({ context: "results", resultColumns: ["customer"], sourceColumns: ["customer_id"], columnIndex: 0 })).toBe("customer_id");
    expect(foreignKeySourceColumnName({ context: "results", resultColumns: ["customer_id"], columnIndex: 0 })).toBeUndefined();
  });

  it("en datos de tabla usa el nombre visible si no hay binding separado", () => {
    expect(foreignKeySourceColumnName({ context: "table-data", resultColumns: ["customer_id"], columnIndex: 0 })).toBe("customer_id");
  });
});

describe("foreignKeyAssociationCells", () => {
  const association = buildColumnForeignKeyMap([fk({ name: "fk_comp", column: "order_id", ref_table: "order_items", ref_column: "order_id" }), fk({ name: "fk_comp", column: "line_no", ref_table: "order_items", ref_column: "line_no" })]).get("order_id")!;

  it("resuelve todas las columnas físicas de una FK compuesta en resultados con alias", () => {
    const cells = foreignKeyAssociationCells({
      association,
      context: "results",
      resultColumns: ["order", "line"],
      sourceColumns: ["order_id", "line_no"],
      row: [42, 7],
    });
    expect(cells?.map((cell) => [cell.foreignKey.ref_column, cell.columnIndex, cell.value])).toEqual([
      ["order_id", 0, 42],
      ["line_no", 1, 7],
    ]);
  });

  it("rechaza la navegación si falta un binding físico", () => {
    expect(
      foreignKeyAssociationCells({
        association,
        context: "results",
        resultColumns: ["order", "line_no"],
        sourceColumns: ["order_id", undefined],
        row: [42, 7],
      }),
    ).toBeUndefined();
  });

  it("rechaza la navegación si cualquier valor compuesto es nulo", () => {
    expect(
      foreignKeyAssociationCells({
        association,
        context: "table-data",
        resultColumns: ["order_id", "line_no"],
        row: [42, null],
      }),
    ).toBeUndefined();
  });
});

describe("combineForeignKeyConditions", () => {
  it("combina todas las parejas de una FK compuesta con AND", () => {
    expect(combineForeignKeyConditions(['"order_id" = 42', '"line_no" = 7'])).toBe('("order_id" = 42) AND ("line_no" = 7)');
  });

  it("no construye un filtro parcial", () => {
    expect(combineForeignKeyConditions(['"order_id" = 42', undefined])).toBeUndefined();
  });
});

describe("foreign key metadata request guard", () => {
  it("incluye toda la identidad de tabla", () => {
    const first = foreignKeyTableIdentity({ connectionId: "c1", database: "db", catalog: "cat", schema: "sales", tableName: "orders" });
    const reusedTab = foreignKeyTableIdentity({ connectionId: "c1", database: "db", catalog: "cat", schema: "sales", tableName: "invoices" });
    expect(first).not.toBe(reusedTab);
  });

  it("ignora respuestas de otra tabla o generación", () => {
    const orders = foreignKeyTableIdentity({ connectionId: "c1", database: "db", schema: "sales", tableName: "orders" })!;
    const invoices = foreignKeyTableIdentity({ connectionId: "c1", database: "db", schema: "sales", tableName: "invoices" })!;
    expect(foreignKeyMetadataRequestCurrent({ requestGeneration: 3, currentGeneration: 3, requestIdentity: orders, currentIdentity: orders })).toBe(true);
    expect(foreignKeyMetadataRequestCurrent({ requestGeneration: 3, currentGeneration: 4, requestIdentity: orders, currentIdentity: orders })).toBe(false);
    expect(foreignKeyMetadataRequestCurrent({ requestGeneration: 3, currentGeneration: 3, requestIdentity: orders, currentIdentity: invoices })).toBe(false);
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
