import { describe, expect, it } from "vitest";
import { filterFieldLineageHistory, identifierInSql } from "@/lib/diagram/fieldLineage";

describe("filterFieldLineageHistory", () => {
  const history = [
    { id: "same-connection", connection_id: "xugu-1", database: "SYSTEM", sql: "select 1" },
    { id: "other-connection", connection_id: "xugu-2", database: "SYSTEM", sql: "select 2" },
    { id: "other-database", connection_id: "xugu-1", database: "SHOP_DEMO", sql: "select 3" },
    { id: "legacy", database: "SYSTEM", sql: "select 4" },
    { id: "no-database", connection_id: "xugu-1", database: "", sql: "select 5" },
  ];

  it("keeps the existing database-only scope for non-Xugu callers", () => {
    expect(filterFieldLineageHistory(history, { database: "SYSTEM", connectionId: "xugu-1" }).map((entry) => entry.id)).toEqual(["same-connection", "other-connection", "legacy", "no-database"]);
  });

  it("can require an exact connection match for Xugu and excludes legacy unscoped history", () => {
    expect(filterFieldLineageHistory(history, { database: "SYSTEM", connectionId: "xugu-1", requireConnectionMatch: true }).map((entry) => entry.id)).toEqual(["same-connection", "no-database"]);
  });
});

describe("identifierInSql", () => {
  it("matches unquoted identifiers at the start or after punctuation", () => {
    expect(identifierInSql("customer_id = 1", "customer_id")).toBe(true);
    expect(identifierInSql("SELECT account.customer_id", "customer_id")).toBe(true);
    expect(identifierInSql("SELECT (CUSTOMER_ID)", "customer_id")).toBe(true);
  });

  it("does not match identifiers embedded in longer identifiers", () => {
    expect(identifierInSql("SELECT customer_identifier", "customer_id")).toBe(false);
    expect(identifierInSql("SELECT archived_customer_id", "customer_id")).toBe(false);
    expect(identifierInSql("SELECT customer_id_v2", "customer_id")).toBe(false);
    expect(identifierInSql("SELECT $customer_id", "customer_id")).toBe(false);
  });

  it("matches identifiers quoted with supported SQL delimiters", () => {
    expect(identifierInSql('SELECT "customer_id"', "customer_id")).toBe(true);
    expect(identifierInSql("SELECT `customer_id`", "customer_id")).toBe(true);
    expect(identifierInSql("SELECT [customer_id]", "customer_id")).toBe(true);
  });
});
