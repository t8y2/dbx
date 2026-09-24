import { describe, expect, it } from "vitest";
import { applyDdlDatabaseQualifier, ddlFormatDialectFor, formatGeneratedDdlIdentifierQuotes, omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";

describe("applyDdlDatabaseQualifier", () => {
  it("drops the schema qualifier from Oracle table DDL without touching tablespace references", () => {
    const ddl = 'CREATE TABLE "SYSTEM"."TEST" ("ABC" CLOB) TABLESPACE "SYSTEM";';
    expect(applyDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('CREATE TABLE "TEST" ("ABC" CLOB) TABLESPACE "SYSTEM";');
  });

  it("drops the qualifier from generated ALTER statements and keeps column references", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" ADD ("CDE" CLOB); COMMENT ON COLUMN "SYSTEM"."TEST"."CDE" IS \'note\';';
    expect(applyDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('ALTER TABLE "TEST" ADD ("CDE" CLOB); COMMENT ON COLUMN "TEST"."CDE" IS \'note\';');
  });

  it("drops the qualifier from PostgreSQL, MySQL, and Dameng table references", () => {
    expect(applyDdlDatabaseQualifier('CREATE TABLE "public"."users" ("id" integer)', "postgres", "postgres", false)).toBe('CREATE TABLE "users" ("id" integer)');
    expect(applyDdlDatabaseQualifier("CREATE TABLE `analytics`.`events` (`id` int)", "mysql", "mysql", false)).toBe("CREATE TABLE `events` (`id` int)");
    expect(applyDdlDatabaseQualifier('ALTER TABLE "APP"."T1" ADD ("C1" INT);', "dameng", "dameng", false)).toBe('ALTER TABLE "T1" ADD ("C1" INT);');
  });

  it("drops both qualifiers of CREATE INDEX ... ON and DROP INDEX targets", () => {
    const ddl = 'CREATE INDEX "SYSTEM"."IDX_T" ON "SYSTEM"."TEST" ("ABC"); DROP INDEX "SYSTEM"."IDX_T";';
    expect(applyDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe('CREATE INDEX "IDX_T" ON "TEST" ("ABC"); DROP INDEX "IDX_T";');
  });

  it("handles comma-separated DROP TABLE lists and TRUNCATE", () => {
    expect(applyDdlDatabaseQualifier('DROP TABLE "public"."a", "public"."b";', "postgres", "postgres", false)).toBe('DROP TABLE "a", "b";');
    expect(applyDdlDatabaseQualifier('TRUNCATE TABLE "public"."a";', "postgres", "postgres", false)).toBe('TRUNCATE TABLE "a";');
  });

  it("keeps the qualifier when the preference is enabled, the dialect needs it, or the type is unknown", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" ADD ("CDE" CLOB);';
    expect(applyDdlDatabaseQualifier(ddl, "oracle", "oracle", true)).toBe(ddl);
    expect(applyDdlDatabaseQualifier("ALTER TABLE [dbo].[t] ADD [c] int;", "sqlserver", "sqlserver", false)).toBe("ALTER TABLE [dbo].[t] ADD [c] int;");
    expect(applyDdlDatabaseQualifier(ddl, "oracle", undefined, false)).toBe(ddl);
  });

  it("keeps Doris and StarRocks external-catalog qualifiers", () => {
    const dorisDdl = "ALTER TABLE `iceberg`.`analytics`.`events` ADD COLUMN `source` STRING;";
    const starrocksDdl = "CREATE TABLE `hive`.`events` (`id` bigint);";

    expect(applyDdlDatabaseQualifier(dorisDdl, "mysql", "doris", false, undefined, "iceberg")).toBe(dorisDdl);
    expect(applyDdlDatabaseQualifier(starrocksDdl, "mysql", "starrocks", false, undefined, "hive")).toBe(starrocksDdl);
    expect(applyDdlDatabaseQualifier("ALTER TABLE `events` ADD COLUMN `source` STRING;", "mysql", "starrocks", true, "analytics", "hive")).toBe("ALTER TABLE `events` ADD COLUMN `source` STRING;");
  });

  it("drops Doris and StarRocks internal-catalog database qualifiers", () => {
    expect(applyDdlDatabaseQualifier("ALTER TABLE `analytics`.`events` ADD COLUMN `source` STRING;", "mysql", "doris", false, undefined, "internal")).toBe("ALTER TABLE `events` ADD COLUMN `source` STRING;");
    expect(applyDdlDatabaseQualifier("CREATE TABLE `analytics`.`events` (`id` bigint);", "mysql", "starrocks", false, undefined, "internal")).toBe("CREATE TABLE `events` (`id` bigint);");
  });

  it("leaves statements it does not understand untouched", () => {
    const ddl = "CREATE SEQUENCE SYSTEM.SEQ START WITH 1; SELECT SYSTEM.TEST.ID FROM SYSTEM.TEST;";
    expect(applyDdlDatabaseQualifier(ddl, "oracle", "oracle", false)).toBe(ddl);
  });

  // issue #9262: with the preference on, the server never returns the database
  // for MySQL (`SHOW CREATE TABLE` cannot include it) and SQL Server DDL is
  // generated as `schema.table`, so the display layer has to add the segment.
  it("inserts the database prefix into MySQL DDL when the preference is enabled", () => {
    expect(applyDdlDatabaseQualifier("CREATE TABLE `test1` (`id` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB;", "mysql", "mysql", true, "dbx")).toBe("CREATE TABLE `dbx`.`test1` (`id` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB;");
    expect(applyDdlDatabaseQualifier("ALTER TABLE `test1` ADD COLUMN `nick` varchar(20);", "mysql", "mysql", true, "dbx")).toBe("ALTER TABLE `dbx`.`test1` ADD COLUMN `nick` varchar(20);");
    expect(applyDdlDatabaseQualifier("DROP TABLE `a`, `b`;", "mysql", "mysql", true, "dbx")).toBe("DROP TABLE `dbx`.`a`, `dbx`.`b`;");
    expect(applyDdlDatabaseQualifier("CREATE INDEX `idx_t` ON `test1` (`name`);", "mysql", "mysql", true, "dbx")).toBe("CREATE INDEX `idx_t` ON `dbx`.`test1` (`name`);");
  });

  it("inserts the database prefix into SQL Server DDL when the preference is enabled", () => {
    expect(applyDdlDatabaseQualifier("CREATE TABLE [dbo].[AcceptanceProductLog] ([uID] uniqueidentifier NOT NULL);", "sqlserver", "sqlserver", true, "dbx")).toBe("CREATE TABLE [dbx].[dbo].[AcceptanceProductLog] ([uID] uniqueidentifier NOT NULL);");
    expect(applyDdlDatabaseQualifier("ALTER TABLE [dbo].[t] ADD [c] int;", "sqlserver", "sqlserver", true, "dbx")).toBe("ALTER TABLE [dbx].[dbo].[t] ADD [c] int;");
    // The SQL Server DDL generator quotes names that need it.
    expect(applyDdlDatabaseQualifier("CREATE TABLE [dbo].[player states] ([role id] int);", "sqlserver", "sqlserver", true, "db x")).toBe("CREATE TABLE [db x].[dbo].[player states] ([role id] int);");
  });

  it("does not double-qualify DDL that already carries the database", () => {
    const mysqlDdl = "CREATE TABLE `dbx`.`test1` (`id` int);";
    expect(applyDdlDatabaseQualifier(mysqlDdl, "mysql", "mysql", true, "dbx")).toBe(mysqlDdl);
    const sqlserverDdl = "CREATE TABLE [dbx].[dbo].[t] ([id] int);";
    expect(applyDdlDatabaseQualifier(sqlserverDdl, "sqlserver", "sqlserver", true, "dbx")).toBe(sqlserverDdl);
  });

  it("only completes names whose remaining shape can still be valid", () => {
    // SQL Server without the schema segment cannot become `database.schema.table`.
    expect(applyDdlDatabaseQualifier("CREATE TABLE [t] ([id] int);", "sqlserver", "sqlserver", true, "dbx")).toBe("CREATE TABLE [t] ([id] int);");
    // Engines that never take a leading database segment stay untouched.
    expect(applyDdlDatabaseQualifier('CREATE TABLE "public"."users" ("id" integer);', "postgres", "postgres", true, "dbx")).toBe('CREATE TABLE "public"."users" ("id" integer);');
    // No database name resolved — nothing to insert.
    expect(applyDdlDatabaseQualifier("CREATE TABLE `test1` (`id` int);", "mysql", "mysql", true, undefined)).toBe("CREATE TABLE `test1` (`id` int);");
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

  it("keeps case-sensitive Oracle identifiers quoted when the edited table preserves case (#9649)", () => {
    const ddl = 'ALTER TABLE "DBX_TEST"."T_9649" MODIFY ("cName" VARCHAR2(120 BYTE));\nALTER TABLE "DBX_TEST"."T_9649" ADD ("cNabcs" clob);\nCOMMENT ON COLUMN "DBX_TEST"."T_9649"."cName" IS \'中文名\';';
    const expected = 'ALTER TABLE DBX_TEST.T_9649 MODIFY ("cName" VARCHAR2(120 BYTE));\nALTER TABLE DBX_TEST.T_9649 ADD ("cNabcs" clob);\nCOMMENT ON COLUMN DBX_TEST.T_9649."cName" IS \'中文名\';';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "oracle", false, { preserveCaseSensitiveIdentifiers: true })).toBe(expected);
  });

  it("still folds plain Oracle identifiers while preserving case-sensitive ones (#9649)", () => {
    const ddl = 'ALTER TABLE "SYSTEM"."TEST" ADD ("ID" NUMBER(10), "NEW_COL" VARCHAR2(20), "with space" VARCHAR2(20));';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "oracle", false, { preserveCaseSensitiveIdentifiers: true })).toBe('ALTER TABLE SYSTEM.TEST ADD (ID NUMBER(10), NEW_COL VARCHAR2(20), "with space" VARCHAR2(20));');
  });

  it("ignores the case-preservation option for dialects that keep their own rules", () => {
    const ddl = 'ALTER TABLE "user_login_log" ADD "status" INT;';
    expect(formatGeneratedDdlIdentifierQuotes(ddl, "dameng", false, { preserveCaseSensitiveIdentifiers: true })).toBe(ddl);
  });
});

