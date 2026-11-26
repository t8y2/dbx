// Review follow-up (#14905): MySQL-family quoted identifiers may keep leading or
// trailing spaces, so ` orders` is a different table from `orders`. The list used
// to show both as "orders" because only the trimmed display text was rendered;
// these specs pin the marker data the name column now draws.

import { describe, expect, it } from "vitest";
import { buildObjectBrowserRows, objectBrowserNameTooltip } from "./objectBrowserRows";

function tableRow(name: string) {
  return { name, object_type: "TABLE", schema: null, comment: null, created_at: null, updated_at: null, parent_schema: null, parent_name: null };
}

function build(databaseType: "mysql" | "postgres", names: string[]) {
  return buildObjectBrowserRows({ database: "shop", fallbackSchema: "shop", databaseType, objects: names.map((name) => tableRow(name)) });
}

describe("object browser name whitespace markers", () => {
  it("keeps a space-padded MySQL table distinguishable from the trimmed one", () => {
    const rows = build("mysql", [" orders", "orders"]);

    // The server identifier stays exact for DDL…
    expect(rows.map((row) => row.name)).toEqual([" orders", "orders"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    // …both render the same trimmed text…
    expect(rows.map((row) => row.displayName)).toEqual(["orders", "orders"]);
    // …and only the marker plus the quoted tooltip tell them apart.
    expect(rows[0].nameSpaces).toEqual({ leading: true, trailing: false });
    expect(rows[1].nameSpaces).toBeUndefined();
    expect(objectBrowserNameTooltip(rows[0])).toBe("` orders`");
    expect(objectBrowserNameTooltip(rows[1])).toBe("orders");
  });

  it("marks a trailing space and keeps the exact name in the tooltip", () => {
    const [row] = build("mysql", ["orders "]);

    expect(row.name).toBe("orders ");
    expect(row.displayName).toBe("orders");
    expect(row.nameSpaces).toEqual({ leading: false, trailing: true });
    expect(objectBrowserNameTooltip(row)).toBe("`orders `");
  });

  it("adds no marker for names that carry no surrounding whitespace", () => {
    for (const row of build("mysql", ["orders", "customers"])) expect(row.nameSpaces).toBeUndefined();
  });

  it("leaves dialects that normalize identifiers without markers", () => {
    // PostgreSQL quotes cannot hold surrounding spaces, so the name is normalized
    // away and there is nothing to distinguish.
    const [row] = build("postgres", [" orders"]);

    expect(row.name).toBe("orders");
    expect(row.displayName).toBe("orders");
    expect(row.nameSpaces).toBeUndefined();
  });
});
