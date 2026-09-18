import { describe, expect, it, vi } from "vitest";
import { buildSidebarDdlTemplateSql, formatSidebarDdlTemplateForDisplay, sidebarDdlTargetsForExecutionContext } from "@/lib/sidebar/sidebarDdlTemplate";

describe("sidebar DDL template", () => {
  it("preserves the single-target SQL", async () => {
    const sql = await buildSidebarDdlTemplateSql(
      ["one"],
      async () => "CREATE TABLE one (id INT)",
      async (ddl) => ddl,
    );

    expect(sql).toBe("CREATE TABLE one (id INT)");
  });

  it("loads, formats, and joins multiple targets in order", async () => {
    const loadDdl = vi.fn(async (target: string) => `CREATE TABLE ${target} (id INT)`);
    const formatDdl = vi.fn(async (ddl: string, target: string) => `${ddl} /* ${target} */`);

    const sql = await buildSidebarDdlTemplateSql(["one", "two"], loadDdl, formatDdl);

    expect(loadDdl.mock.calls).toEqual([["one"], ["two"]]);
    expect(formatDdl.mock.calls).toEqual([
      ["CREATE TABLE one (id INT)", "one"],
      ["CREATE TABLE two (id INT)", "two"],
    ]);
    expect(sql).toBe("CREATE TABLE one (id INT) /* one */;\n\nCREATE TABLE two (id INT) /* two */;\n");
  });

  it("applies the database-name setting to a single target", async () => {
    const sql = await buildSidebarDdlTemplateSql(
      [{ databaseType: "oracle" as const, catalog: undefined }],
      async () => 'CREATE TABLE "SYSTEM"."TEST" ("ID" NUMBER)',
      async (ddl, target) => formatSidebarDdlTemplateForDisplay(ddl, "oracle", target.databaseType, false, true, target.catalog),
    );

    expect(sql).toBe('CREATE TABLE "TEST" ("ID" NUMBER)');
  });

  it("keeps external-catalog qualifiers for multiple targets", async () => {
    const targets = [
      { name: "events", catalog: "iceberg" },
      { name: "sessions", catalog: "iceberg" },
    ];
    const sql = await buildSidebarDdlTemplateSql(
      targets,
      async (target) => `CREATE TABLE \`iceberg\`.\`analytics\`.\`${target.name}\` (\`id\` bigint)`,
      async (ddl, target) => formatSidebarDdlTemplateForDisplay(ddl, "mysql", "starrocks", false, false, target.catalog),
    );

    expect(sql).toBe("CREATE TABLE iceberg.analytics.events (id bigint);\n\nCREATE TABLE iceberg.analytics.sessions (id bigint);\n");
  });

  it("keeps DDL targets in the active SQL execution context", () => {
    const active = { id: "active", connectionId: "c1", database: "db1", catalog: "catalog1" };
    const sameContext = { id: "same", connectionId: "c1", database: "db1", catalog: "catalog1" };
    const otherDatabase = { id: "database", connectionId: "c1", database: "db2", catalog: "catalog1" };
    const otherConnection = { id: "connection", connectionId: "c2", database: "db1", catalog: "catalog1" };
    const otherCatalog = { id: "catalog", connectionId: "c1", database: "db1", catalog: "catalog2" };

    expect(sidebarDdlTargetsForExecutionContext(active, [active, otherDatabase, sameContext, otherConnection, otherCatalog])).toEqual([active, sameContext]);
  });
});
