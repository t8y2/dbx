import { describe, expect, it } from "vitest";
import { resolveSqlShortcutTableToken } from "@/lib/sql/sqlShortcutTableTarget";

describe("resolveSqlShortcutTableToken", () => {
  it("prefers a non-empty selection over the cursor identifier", () => {
    const doc = "SELECT * FROM schema.orders WHERE id = 1";
    const from = doc.indexOf("orders");
    const to = from + "orders".length;
    expect(
      resolveSqlShortcutTableToken(doc, {
        from,
        to,
        empty: false,
        head: doc.indexOf("schema"),
      }),
    ).toBe("orders");
  });

  it("uses the qualified identifier at the cursor when selection is empty", () => {
    const doc = "SELECT * FROM schema.orders WHERE id = 1";
    const head = doc.indexOf("orders") + 2;
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head })).toBe("schema.orders");
  });

  it("preserves original quotes in the document slice", () => {
    const doc = 'SELECT * FROM "HR"."EMPLOYEES" WHERE 1=1';
    const head = doc.indexOf("EMPLOYEES") + 1;
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head })).toBe('"HR"."EMPLOYEES"');
  });

  it("falls back to the previous character at a token boundary", () => {
    const doc = "SELECT * FROM orders WHERE id = 1";
    const head = doc.indexOf("orders") + "orders".length;
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head })).toBe("orders");
  });

  it("returns null on SQL keywords", () => {
    const doc = "SELECT * FROM orders WHERE id = 1";
    const head = doc.indexOf("WHERE") + 1;
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head })).toBeNull();
  });

  it("returns null when the cursor is not on an identifier", () => {
    const doc = "SELECT * FROM orders WHERE id = 1";
    const head = doc.indexOf("*");
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head })).toBeNull();
  });

  it("returns null for whitespace-only selection", () => {
    const doc = "SELECT  FROM orders";
    expect(resolveSqlShortcutTableToken(doc, { from: 6, to: 8, empty: false, head: 7 })).toBeNull();
  });
});
