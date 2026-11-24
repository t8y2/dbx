import { describe, expect, it } from "vitest";
import {
  buildColumnForeignKeyMap,
  combineForeignKeyConditions,
  foreignKeyAssociationCells,
  foreignKeyAssociationCellsForSource,
  foreignKeyAssociationForRef,
  foreignKeyCellNavigable,
  foreignKeyMetadataRequestCurrent,
  foreignKeyNavigationTarget,
  foreignKeySourceColumnName,
  foreignKeySourceIdentities,
  foreignKeyTableIdentity,
} from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { ForeignKeyInfo, QueryResultSourceColumnRef } from "@/types/database";

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

describe("foreignKeySourceIdentities", () => {
  const refs: Array<QueryResultSourceColumnRef | undefined> = [
    { sourceKey: "orders", sourceColumn: "useruid", schema: "public", tableName: "orders" },
    { sourceKey: "orders", sourceColumn: "total", schema: "public", tableName: "orders" },
    { sourceKey: "users", sourceColumn: "uid", schema: "public", tableName: "users" },
    { sourceKey: "computed", sourceColumn: "expr" },
    undefined,
  ];

  it("deduplica por identidad física preservando el orden de aparición", () => {
    const identities = foreignKeySourceIdentities({ connectionId: "c1", refs });
    expect(identities.map((identity) => [identity.tableName, identity.sourceKey, identity.identity])).toEqual([
      ["orders", "orders", foreignKeyTableIdentity({ connectionId: "c1", schema: "public", tableName: "orders" })],
      ["users", "users", foreignKeyTableIdentity({ connectionId: "c1", schema: "public", tableName: "users" })],
    ]);
  });

  it("sin connectionId no produce identidades", () => {
    expect(foreignKeySourceIdentities({ refs })).toEqual([]);
  });

  it("distingue la misma tabla en schemas distintos", () => {
    const identities = foreignKeySourceIdentities({
      connectionId: "c1",
      refs: [
        { sourceKey: "a", sourceColumn: "uid", schema: "sales", tableName: "users" },
        { sourceKey: "b", sourceColumn: "uid", schema: "hr", tableName: "users" },
      ],
    });
    expect(identities).toHaveLength(2);
  });
});

describe("foreignKeyAssociationForRef", () => {
  const refs: Array<QueryResultSourceColumnRef | undefined> = [
    { sourceKey: "orders", sourceColumn: "useruid", schema: "public", tableName: "orders" },
    { sourceKey: "users", sourceColumn: "uid", schema: "public", tableName: "users" },
    { sourceKey: "orders", sourceColumn: "uid", schema: "public", tableName: "orders" },
    undefined,
  ];
  const ordersIdentity = foreignKeyTableIdentity({ connectionId: "c1", schema: "public", tableName: "orders" })!;
  const usersIdentity = foreignKeyTableIdentity({ connectionId: "c1", schema: "public", tableName: "users" })!;
  const maps = new Map([
    [ordersIdentity, buildColumnForeignKeyMap([fk({ name: "fk_orders_user", column: "useruid", ref_table: "users", ref_column: "uid" })])],
    [usersIdentity, buildColumnForeignKeyMap([fk({ name: "fk_users_tenant", column: "uid", ref_table: "tenants", ref_column: "id" })])],
  ]);

  it("resuelve por ordinal contra el map de su propia tabla fuente", () => {
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs, columnIndex: 0, sourceForeignKeyMaps: maps })?.foreignKey.name).toBe("fk_orders_user");
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs, columnIndex: 1, sourceForeignKeyMaps: maps })?.foreignKey.name).toBe("fk_users_tenant");
  });

  it("nunca cae al map de otra fuente con columna homónima", () => {
    // orders.uid no es FK de orders; no debe saltar con el map de users
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs, columnIndex: 2, sourceForeignKeyMaps: maps })).toBeNull();
  });

  it("devuelve null para ordinales sin ref o con fuente aún no cargada", () => {
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs, columnIndex: 3, sourceForeignKeyMaps: maps })).toBeNull();
    const onlyUsers = new Map([[usersIdentity, maps.get(usersIdentity)!]]);
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs, columnIndex: 0, sourceForeignKeyMaps: onlyUsers })).toBeNull();
  });

  it("empareja sourceColumn sin distinguir mayúsculas", () => {
    const caseRefs: Array<QueryResultSourceColumnRef | undefined> = [{ sourceKey: "orders", sourceColumn: "UserUid", schema: "public", tableName: "orders" }];
    expect(foreignKeyAssociationForRef({ connectionId: "c1", refs: caseRefs, columnIndex: 0, sourceForeignKeyMaps: maps })?.foreignKey.name).toBe("fk_orders_user");
  });
});

describe("foreignKeyAssociationCellsForSource", () => {
  const association = buildColumnForeignKeyMap([fk({ name: "fk_comp", column: "order_id", ref_table: "order_items", ref_column: "order_id" }), fk({ name: "fk_comp", column: "line_no", ref_table: "order_items", ref_column: "line_no" })]).get("order_id")!;
  // ordinal 1 lleva el mismo nombre de columna pero pertenece a OTRA fuente
  const refs: Array<QueryResultSourceColumnRef | undefined> = [
    { sourceKey: "orders", sourceColumn: "order_id", tableName: "orders" },
    { sourceKey: "order_items", sourceColumn: "line_no", tableName: "order_items" },
    { sourceKey: "orders", sourceColumn: "line_no", tableName: "orders" },
  ];

  it("resuelve las parejas compuestas dentro del mismo sourceKey", () => {
    const cells = foreignKeyAssociationCellsForSource({ association, refs, columnIndex: 0, row: [42, 999, 7] });
    expect(cells?.map((cell) => [cell.foreignKey.ref_column, cell.columnIndex, cell.value])).toEqual([
      ["order_id", 0, 42],
      ["line_no", 2, 7],
    ]);
  });

  it("no satisface una pareja faltante con una columna homónima de otra fuente", () => {
    const missingPair: Array<QueryResultSourceColumnRef | undefined> = [refs[0], refs[1]];
    expect(foreignKeyAssociationCellsForSource({ association, refs: missingPair, columnIndex: 0, row: [42, 999] })).toBeUndefined();
  });

  it("rechaza la navegación con valores compuestos nulos o sin sourceKey", () => {
    expect(foreignKeyAssociationCellsForSource({ association, refs, columnIndex: 0, row: [42, 999, null] })).toBeUndefined();
    expect(foreignKeyAssociationCellsForSource({ association, refs: [undefined, refs[1], refs[2]], columnIndex: 0, row: [42, 999, 7] })).toBeUndefined();
  });
});
