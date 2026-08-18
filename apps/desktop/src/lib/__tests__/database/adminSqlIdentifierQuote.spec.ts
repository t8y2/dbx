import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Admin SQL (drop / empty / truncate / clone / copy) is built in Rust from the database type alone,
 * which cannot describe a database whose quote character depends on the connection. Cloud Spanner is
 * the case that forces the connection-reported quote to be threaded through: GoogleSQL quotes with
 * backticks, its PostgreSQL dialect quotes with double quotes, and the dialect is fixed when the
 * database is created. Emitting the static answer produces admin SQL that is a syntax error for
 * every PostgreSQL-dialect Spanner database.
 *
 * These assertions pin the call sites rather than the generated SQL, because the plumbing is what
 * regressed: the backend already knew how to honour a reported quote (`data_grid_sql.rs` carries the
 * same field) and the builders simply were not given one.
 */
const mutationRuntimeSource = readFileSync(new URL("../../../composables/useSidebarTableMutationRuntime.ts", import.meta.url), "utf8");
const treeRuntimeSource = readFileSync(new URL("../../../components/sidebar/SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");
const objectBrowserSource = readFileSync(new URL("../../../components/objects/ObjectBrowser.vue", import.meta.url), "utf8");
const adminSqlSource = readFileSync(new URL("../../database/dbAdminSql.ts", import.meta.url), "utf8");

describe("admin SQL carries the connection identifier quote", () => {
  it("declares the field on every option type whose SQL qualifies an object name", () => {
    for (const type of ["DropObjectSqlOptions", "TableAdminSqlOptions", "DuplicateTableStructureSqlOptions", "CopyTableDataSqlOptions"]) {
      const body = adminSqlSource.match(new RegExp(`export interface ${type} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
      expect(body, `${type} must accept identifierQuote`).toContain("identifierQuote?: string;");
    }
  });

  it("threads the quote through drop, empty and truncate from the sidebar", () => {
    // Both factories: one reads the active node, the other an explicit node during multi-select.
    expect(mutationRuntimeSource).toMatch(/tableName: activeNode\.value\.label,[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(activeNode\.value\.connectionId\)/);
    expect(mutationRuntimeSource).toMatch(/tableName: node\.label,\s*identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(node\.connectionId\)/);
  });

  it("threads the quote through dropping a view or routine", () => {
    expect(treeRuntimeSource).toMatch(/signature: node\.signature,[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(node\.connectionId\)/);
    expect(objectBrowserSource).toMatch(/buildDropObjectSql\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(props\.connection\.id\)/);
  });

  it("threads the quote through clone and cross-database paste", () => {
    expect(treeRuntimeSource).toMatch(/buildDuplicateTableStructurePlan\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(node\.connectionId\)/);
    expect(treeRuntimeSource).toMatch(/buildDuplicateTableStructurePlan\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(entry\.connectionId\)/);
    expect(objectBrowserSource).toMatch(/buildSharedDuplicateTableStructurePlan\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(props\.connection\.id\)/);
    // The plan helper must forward it to the SQL builder rather than swallowing it.
    expect(adminSqlSource).toMatch(/buildDuplicateTableStructureSql\(\{[\s\S]*?identifierQuote: options\.identifierQuote/);
  });

  it("threads the quote through copying table data", () => {
    expect(treeRuntimeSource).toMatch(/buildCopyTableDataSql\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(entry\.connectionId\)/);
    expect(objectBrowserSource).toMatch(/buildCopyTableDataSql\(\{[\s\S]*?identifierQuote: connectionStore\.connectionIdentifierQuote\?\.\(props\.connection\.id\)/);
  });
});
