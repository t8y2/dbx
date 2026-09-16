import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identifierInSql } from "@/lib/diagram/fieldLineage";

const fieldLineageSource = readFileSync(new URL("../fieldLineage.ts", import.meta.url), "utf8");

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

  it("does not use runtime lookbehind in the legacy WebView path", () => {
    expect(fieldLineageSource).not.toContain("(?<");
  });
});
