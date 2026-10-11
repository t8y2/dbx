import { describe, expect, it } from "vitest";
import { temporalColumnTypesFromDdl } from "../queryResultTransferDdl";
import {
  binaryQueryResultValueHex,
  alwaysIdentityColumnNamesFromDdl,
  identityColumnNamesFromDdl,
  nonInsertableColumnNamesFromDdl,
  normalizeQueryResultColumnType,
  queryResultTransferCreateCleanupSql,
  queryResultTransferDatabaseType,
  queryResultTransferIncomplete,
  queryResultTransferNeedsCreateCleanup,
  queryResultTransferStagingCleanupSql,
  rewriteCreateTableName,
  supportsQueryResultTransfer,
  supportsQueryResultTransferDatabaseType,
  transactionalMysqlTableDdl,
} from "../queryResultTransfer";

describe("query result transfer", () => {
  it("reads temporal precision and zones from column declarations without reading defaults as types", () => {
    const ddl = `CREATE TABLE "events" (
      "created" TIMESTAMP ( 3 ) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP(6),
      "local" TIMESTAMP(9) WITH LOCAL TIME ZONE,
      "clock" TIME(2) WITHOUT TIME ZONE,
      "text" VARCHAR(99) DEFAULT 'TIMESTAMP(1)',
      "custom" app.timestamp,
      "items" TIMESTAMP(3)[],
      CONSTRAINT "events_check" CHECK ("created" > TIMESTAMP '2020-01-01 00:00:00')
    )`;
    expect([...temporalColumnTypesFromDdl(ddl, "postgres")]).toEqual([
      ["created", "TIMESTAMP(3) WITH TIME ZONE"],
      ["local", "TIMESTAMP(9) WITH LOCAL TIME ZONE"],
      ["clock", "TIME(2) WITHOUT TIME ZONE"],
    ]);
  });

  it.each([
    ["h2", "TIME", "TIME(0)"],
    ["h2", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP(6) WITH TIME ZONE"],
    ["postgres", "TIMESTAMPTZ", "TIMESTAMPTZ(6)"],
    ["mysql", "DATETIME", "DATETIME(0)"],
    ["goldendb", "TIME", "TIME(0)"],
    ["sqlserver", "[datetime2]", "DATETIME2(7)"],
    ["sqlserver", "DATETIMEOFFSET", "DATETIMEOFFSET(7)"],
    ["sqlserver", "DATETIME", "DATETIME"],
    ["oracle", "TIMESTAMP WITH LOCAL TIME ZONE", "TIMESTAMP(6) WITH LOCAL TIME ZONE"],
    ["oracle", "DATE", "DATE"],
    ["db2", "TIMESTAMP", "TIMESTAMP(6)"],
  ] as const)("uses the actual %s default for a bare %s declaration", (databaseType, declaration, expected) => {
    expect(temporalColumnTypesFromDdl(`CREATE TABLE events (created ${declaration})`, databaseType).get("created")).toBe(expected);
  });

  it("marks unknown temporal defaults explicitly and leaves SQLite affinity and SQL Server rowversion alone", () => {
    expect(temporalColumnTypesFromDdl("CREATE TABLE events (created TIMESTAMP)", "iris").get("created")).toBeNull();
    expect(temporalColumnTypesFromDdl("CREATE TABLE events (created TIMESTAMP(3))", "iris").get("created")).toBe("TIMESTAMP(3)");
    expect(temporalColumnTypesFromDdl("CREATE TABLE events (created TIMESTAMP(3))", "sqlite").size).toBe(0);
    expect(temporalColumnTypesFromDdl("CREATE TABLE events (version TIMESTAMP)", "sqlserver").size).toBe(0);
  });

  it.each(["UNIQUE NULLS DISTINCT", "UNIQUE NULLS NOT DISTINCT", "UNIQUE NULLS ALL DISTINCT", "HASH", "SPATIAL"])("rewrites the H2 SCRIPT index modifier %s without changing its semantics", (modifiers) => {
    const ddl = `CREATE MEMORY TABLE "PUBLIC"."APIS" ("NAME" VARCHAR(32)); CREATE ${modifiers} INDEX "PUBLIC"."IDX_NAME" ON "PUBLIC"."APIS"("NAME" NULLS FIRST);`;
    const rewritten = rewriteCreateTableName(ddl, '"TARGET"."COPY"', "h2");
    expect(rewritten).toContain(`CREATE ${modifiers} INDEX "COPY_IDX_NAME_dbx_`);
    expect(rewritten).toContain('ON "TARGET"."COPY"("NAME" NULLS FIRST)');
    expect(rewritten).not.toContain('"PUBLIC"');
  });

  it("preserves H2 SCRIPT table and column comments before parsing the columns", () => {
    const ddl = `CREATE MEMORY TABLE "PUBLIC"."APIS" COMMENT 'table (APIS) desc' (
      "CREATED" TIMESTAMP(3) COMMENT 'column desc', "TOTAL" INTEGER GENERATED ALWAYS AS (1)
    );`;
    expect(rewriteCreateTableName(ddl, '"TARGET"."COPY"', "h2")).toBe(ddl.replace('"PUBLIC"."APIS"', '"TARGET"."COPY"'));
    expect(temporalColumnTypesFromDdl(ddl, "h2").get("CREATED")).toBe("TIMESTAMP(3)");
    expect(nonInsertableColumnNamesFromDdl(ddl, "h2")).toEqual(new Set(["TOTAL"]));
    expect(rewriteCreateTableName('CREATE TABLE "APIS" COMMENT unknown (id INT)', '"COPY"', "h2")).toBeUndefined();
  });

  it("excludes document and non-transfer targets while retaining SQL targets", () => {
    for (const type of ["mongodb", "redis", "dynamodb", "neo4j"] as const) expect(supportsQueryResultTransfer({ db_type: type })).toBe(false);
    expect(queryResultTransferDatabaseType({ db_type: "gbase" })).toBeUndefined();
    expect(supportsQueryResultTransfer({ db_type: "gbase" })).toBe(false);
    for (const type of ["mysql", "postgres", "h2"] as const) expect(supportsQueryResultTransfer({ db_type: type })).toBe(true);
    for (const type of ["clickhouse", "duckdb", "rqlite", "turso", "cloudflare-d1", "argo", "hive", "spark"] as const) expect(supportsQueryResultTransferDatabaseType(type)).toBe(false);
    for (const driver_profile of ["doris", "selectdb", "starrocks"]) expect(supportsQueryResultTransfer({ db_type: "mysql", driver_profile })).toBe(false);
  });

  it("resolves supported JDBC targets before checking transfer capability", () => {
    const connection = { db_type: "jdbc" as const, connection_string: "jdbc:h2:mem:transfer-test" };
    expect(queryResultTransferDatabaseType(connection)).toBe("h2");
    expect(supportsQueryResultTransfer(connection)).toBe(true);
  });

  it("makes bare MySQL variable-length types valid for CREATE TABLE", () => {
    expect(normalizeQueryResultColumnType("varchar", "mysql")).toBe("VARCHAR(255)");
    expect(normalizeQueryResultColumnType("varbinary", "mysql")).toBe("VARBINARY(255)");
    expect(normalizeQueryResultColumnType("enum", "mysql")).toBe("TEXT");
    expect(normalizeQueryResultColumnType("varchar(20)", "mysql")).toBe("varchar(20)");
  });

  it("decodes the backend's canonical binary result values before INSERT", () => {
    expect(binaryQueryResultValueHex("0x4869")).toBe("4869");
    expect(binaryQueryResultValueHex("plain text")).toBe("706c61696e2074657874");
    expect(binaryQueryResultValueHex(new Uint8Array([0, 255]))).toBe("00ff");
    expect(binaryQueryResultValueHex([0, 255])).toBe("00ff");
    expect(binaryQueryResultValueHex({ data: [0, 255] })).toBe("00ff");
  });

  it("builds an idempotent cleanup statement for a staging table", () => {
    expect(queryResultTransferStagingCleanupSql("`db`.`apis__dbx_transfer_abc`")).toBe("DROP TABLE IF EXISTS `db`.`apis__dbx_transfer_abc`");
  });

  it("cleans up newly created Oracle-family tables after non-transactional DDL failures", () => {
    expect(queryResultTransferNeedsCreateCleanup("oracle")).toBe(true);
    expect(queryResultTransferCreateCleanupSql('"APP"."apis"', "oracle")).toContain('DROP TABLE "APP"."apis" CASCADE CONSTRAINTS');
    expect(queryResultTransferNeedsCreateCleanup("postgres")).toBe(false);
    for (const type of ["mysql", "goldendb", "h2"] as const) {
      expect(queryResultTransferNeedsCreateCleanup(type)).toBe(true);
      expect(queryResultTransferCreateCleanupSql('"apis"', type)).toBe('DROP TABLE IF EXISTS "apis"');
    }
  });

  it("rewrites only the CREATE TABLE name while preserving source DDL", () => {
    const ddl = "CREATE TABLE `apis` (`id` bigint unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;";
    expect(rewriteCreateTableName(ddl, "`aaa_apis`")).toBe("CREATE TABLE `aaa_apis` (`id` bigint unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
  });

  it("rewrites table references in every statement of a reusable PostgreSQL DDL", () => {
    const ddl = ['CREATE TABLE "public"."apis" ("id" bigint);', 'COMMENT ON TABLE "public"."apis" IS \'source table\';', 'CREATE INDEX "idx_apis_id" ON "public"."apis" ("id");'].join("\n");
    expect(rewriteCreateTableName(ddl, '"archive"."aaa_apis"', "postgres", "public", "apis")).toContain('COMMENT ON TABLE "archive"."aaa_apis"');
    expect(rewriteCreateTableName(ddl, '"archive"."aaa_apis"', "postgres", "public", "apis")).toMatch(/CREATE INDEX "aaa_apis_idx_apis_id_dbx_[a-f0-9]+" ON "archive"\."aaa_apis"/);
  });

  it("keeps a reusable MySQL table definition instead of rebuilding generic columns", () => {
    const ddl = `CREATE TABLE \`apis\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`created_at\` datetime(3) DEFAULT NULL,
  \`updated_at\` datetime(3) DEFAULT NULL,
  \`deleted_at\` datetime(3) DEFAULT NULL,
  \`method\` varchar(20) DEFAULT NULL COMMENT '''请求方式''',
  \`path\` varchar(100) DEFAULT NULL COMMENT '''访问路径''',
  \`category\` varchar(50) DEFAULT NULL COMMENT '''所属类别''',
  \`remark\` varchar(100) DEFAULT NULL COMMENT '''备注''',
  \`creator\` varchar(20) DEFAULT NULL COMMENT '''创建人''',
  PRIMARY KEY (\`id\`),
  KEY \`idx_apis_deleted_at\` (\`deleted_at\`)
) ENGINE=InnoDB AUTO_INCREMENT=56 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;
    const rewritten = rewriteCreateTableName(ddl, "`1_apis`", "mysql", undefined, "apis");
    expect(rewritten).toContain("`id` bigint unsigned NOT NULL AUTO_INCREMENT");
    expect(rewritten).toContain("varchar(20) DEFAULT NULL");
    expect(rewritten).toContain("COLLATE=utf8mb4_0900_ai_ci");
    expect(rewritten).toBe(ddl.replace("CREATE TABLE `apis`", "CREATE TABLE `1_apis`"));
  });

  it("detects generated and SQL Server rowversion columns as non-insertable", () => {
    const mysql = "CREATE TABLE t (\n  id bigint,\n  full_name varchar(255) GENERATED ALWAYS AS (id) STORED\n);";
    expect(nonInsertableColumnNamesFromDdl(mysql, "mysql")).toEqual(new Set(["full_name"]));
    const sqlserver = "CREATE TABLE t (\n  id int,\n  version rowversion\n);";
    expect(nonInsertableColumnNamesFromDdl(sqlserver, "sqlserver")).toEqual(new Set(["version"]));
  });

  it("detects shorthand and multiline computed columns", () => {
    const mysql = "CREATE TABLE t (\n  id bigint,\n  total decimal(10,2) AS (\n    price * quantity\n  ) STORED\n);";
    expect(nonInsertableColumnNamesFromDdl(mysql, "mysql")).toEqual(new Set(["total"]));
    const sqlserver = "CREATE TABLE t (\n  id int,\n  total AS (price * quantity) PERSISTED\n);";
    expect(nonInsertableColumnNamesFromDdl(sqlserver, "sqlserver")).toEqual(new Set(["total"]));
  });

  it("keeps identities and ordinary defaults writable without treating CAST AS as a generated column", () => {
    const ddl = 'CREATE TABLE "t" ("id" bigint GENERATED ALWAYS AS IDENTITY, "other_id" int GENERATED BY DEFAULT AS IDENTITY, "serial_id" bigserial, "value" int DEFAULT CAST(1 AS integer), "computed" int GENERATED ALWAYS AS (value * 2) STORED)';
    expect(nonInsertableColumnNamesFromDdl(ddl, "postgres")).toEqual(new Set(["computed"]));
    expect(identityColumnNamesFromDdl(ddl, "postgres")).toEqual(new Set(["id", "other_id", "serial_id"]));
    expect(alwaysIdentityColumnNamesFromDdl(ddl, "postgres")).toEqual(new Set(["id"]));
    const sqlserver = "CREATE TABLE [t] ([id] bigint IDENTITY(1,1), [version] rowversion, [total] AS ([id] * 2))";
    expect(nonInsertableColumnNamesFromDdl(sqlserver, "sqlserver")).toEqual(new Set(["version", "total"]));
    expect(identityColumnNamesFromDdl(sqlserver, "sqlserver")).toEqual(new Set(["id"]));
    const caseSensitive = 'CREATE TABLE t ("ID" int GENERATED ALWAYS AS IDENTITY, "id" int, "VALUE" int GENERATED ALWAYS AS (id * 2) STORED, "value" int)';
    expect(identityColumnNamesFromDdl(caseSensitive, "postgres")).toEqual(new Set(["ID"]));
    expect(nonInsertableColumnNamesFromDdl(caseSensitive, "postgres")).toEqual(new Set(["VALUE"]));
  });

  it("changes only table grammar positions, including comments and self references", () => {
    const ddl = [
      'CREATE TABLE "public"."apis" ("apis" int, "parent" int REFERENCES "public"."apis" ("apis"), "other" int REFERENCES "archive"."apis" ("apis"), CONSTRAINT "apis_check" CHECK (apis > 0));',
      'CREATE INDEX "idx" ON "public"."apis" ("apis") WHERE apis > 0;',
      'COMMENT ON COLUMN "public"."apis"."apis" IS \'apis\';',
    ].join("\n");
    const result = rewriteCreateTableName(ddl, '"public"."copied"', "postgres", "public", "apis")!;
    expect(result).toContain('CREATE TABLE "public"."copied" ("apis" int');
    expect(result).toContain('REFERENCES "public"."copied" ("apis")');
    expect(result).toContain('REFERENCES "archive"."apis" ("apis")');
    expect(result).toContain("CHECK (apis > 0)");
    expect(result).toContain('ON "public"."copied" ("apis") WHERE apis > 0');
    expect(result).toContain('COMMENT ON COLUMN "public"."copied"."apis" IS \'apis\'');
  });

  it("renames PostgreSQL constraints, indexes and their comments consistently", () => {
    const ddl = ['CREATE TABLE "public"."apis" ("id" bigint, CONSTRAINT "apis_pkey" PRIMARY KEY ("id"));', 'CREATE UNIQUE INDEX "idx" ON "public"."apis" ("id");', 'COMMENT ON CONSTRAINT "apis_pkey" ON "public"."apis" IS \'primary key\';', 'COMMENT ON INDEX "public"."idx" IS \'index\';'].join("\n");
    const result = rewriteCreateTableName(ddl, '"public"."copy"', "postgres", "public", "apis")!;
    const primaryKey = result.match(/CONSTRAINT ("[^"]+") PRIMARY KEY/)![1];
    const index = result.match(/CREATE UNIQUE INDEX ("[^"]+")/)![1];
    expect(primaryKey).not.toBe('"apis_pkey"');
    expect(index).not.toBe('"idx"');
    expect(result).toContain(`COMMENT ON CONSTRAINT ${primaryKey} ON "public"."copy"`);
    expect(result).toContain(`COMMENT ON INDEX "public".${index}`);
  });

  it("renames MySQL schema-scoped constraints without changing table-scoped index names", () => {
    const ddl = "CREATE TABLE `apis` (`id` int, `parent` int, KEY `idx` (`parent`), CONSTRAINT `apis_fk` FOREIGN KEY (`parent`) REFERENCES `apis` (`id`))";
    for (const type of ["mysql", "goldendb"] as const) {
      const result = rewriteCreateTableName(ddl, "`copy`", type, undefined, "apis")!;
      expect(result).toContain("KEY `idx` (`parent`)");
      expect(result).toMatch(/CONSTRAINT `copy_apis_fk_dbx_[a-f0-9]+` FOREIGN KEY/);
      expect(result).toContain("REFERENCES `copy` (`id`)");
    }
  });

  it("rewrites SQL Server table and column description properties while preserving their text", () => {
    const tableComment = "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'apis table in dbo', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'apis'";
    const columnComment = "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'User''s display name', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'apis', @level2type=N'COLUMN', @level2name=N'apis'";
    const ddl = `CREATE TABLE [dbo].[apis] ([apis] nvarchar(100)); ${tableComment}; ${columnComment};`;
    const result = rewriteCreateTableName(ddl, "[archive].[copy]", "sqlserver", "dbo", "apis")!;
    expect(result).toContain("@value=N'apis table in dbo'");
    expect(result).toContain("@value=N'User''s display name'");
    expect(result.match(/@level0name=N'archive'/g)).toHaveLength(2);
    expect(result.match(/@level1name=N'copy'/g)).toHaveLength(2);
    expect(result).toContain("@level2name=N'apis'");
    const defaultSchema = rewriteCreateTableName(ddl, "[copy]", "sqlserver", "dbo", "apis")!;
    expect(defaultSchema).toContain("OBJECT_SCHEMA_NAME(OBJECT_ID(N''[copy]'', N''U''))");
    expect(defaultSchema.match(/@level0name=@dbx_transfer_schema/g)).toHaveLength(2);
    expect(defaultSchema.match(/EXEC\(N'DECLARE @dbx_transfer_schema/g)).toHaveLength(2);
  });

  it("rejects unsupported SQL Server metadata procedures and foreign target properties", () => {
    const prefix = "CREATE TABLE [dbo].[apis] ([id] int); ";
    const property = "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'text', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'other'";
    expect(rewriteCreateTableName(prefix + property, "[copy]", "sqlserver", "dbo", "apis")).toBeUndefined();
    expect(rewriteCreateTableName(prefix + "EXEC dbo.custom_procedure 'apis'", "[copy]", "sqlserver", "dbo", "apis")).toBeUndefined();
    const temporal = "CREATE TABLE [dbo].[apis] ([id] int) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [dbo].[apis_history]));";
    expect(rewriteCreateTableName(temporal, "[copy]", "sqlserver", "dbo", "apis")).toBeUndefined();
  });

  it("keeps generated identifiers within byte limits without losing uniqueness", () => {
    const longName = "查询结果".repeat(30);
    const ddl = `CREATE TABLE apis (id int, CONSTRAINT first PRIMARY KEY (id)); CREATE INDEX second ON apis (id)`;
    const result = rewriteCreateTableName(ddl, `"${longName}"`, "postgres", undefined, "apis")!;
    const primaryKey = result.match(/CONSTRAINT "([^"]+)" PRIMARY KEY/)![1];
    const index = result.match(/CREATE INDEX "([^"]+)"/)![1];
    expect(new TextEncoder().encode(primaryKey).length).toBeLessThanOrEqual(63);
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(63);
    expect(primaryKey).not.toBe(index);
  });

  it("keeps SQLite index namespaces on the index rather than the ON table", () => {
    const ddl = 'CREATE TABLE "apis" (id int); CREATE INDEX "idx" ON "apis" (id)';
    const result = rewriteCreateTableName(ddl, '"archive"."copy"', "sqlite", undefined, "apis")!;
    expect(result).toMatch(/CREATE INDEX "archive"\."copy_idx_dbx_[a-f0-9]+" ON "copy" \(id\)/);
  });

  it("rejects foreign table statements, additional tables and unsupported scripts before replay", () => {
    for (const ddl of [
      "CREATE TABLE apis (id int); ALTER TABLE other ADD x int",
      "CREATE TABLE apis (id int); CREATE TABLE other (id int)",
      "CREATE TABLE apis (id int); DELETE FROM apis",
      "CREATE TABLE apis PARTITION OF parent FOR VALUES IN (1)",
      "CREATE TABLE apis (id int); ALTER TABLE apis ATTACH PARTITION other FOR VALUES IN (1)",
    ]) {
      expect(rewriteCreateTableName(ddl, '"copy"', "postgres", undefined, "apis")).toBeUndefined();
    }
    expect(rewriteCreateTableName('CREATE TABLE "Apis" (id int)', '"copy"', "postgres", undefined, "apis")).toBeUndefined();
  });

  it("preserves MySQL backslash-escaped comments containing table-like text", () => {
    const ddl = "CREATE TABLE `apis` (`id` int COMMENT 'user\\'s apis', `apis` int)";
    expect(rewriteCreateTableName(ddl, "`copy`", "mysql", undefined, "apis")).toBe("CREATE TABLE `copy` (`id` int COMMENT 'user\\'s apis', `apis` int)");
  });

  it("does not allow IF NOT EXISTS to hide a concurrent target-name collision", () => {
    const result = rewriteCreateTableName("CREATE TABLE IF NOT EXISTS apis (id int); CREATE INDEX IF NOT EXISTS idx ON apis (id)", '"copy"', "postgres", undefined, "apis")!;
    expect(result).not.toContain("IF NOT EXISTS");
    expect(result).toContain('"copy" (id int)');
  });

  it("recognizes the actual MySQL transaction-capable storage engine", () => {
    expect(transactionalMysqlTableDdl("CREATE TABLE t (id int) ENGINE=InnoDB")).toBe(true);
    expect(transactionalMysqlTableDdl("CREATE TABLE t (id int) ENGINE='InnoDB'")).toBe(true);
    expect(transactionalMysqlTableDdl("CREATE TABLE t (id int COMMENT 'ENGINE=InnoDB') ENGINE=MyISAM")).toBe(false);
    expect(transactionalMysqlTableDdl("CREATE TABLE t (id int) ENGINE=MyISAM COMMENT='ENGINE=InnoDB'")).toBe(false);
    expect(transactionalMysqlTableDdl("CREATE TABLE t (id int) /* ENGINE=InnoDB */")).toBe(false);
    expect(transactionalMysqlTableDdl("CREATE TABLE t (`ENGINE` text DEFAULT 'InnoDB')")).toBe(false);
  });

  it("accepts the H2 MEMORY/CACHED table forms emitted by its SCRIPT metadata path", () => {
    for (const storage of ["MEMORY", "CACHED"]) {
      const ddl = `CREATE ${storage} TABLE "PUBLIC"."APIS"("ID" INTEGER);`;
      expect(rewriteCreateTableName(ddl, '"ARCHIVE"."COPY"', "h2", "PUBLIC", "APIS")).toBe(`CREATE ${storage} TABLE "ARCHIVE"."COPY"("ID" INTEGER);`);
    }
  });

  it("rewrites schema-qualified constraints emitted by H2 SCRIPT", () => {
    const ddl = 'CREATE MEMORY TABLE "PUBLIC"."APIS"("ID" INTEGER NOT NULL, "CODE" CHARACTER VARYING(30));\nALTER TABLE "PUBLIC"."APIS" ADD CONSTRAINT "PUBLIC"."CONSTRAINT_1" PRIMARY KEY("ID");\nALTER TABLE "PUBLIC"."APIS" ADD CONSTRAINT "PUBLIC"."UQ_CODE" UNIQUE("CODE");';
    const rewritten = rewriteCreateTableName(ddl, '"ARCHIVE"."COPY"', "h2")!;
    expect(rewritten).toMatch(/ADD CONSTRAINT "ARCHIVE"\."COPY_CONSTRAINT_1_dbx_[a-f0-9]+" PRIMARY KEY/);
    expect(rewritten).toMatch(/ADD CONSTRAINT "ARCHIVE"\."COPY_UQ_CODE_dbx_[a-f0-9]+" UNIQUE/);
    expect(rewritten).not.toContain('"PUBLIC"');
    const unqualified = rewriteCreateTableName(ddl, '"COPY"', "h2")!;
    expect(unqualified).toMatch(/ADD CONSTRAINT "COPY_CONSTRAINT_1_dbx_[a-f0-9]+" PRIMARY KEY/);
  });

  it("rejects incomplete fallback results even without a row limit", () => {
    const result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 };
    expect(queryResultTransferIncomplete({ ...result, truncated: true })).toBe(true);
    expect(queryResultTransferIncomplete({ ...result, has_more: true })).toBe(true);
    expect(queryResultTransferIncomplete(result, 1)).toBe(false);
    expect(queryResultTransferIncomplete({ ...result, rows: [[1], [2]] }, 1)).toBe(true);
  });
});