describe("ddlFormatDialectFor", () => {
  it("prefers the effective database type over an Oracle-like connection's MySQL highlighting dialect", () => {
    expect(ddlFormatDialectFor({ databaseType: "oracle", highlightDialect: "mysql" })).toBe("oracle");
    expect(ddlFormatDialectFor({ databaseType: "dameng", highlightDialect: "mysql" })).toBe("dameng");
    expect(ddlFormatDialectFor({ databaseType: "kingbase", highlightDialect: "mysql" })).toBe("postgres");
  });

  it("honors an explicit formatter dialect first", () => {
    expect(ddlFormatDialectFor({ formatDialect: "sqlserver", databaseType: "oracle", highlightDialect: "mysql" })).toBe("sqlserver");
  });

  it("keeps the highlighting dialect when the database type has no dedicated formatter dialect", () => {
    expect(ddlFormatDialectFor({ databaseType: "db2", highlightDialect: "mysql" })).toBe("mysql");
    expect(ddlFormatDialectFor({ highlightDialect: "postgres" })).toBe("postgres");
    expect(ddlFormatDialectFor({})).toBe("generic");
  });

  it("keeps case-sensitive quoted Oracle names quoted in the DDL view", () => {
    const ddl = 'CREATE TABLE "SYSTEM"."TEST" ("id" VARCHAR2(32), "cName" VARCHAR2(100))';
    const highlightDialect = "mysql";
    const resolved = ddlFormatDialectFor({ databaseType: "oracle", highlightDialect });
    expect(omitDdlIdentifierQuotes(ddl, highlightDialect)).toBe("CREATE TABLE SYSTEM.TEST (id VARCHAR2(32), cName VARCHAR2(100))");
    expect(omitDdlIdentifierQuotes(ddl, resolved)).toBe('CREATE TABLE SYSTEM.TEST ("id" VARCHAR2(32), "cName" VARCHAR2(100))');
  });
});
