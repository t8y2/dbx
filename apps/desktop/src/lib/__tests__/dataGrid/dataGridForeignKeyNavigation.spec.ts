import { describe, expect, it } from "vitest";
import {
  buildColumnForeignKeyAssociationsMap,
  buildColumnForeignKeyMap,
  combineForeignKeyConditions,
  foreignKeyAssociationCells,
  foreignKeyCellNavigable,
  foreignKeyMetadataRequestCurrent,
  foreignKeyNavigationTarget,
  foreignKeySourceColumnName,
  foreignKeyTableIdentity,
  formatForeignKeyTargetLabel,
} from "@/lib/dataGrid/dataGridForeignKeyNavigation";
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

  it("resuelve columnas en resultados SQL SELECT * o no editables mediante displaySourceColumns", () => {
    const displaySourceColumns = [
      { sourceKey: "t0", sourceColumn: "ID", schema: "PUBLIC", tableName: "DS_CUSTOMER" },
      { sourceKey: "t0", sourceColumn: "DISPLAY_NAME", schema: "PUBLIC", tableName: "DS_CUSTOMER" },
    ];
    expect(
      foreignKeySourceColumnName({
        context: "results",
        resultColumns: ["ID", "DISPLAY_NAME"],
        sourceColumns: undefined,
        displaySourceColumns,
        expectedTableName: "DS_CUSTOMER",
        columnIndex: 0,
      }),
    ).toBe("ID");
    // Unmapped expression / aggregate stays undefined
    expect(
      foreignKeySourceColumnName({
        context: "results",
        resultColumns: ["ID"],
        sourceColumns: undefined,
        displaySourceColumns: [undefined],
        expectedTableName: "DS_CUSTOMER",
        columnIndex: 0,
      }),
    ).toBeUndefined();
  });

  it("aisla columnas por sourceKey en consultas JOIN multitabla", () => {
    const displaySourceColumns = [
      { sourceKey: "o", sourceColumn: "ID", schema: "PUBLIC", tableName: "ORDERS" },
      { sourceKey: "o", sourceColumn: "CUSTOMER_ID", schema: "PUBLIC", tableName: "ORDERS" },
      { sourceKey: "c", sourceColumn: "ID", schema: "PUBLIC", tableName: "CUSTOMERS" },
    ];
    expect(
      foreignKeySourceColumnName({
        context: "results",
        resultColumns: ["ID", "CUSTOMER_ID", "CID"],
        displaySourceColumns,
        expectedSourceKey: "c",
        columnIndex: 0,
      }),
    ).toBeUndefined();
    expect(
      foreignKeySourceColumnName({
        context: "results",
        resultColumns: ["ID", "CUSTOMER_ID", "CID"],
        displaySourceColumns,
        expectedSourceKey: "c",
        columnIndex: 2,
      }),
    ).toBe("ID");
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

  it("toma el valor exacto del sourceKey en resultados JOIN con columnas homónimas", () => {
    const customerIdFk = buildColumnForeignKeyMap([fk({ name: "dbx_vfk:r1:rev", column: "ID", ref_table: "ORDERS", ref_column: "CUSTOMER_ID" })]).get("id")!;
    const cells = foreignKeyAssociationCells({
      association: customerIdFk,
      context: "results",
      resultColumns: ["ID", "CUSTOMER_ID", "CUST_ID"],
      sourceColumns: undefined,
      displaySourceColumns: [
        { sourceKey: "o", sourceColumn: "ID", schema: "PUBLIC", tableName: "ORDERS" },
        { sourceKey: "o", sourceColumn: "CUSTOMER_ID", schema: "PUBLIC", tableName: "ORDERS" },
        { sourceKey: "c", sourceColumn: "ID", schema: "PUBLIC", tableName: "CUSTOMERS" },
      ],
      expectedSourceKey: "c",
      row: [101, 7, 7],
    });
    expect(cells).toEqual([{ foreignKey: customerIdFk.foreignKey, columnIndex: 2, value: 7 }]);
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

  it("en MySQL navega a la base de datos de ref_schema y vacía schema", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: "other_db", ref_table: "tb_company", ref_column: "id" }),
      databaseType: "mysql",
    });
    expect(target.database).toBe("other_db");
    expect(target.schema).toBeUndefined();
    expect(target.tableName).toBe("tb_company");
    expect(target.columnName).toBe("id");
  });

  it("con conexión nativa MySQL resuelve target.database según ref_schema", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: "other_db", ref_table: "tb_company" }),
      connection: { db_type: "mysql" },
    });
    expect(target.database).toBe("other_db");
    expect(target.schema).toBeUndefined();
  });

  it("en MySQL sin ref_schema mantiene la base de datos actual", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: null, ref_table: "tb_company" }),
      databaseType: "mysql",
    });
    expect(target.database).toBe("db_vrent");
    expect(target.schema).toBeUndefined();
  });

  it("con conexión JDBC MySQL navega a la base de datos de ref_schema", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: "other_db", ref_table: "tb_company" }),
      connection: { db_type: "jdbc", driver_profile: "mysql" },
    });
    expect(target.database).toBe("other_db");
    expect(target.schema).toBeUndefined();
  });

  it("en bases con esquema (PostgreSQL) preserva database y asigna ref_schema como schema", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "app_db",
      currentSchema: "public",
      fk: fk({ ref_schema: "sales", ref_table: "customers" }),
      databaseType: "postgres",
      connection: { db_type: "postgres" },
    });
    expect(target.database).toBe("app_db");
    expect(target.schema).toBe("sales");
  });

  it("con objeto de conexión sin db_type pero databaseType postgres preserva schema", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "app_db",
      currentSchema: "public",
      fk: fk({ ref_schema: "sales", ref_table: "customers" }),
      databaseType: "postgres",
      connection: {},
    });
    expect(target.database).toBe("app_db");
    expect(target.schema).toBe("sales");
  });

  it("en MySQL con ref_schema de espacios en blanco cae a database actual", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: "   ", ref_table: "tb_company" }),
      databaseType: "mysql",
    });
    expect(target.database).toBe("db_vrent");
    expect(target.schema).toBeUndefined();
  });

  it("en MySQL con ref_schema con espacios recorta el nombre del destino", () => {
    const target = foreignKeyNavigationTarget({
      connectionId: "c1",
      database: "db_vrent",
      fk: fk({ ref_schema: "  other_db  ", ref_table: "tb_company" }),
      databaseType: "mysql",
    });
    expect(target.database).toBe("other_db");
    expect(target.schema).toBeUndefined();
  });
});

