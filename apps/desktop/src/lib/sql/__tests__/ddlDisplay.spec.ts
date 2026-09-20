import { describe, expect, it } from "vitest";
import { formatGeneratedDdlIdentifierQuotes, omitDdlDatabaseQualifier, omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";

describe("omitDdlDatabaseQualifier", () => {
  it("drops the schema qualifier from Oracle table DDL without touching tablespace references", () => {
    const ddl = 'CREATE TABLE "SYSTEM"."TEST" ("ABC" CLOB) TABLESPACE "SYSTEM";';
    expect(omitDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('CREATE TABLE "TEST" ("ABC" CLOB) TABLESPACE "SYSTEM";');
  });

  it("drops the qualifier from generated ALTER statements and keeps column references", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" ADD ("CDE" CLOB); COMMENT ON COLUMN "SYSTEM"."TEST"."CDE" IS \'note\';';
    expect(omitDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('ALTER TABLE "TEST" ADD ("CDE" CLOB); COMMENT ON COLUMN "TEST"."CDE" IS \'note\';');
  });

  it("drops the qualifier from PostgreSQL, MySQL, and Dameng table references", () => {
    expect(omitDdlDatabaseQualifier('CREATE TABLE "public"."users" ("id" integer)', "postgres", "postgres", false)).toBe('CREATE TABLE "users" ("id" integer)');
    expect(omitDdlDatabaseQualifier("CREATE TABLE `analytics`.`events` (`id` int)", "mysql", "mysql", false)).toBe("CREATE TABLE `events` (`id` int)");
    expect(omitDdlDatabaseQualifier('ALTER TABLE "APP"."T1" ADD ("C1" INT);', "dameng", "dameng", false)).toBe('ALTER TABLE "T1" ADD ("C1" INT);');
  });

  it("drops both qualifiers of CREATE INDEX ... ON and DROP INDEX targets", () => {
    const ddl = 'CREATE INDEX "SYSTEM"."IDX_T" ON "SYSTEM"."TEST" ("ABC"); DROP INDEX "SYSTEM"."IDX_T";';
    expect(omitDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('CREATE INDEX "IDX_T" ON "TEST" ("ABC"); DROP INDEX "IDX_T";');
  });

  it("handles comma-separated DROP TABLE lists and TRUNCATE", () => {
    expect(omitDdlDatabaseQualifier('DROP TABLE "public"."a", "public"."b";', "postgres", "postgres", false)).toBe('DROP TABLE "a", "b";');
    expect(omitDdlDatabaseQualifier('TRUNCATE TABLE "public"."a";', "postgres", "postgres", false)).toBe('TRUNCATE TABLE "a";');
  });

  it("keeps the qualifier when the preference is enabled, the dialect needs it, or the type is unknown", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" ADD ("CDE" CLOB);';
    expect(omitDdlDatabaseQualifier(ddl, "oracle", "oracle", true)).toBe(ddl);
    expect(omitDdlDatabaseQualifier("ALTER TABLE [dbo].[t] ADD [c] int;", "sqlserver", "sqlserver", false)).toBe("ALTER TABLE [dbo].[t] ADD [c] int;");
    expect(omitDdlDatabaseQualifier(ddl, "oracle", undefined, false)).toBe(ddl);
  });

  it("keeps Doris and StarRocks external-catalog qualifiers", () => {
    const dorisDdl = "ALTER TABLE `iceberg`.`analytics`.`events` ADD COLUMN `source` STRING;";
    const starrocksDdl = "CREATE TABLE `hive`.`events` (`id` bigint);";

    expect(omitDdlDatabaseQualifier(dorisDdl, "mysql", "doris", false, "iceberg")).toBe(dorisDdl);
    expect(omitDdlDatabaseQualifier(starrocksDdl, "mysql", "starrocks", false, "hive")).toBe(starrocksDdl);
  });

  it("drops Doris and StarRocks internal-catalog database qualifiers", () => {
    expect(omitDdlDatabaseQualifier("ALTER TABLE `analytics`.`events` ADD COLUMN `source` STRING;", "mysql", "doris", false, "internal")).toBe("ALTER TABLE `events` ADD COLUMN `source` STRING;");
    expect(omitDdlDatabaseQualifier("CREATE TABLE `analytics`.`events` (`id` bigint);", "mysql", "starrocks", false, "internal")).toBe("CREATE TABLE `events` (`id` bigint);");
  });

  it("leaves statements it does not understand untouched", () => {
    const ddl = "CREATE SEQUENCE SYSTEM.SEQ START WITH 1; SELECT SYSTEM.TEST.ID FROM SYSTEM.TEST;";
    expect(omitDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe(ddl);
  });
});

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

  it("removes quotes from ordinary uppercase Oracle identifiers", () => {
    const ddl = 'CREATE TABLE "DBX_TEST"."PRODUCTS" ("ID" NUMBER(10), "SKU" VARCHAR2(32)) TABLESPACE "USERS";';
    expect(omitDdlIdentifierQuotes(ddl, "oracle")).toBe("CREATE TABLE DBX_TEST.PRODUCTS (ID NUMBER(10), SKU VARCHAR2(32)) TABLESPACE USERS;");
  });

  it("keeps quotes required by Oracle case and naming rules", () => {
    const ddl = 'CREATE TABLE "CamelCase" ("lowercase" NUMBER, "WITH SPACE" NUMBER, "ORDER" NUMBER)';
    expect(omitDdlIdentifierQuotes(ddl, "oracle")).toBe(ddl);
  });

  it("removes quotes from ordinary uppercase Dameng identifiers", () => {
    const ddl = 'CREATE TABLE "DBX_TEST"."PRODUCTS" ("ID" INT, "NAME" VARCHAR(128)) STORAGE (ON "MAIN", CLUSTERBTR)';
    expect(omitDdlIdentifierQuotes(ddl, "dameng")).toBe("CREATE TABLE DBX_TEST.PRODUCTS (ID INT, NAME VARCHAR(128)) STORAGE (ON MAIN, CLUSTERBTR)");
  });

  it("keeps quotes required by Dameng case, naming, and reserved-word rules", () => {
    const ddl = 'CREATE TABLE "CamelCase" ("lowercase" INT, "WITH SPACE" INT, "ORDER" INT, "A$B" INT)';
    expect(omitDdlIdentifierQuotes(ddl, "dameng")).toBe(ddl);
  });

  it("folds safe Oracle identifiers when generated SQL quoting is disabled", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" RENAME COLUMN "ABCD" TO "AbCd";';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "oracle", false)).toBe("ALTER TABLE SYSTEM.TEST RENAME COLUMN ABCD TO ABCD;");
  });

  it("keeps case-sensitive Dameng identifiers quoted when generated SQL quoting is disabled", () => {
    const ddl = 'ALTER TABLE "user_login_log" ADD "status" INT; ALTER TABLE "CamelCase" ADD "order" INT;';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "dameng", false)).toBe(ddl);
  });

  it("preserves generated identifier quotes when the setting is enabled", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" RENAME COLUMN "ABCD" TO "AbCd";';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "oracle", true)).toBe(ddl);
  });
});
