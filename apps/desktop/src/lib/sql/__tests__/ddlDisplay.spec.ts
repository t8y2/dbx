import { describe, expect, it } from "vitest";
import { omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";

describe("omitDdlIdentifierQuotes", () => {
  it("removes safe MySQL identifier quotes without changing literals or comments", () => {
    const ddl = "CREATE TABLE `demo_table` (`id` int DEFAULT 'a`b') COMMENT='`keep`'; -- `keep`";
    expect(omitDdlIdentifierQuotes(ddl, "mysql")).toBe("CREATE TABLE demo_table (id int DEFAULT 'a`b') COMMENT='`keep`'; -- `keep`");
  });

  it("keeps quotes for names that require them", () => {
    expect(omitDdlIdentifierQuotes("CREATE TABLE `order` (`with space` int)", "mysql")).toBe("CREATE TABLE `order` (`with space` int)");
  });

  it("supports PostgreSQL and SQL Server identifier delimiters", () => {
    expect(omitDdlIdentifierQuotes('CREATE TABLE "demo_table" ("id" integer)', "postgres")).toBe("CREATE TABLE demo_table (id integer)");
    expect(omitDdlIdentifierQuotes("CREATE TABLE [demo_table] ([id] int)", "sqlserver")).toBe("CREATE TABLE demo_table (id int)");
  });

  it("keeps brackets on SQL Server reserved words while unquoting safe names", () => {
    const ddl = "CREATE TABLE [demo_table] ([order] int, [key] int, [user] nvarchar(50), [id] int)";
    expect(omitDdlIdentifierQuotes(ddl, "sqlserver")).toBe("CREATE TABLE demo_table ([order] int, [key] int, [user] nvarchar(50), id int)");
  });
});
