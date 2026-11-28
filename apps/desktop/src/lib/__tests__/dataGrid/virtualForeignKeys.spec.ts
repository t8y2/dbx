import { describe, expect, it } from "vitest";
import {
  exportPortableVirtualForeignKeyBundle,
  formatVirtualForeignKeyEndpoint,
  isVirtualForeignKeyName,
  mergeVirtualForeignKeyRules,
  normalizeVirtualForeignKeyRules,
  parsePortableVirtualForeignKeyBundle,
  upsertVirtualForeignKeyRule,
  virtualForeignKeyRuleIdFromName,
  virtualForeignKeysForConnection,
  virtualForeignKeysForTable,
  virtualForeignKeysTouchingTable,
  type VirtualForeignKeyRule,
} from "@/lib/dataGrid/virtualForeignKeys";

describe("virtualForeignKeys normalization and storage", () => {
  it("normalizes rules, drops self-references, and merges reversed pairs into bidirectional", () => {
    const normalized = normalizeVirtualForeignKeyRules([
      {
        connectionId: "conn-1",
        source: { database: "app", schema: "public", table: "orders", column: "customer_id" },
        target: { database: "app", schema: "public", table: "customers", column: "id" },
        bidirectional: false,
      },
      {
        connectionId: "conn-1",
        source: { database: "APP", schema: "PUBLIC", table: "CUSTOMERS", column: "ID" },
        target: { database: "APP", schema: "PUBLIC", table: "ORDERS", column: "CUSTOMER_ID" },
        bidirectional: false,
        note: "Order customer relation",
      },
      {
        connectionId: "conn-1",
        source: { table: "orders", column: "id" },
        target: { table: "ORDERS", column: "ID" },
        bidirectional: true,
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.bidirectional).toBe(true);
    expect(normalized[0]?.note).toBe("Order customer relation");
    expect(normalized[0]?.id).toMatch(/^vfk_/);
  });

  it("upserts new rules and upgrades existing direction when adding reverse", () => {
    const afterFirst = upsertVirtualForeignKeyRule([], {
      connectionId: "conn-1",
      source: { schema: "public", table: "ds_order", column: "customer_id" },
      target: { schema: "public", table: "ds_customer", column: "id" },
      bidirectional: false,
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.bidirectional).toBe(false);

    const afterReverse = upsertVirtualForeignKeyRule(afterFirst, {
      connectionId: "conn-1",
      source: { schema: "public", table: "ds_customer", column: "id" },
      target: { schema: "public", table: "ds_order", column: "customer_id" },
      bidirectional: false,
    });
    expect(afterReverse).toHaveLength(1);
    expect(afterReverse[0]?.bidirectional).toBe(true);
  });
});

describe("virtualForeignKeysForTable projection", () => {
  const rules: VirtualForeignKeyRule[] = normalizeVirtualForeignKeyRules([
    {
      id: "rule-order-customer",
      connectionId: "pg-1",
      source: { database: "shop", schema: "public", table: "orders", column: "customer_id" },
      target: { database: "shop", schema: "crm", table: "customers", column: "id" },
      bidirectional: true,
    },
    {
      id: "rule-invoice-customer",
      connectionId: "pg-1",
      source: { database: "shop", schema: "billing", table: "invoices", column: "customer_id" },
      target: { database: "shop", schema: "crm", table: "customers", column: "id" },
      bidirectional: true,
    },
    {
      id: "rule-mysql-cross-db",
      connectionId: "mysql-1",
      source: { database: "trade_db", table: "t_order", column: "user_id" },
      target: { database: "account_db", table: "t_user", column: "id" },
      bidirectional: true,
    },
  ]);

  it("projects forward and bidirectional multi-target edges for schema-aware databases", () => {
    const forward = virtualForeignKeysForTable(rules, {
      connectionId: "pg-1",
      database: "shop",
      schema: "public",
      tableName: "ORDERS",
      databaseTreeHierarchy: false,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({
      column: "customer_id",
      ref_schema: "crm",
      ref_table: "customers",
      ref_column: "id",
    });
    expect(isVirtualForeignKeyName(forward[0]?.name)).toBe(true);
    expect(virtualForeignKeyRuleIdFromName(forward[0]?.name)).toBe("rule-order-customer");

    const reverse = virtualForeignKeysForTable(rules, {
      connectionId: "pg-1",
      database: "shop",
      schema: "crm",
      tableName: "customers",
      databaseTreeHierarchy: false,
    });
    expect(reverse.map((fk) => `${fk.column}->${fk.ref_schema}.${fk.ref_table}.${fk.ref_column}`)).toEqual(["id->public.orders.customer_id", "id->billing.invoices.customer_id"]);
  });

  it("projects cross-database ref_schema for MySQL database-tree hierarchy", () => {
    const forward = virtualForeignKeysForTable(rules, {
      connectionId: "mysql-1",
      database: "trade_db",
      schema: "",
      tableName: "t_order",
      databaseTreeHierarchy: true,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({
      column: "user_id",
      ref_schema: "account_db",
      ref_table: "t_user",
      ref_column: "id",
    });

    const reverse = virtualForeignKeysForTable(rules, {
      connectionId: "mysql-1",
      database: "account_db",
      schema: "",
      tableName: "t_user",
      databaseTreeHierarchy: true,
    });
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({
      column: "id",
      ref_schema: "trade_db",
      ref_table: "t_order",
      ref_column: "user_id",
    });
  });

  it("does not leak rules across different connections or schemas", () => {
    expect(
      virtualForeignKeysForTable(rules, {
        connectionId: "pg-other",
        database: "shop",
        schema: "public",
        tableName: "orders",
        databaseTreeHierarchy: false,
      }),
    ).toEqual([]);

    expect(
      virtualForeignKeysForTable(rules, {
        connectionId: "pg-1",
        database: "shop",
        schema: "archive",
        tableName: "orders",
        databaseTreeHierarchy: false,
      }),
    ).toEqual([]);

    expect(virtualForeignKeysForConnection(rules, "pg-1")).toHaveLength(2);
    expect(
      virtualForeignKeysTouchingTable(rules, {
        connectionId: "pg-1",
        database: "shop",
        schema: "crm",
        tableName: "customers",
        databaseTreeHierarchy: false,
      }),
    ).toHaveLength(2);
  });
});

describe("portable JSON bundle import and export", () => {
  it("round-trips portable JSON and merges cleanly into a connection", () => {
    const initial = normalizeVirtualForeignKeyRules([
      {
        connectionId: "conn-a",
        source: { schema: "PUBLIC", table: "DS_ORDER", column: "CUSTOMER_ID" },
        target: { schema: "PUBLIC", table: "DS_CUSTOMER", column: "ID" },
        bidirectional: false,
        note: "Order customer",
      },
      {
        connectionId: "conn-b",
        source: { table: "logs", column: "actor_id" },
        target: { table: "users", column: "id" },
        bidirectional: false,
      },
    ]);

    const exported = exportPortableVirtualForeignKeyBundle(virtualForeignKeysForConnection(initial, "conn-a"));
    const parsed = parsePortableVirtualForeignKeyBundle(exported);
    expect(parsed.error).toBeUndefined();
    expect(parsed.rules).toHaveLength(1);
    expect(formatVirtualForeignKeyEndpoint(parsed.rules[0]!.source)).toBe("PUBLIC.DS_ORDER.CUSTOMER_ID");

    const merged = mergeVirtualForeignKeyRules(initial, "conn-a", [
      ...parsed.rules,
      {
        source: { schema: "PUBLIC", table: "DS_CUSTOMER", column: "ID" },
        target: { schema: "PUBLIC", table: "DS_ORDER", column: "CUSTOMER_ID" },
        bidirectional: false,
      },
      {
        source: { schema: "PUBLIC", table: "DS_PAYMENT", column: "ORDER_ID" },
        target: { schema: "PUBLIC", table: "DS_ORDER", column: "ID" },
        bidirectional: true,
      },
    ]);

    expect(merged.added).toBe(1);
    expect(merged.upgraded).toBe(1);
    expect(virtualForeignKeysForConnection(merged.rules, "conn-a")).toHaveLength(2);
    expect(virtualForeignKeysForConnection(merged.rules, "conn-a")[0]?.bidirectional).toBe(true);
    expect(virtualForeignKeysForConnection(merged.rules, "conn-b")).toHaveLength(1);
  });

  it("rejects invalid JSON, unsupported versions, unknown fields, and self-references", () => {
    expect(parsePortableVirtualForeignKeyBundle("{not-json").error).toBeTruthy();
    expect(parsePortableVirtualForeignKeyBundle(JSON.stringify({ version: 2, rules: [] })).error).toContain("Unsupported version");
    expect(parsePortableVirtualForeignKeyBundle(JSON.stringify([{ source: { table: "orders", column: "id", extra: "bad" }, target: { table: "users", column: "id" } }])).error).toContain('unsupported field "extra"');
    expect(parsePortableVirtualForeignKeyBundle(JSON.stringify([{ source: { table: "orders", column: "id" }, target: { table: "ORDERS", column: "ID" } }])).error).toContain("same column");
  });
});