describe("buildColumnForeignKeyAssociationsMap with virtual foreign keys", () => {
  it("keeps physical foreign keys first, deduplicates identical virtual targets, and retains extra virtual targets", () => {
    const physical = [fk({ name: "fk_real_customer", column: "customer_id", ref_schema: "public", ref_table: "customers", ref_column: "id" })];
    const virtual = [
      fk({ name: "dbx_vfk:r1:fwd", column: "customer_id", ref_schema: "public", ref_table: "customers", ref_column: "id" }),
      fk({ name: "dbx_vfk:r2:fwd", column: "customer_id", ref_schema: "crm", ref_table: "customer_profiles", ref_column: "customer_id" }),
      fk({ name: "dbx_vfk:r3:rev", column: "id", ref_schema: "public", ref_table: "order_items", ref_column: "order_id" }),
      fk({ name: "dbx_vfk:r4:rev", column: "id", ref_schema: "public", ref_table: "shipments", ref_column: "order_id" }),
    ];

    const map = buildColumnForeignKeyAssociationsMap(physical, virtual);
    const customerTargets = map.get("customer_id") ?? [];
    expect(customerTargets).toHaveLength(2);
    expect(customerTargets[0]?.virtual).toBeUndefined();
    expect(customerTargets[0]?.foreignKey.ref_table).toBe("customers");
    expect(customerTargets[1]?.virtual).toBe(true);
    expect(customerTargets[1]?.foreignKey.ref_table).toBe("customer_profiles");

    const idTargets = map.get("id") ?? [];
    expect(idTargets.map((item) => item.foreignKey.ref_table)).toEqual(["order_items", "shipments"]);
    expect(idTargets.every((item) => item.virtual)).toBe(true);
  });

  it("formats target labels omitting the current schema when unchanged", () => {
    expect(formatForeignKeyTargetLabel(fk({ ref_schema: "public", ref_table: "customers", ref_column: "id" }), "public")).toBe("customers.id");
    expect(formatForeignKeyTargetLabel(fk({ ref_schema: "crm", ref_table: "customers", ref_column: "id" }), "public")).toBe("crm.customers.id");
  });
});
