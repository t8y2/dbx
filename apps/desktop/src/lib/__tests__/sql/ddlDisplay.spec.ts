import { describe, expect, it } from "vitest";
import { alignDdlColumnDefinitions, uppercaseDdlColumnTypes } from "@/lib/sql/ddlDisplay";

describe("alignDdlColumnDefinitions", () => {
  it("aligns column names, types, nullability, defaults, and comments", () => {
    const sql = `CREATE TABLE events (
  id bigint NOT NULL AUTO_INCREMENT COMMENT 'primary id',
  project_id bigint unsigned NOT NULL COMMENT 'project default NOT NULL',
  status varchar(24) DEFAULT NULL COMMENT 'status DEFAULT',
  active tinyint DEFAULT 1 NOT NULL COMMENT 'enabled',
  PRIMARY KEY (id)
);`;

    const formatted = alignDdlColumnDefinitions(sql, "mysql");
    const lines = formatted.split("\n");
    const columnLines = lines.filter((line) => /^\s+(?:id|project_id|status|active)\s/.test(line));
    const typePositions = columnLines.map((line) => line.search(/\b(?:bigint|varchar|tinyint)\b/));
    const nullablePositions = columnLines.filter((line) => line.includes("NOT NULL")).map((line) => line.indexOf("NOT NULL"));
    const defaultPositions = columnLines.filter((line) => line.includes("DEFAULT")).map((line) => line.indexOf("DEFAULT"));
    const commentPositions = columnLines.map((line) => line.indexOf("COMMENT"));

    expect(columnLines).toHaveLength(4);
    expect(new Set(typePositions).size).toBe(1);
    expect(new Set(nullablePositions).size).toBe(1);
    expect(new Set(defaultPositions).size).toBe(1);
    expect(new Set(commentPositions).size).toBe(1);
    expect(lines.find((line) => line.includes("PRIMARY KEY"))).toBe("  PRIMARY KEY (id)");
    expect(formatted).toContain("'project default NOT NULL'");
  });

  it("leaves non-table SQL unchanged", () => {
    const sql = "SELECT id, name FROM customers;";

    expect(alignDdlColumnDefinitions(sql, "mysql")).toBe(sql);
  });

  it("leaves view definitions unchanged", () => {
    const sql = `CREATE VIEW customer_summary AS
SELECT customer_id, COUNT(*) AS total
FROM customer_events
GROUP BY customer_id;`;

    expect(alignDdlColumnDefinitions(sql, "mysql")).toBe(sql);
  });
});

describe("uppercaseDdlColumnTypes", () => {
  it("uppercases table column types without changing identifiers, defaults, or comments", () => {
    const sql = `CREATE TABLE events (
  id bigint unsigned NOT NULL DEFAULT 0 COMMENT 'bigint not null',
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  label varchar(40) DEFAULT 'varchar default'
);`;

    const formatted = uppercaseDdlColumnTypes(sql, "postgres");

    expect(formatted).toContain("id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'bigint not null'");
    expect(formatted).toContain("created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP");
    expect(formatted).toContain("label VARCHAR(40) DEFAULT 'varchar default'");
  });

  it("leaves non-table SQL unchanged", () => {
    const sql = "SELECT id bigint FROM events;";

    expect(uppercaseDdlColumnTypes(sql, "postgres")).toBe(sql);
  });
});
