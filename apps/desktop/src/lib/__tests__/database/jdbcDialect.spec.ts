import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { databaseObjectTreeNodeSchema } from "@/lib/database/databaseFeatureSupport";
import {
  GAUSSDB_M_JDBC_DRIVER_CLASS,
  connectionDatabaseMetadataSchema,
  connectionObjectTreeNodeSchema,
  connectionObjectTreeQuerySchema,
  connectionQueryExecutionSchema,
  connectionShouldDiscoverJdbcSchemas,
  connectionShouldLoadIdentifierQuote,
  connectionUsesConnectionRootSchemaMode,
  connectionUsesDatabaseObjectTreeMode,
  effectiveDatabaseTypeForConnection,
  gaussdbConnectionMode,
  gaussdbCountQueryDop,
  gaussdbCountQueryDopHint,
  gaussdbIdentifierQuoteOverride,
  gaussdbIdentifierQuoteStyle,
  gaussdbTargetServerType,
  inferJdbcDialect,
  metadataSchemaForConnection,
  setGaussdbConnectionMode,
  setGaussdbCountQueryDop,
  setGaussdbIdentifierQuoteStyle,
  setGaussdbTargetServerType,
  supportsGaussdbIdentifierQuoteStyle,
  transferDatabaseTypeForConnection,
} from "@/lib/database/jdbcDialect";
import { supportsTransfer } from "@/lib/database/databaseFeatureSupport";
import { transferObjectKindsForDatabase } from "@/lib/database/transferObjectKinds";

describe("jdbc dialect inference", () => {
  it("detects InterSystems IRIS and Caché JDBC connections", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:Cache://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_class: "com.intersystems.jdbc.IRISDriver",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_paths: ["/drivers/intersystems-jdbc-3.10.5.jar"],
      }),
    ).toBe("iris");
  });

  it("uses IRIS table preview dialect for generic JDBC IRIS connections", () => {
    expect(
      effectiveDatabaseTypeForConnection({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
  });

  it("uses JDBC driver profiles when inferring dialect", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        driver_profile: "sqlserver",
      }),
    ).toBe("sqlserver");
  });

  it("keeps Phoenix as generic JDBC while preserving its schema tree", () => {
    const connection = { db_type: "jdbc" as const, driver_profile: "phoenix" };

    expect(inferJdbcDialect(connection)).toBe("jdbc");
    expect(effectiveDatabaseTypeForConnection(connection)).toBe("jdbc");
    expect(connectionUsesDatabaseObjectTreeMode(connection)).toBe(false);
    expect(connectionObjectTreeQuerySchema(connection, "default", "DEMO")).toBe("DEMO");
    expect(connectionObjectTreeNodeSchema(connection, "default", "DEMO")).toBe("DEMO");
    expect(connectionShouldLoadIdentifierQuote(connection)).toBe(true);
  });

  it.each([
    ["jdbc:oracle:thin:@//localhost:1521/XE", "oracle"],
    ["jdbc:dm://localhost:5236/DAMENG", "dameng"],
  ] as const)("uses connection-root schemas for %s", (connectionString, dialect) => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: connectionString,
    };

    expect(inferJdbcDialect(connection)).toBe(dialect);
    expect(connectionUsesConnectionRootSchemaMode(connection)).toBe(true);
    expect(connectionUsesDatabaseObjectTreeMode(connection)).toBe(false);
    expect(connectionObjectTreeQuerySchema(connection, "DBX_TEST", "DBX_TEST")).toBe("DBX_TEST");
    expect(connectionObjectTreeNodeSchema(connection, "DBX_TEST", "DBX_TEST")).toBe("DBX_TEST");
  });

  it("detects GaussDB-compatible JDBC connections as schema-aware", () => {
    const gaussdbConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:gaussdb://localhost:8000/testdb",
      jdbc_driver_class: "com.huawei.gaussdb.jdbc.Driver",
    };
    const opengaussConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:opengauss://localhost:5432/postgres",
      jdbc_driver_class: "org.opengauss.Driver",
    };

    expect(inferJdbcDialect(gaussdbConnection)).toBe("gaussdb");
    expect(connectionUsesDatabaseObjectTreeMode(gaussdbConnection)).toBe(false);
    expect(inferJdbcDialect(opengaussConnection)).toBe("opengauss");
    expect(connectionUsesDatabaseObjectTreeMode(opengaussConnection)).toBe(false);
  });

  it("loads driver-reported identifier quotes for compatible JDBC connections", () => {
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_paths: ["/drivers/gaussdb.jar"] })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.opengauss.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.postgresql.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "kingbase" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "gaussdb" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "gbase", driver_profile: "gbase8s" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "gbase", driver_profile: "gbase8a" })).toBe(false);
    // Cloud Spanner reports a backtick for GoogleSQL and a double quote for the
    // PostgreSQL dialect; both are only known from the connection.
    expect(connectionShouldLoadIdentifierQuote({ db_type: "spanner" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "bigquery" })).toBe(false);
    expect(
      connectionShouldLoadIdentifierQuote({
        db_type: "jdbc",
        jdbc_driver_class: "org.postgresql.Driver",
        external_config: { gaussdbIdentifierQuoteStyle: "backtick" },
      }),
    ).toBe(false);
  });

  it("falls back to a flat table tree when GBase 8s reports no schemas", () => {
    expect(connectionShouldDiscoverJdbcSchemas({ db_type: "gbase", driver_profile: "gbase8s" })).toBe(true);
    expect(connectionShouldDiscoverJdbcSchemas({ db_type: "gbase", driver_profile: "gbase8a" })).toBe(false);
  });

  it("recognizes GaussDB reached through PostgreSQL-compatible JDBC drivers", () => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:postgresql://localhost:5432/postgres",
      jdbc_driver_class: "org.postgresql.Driver",
      database_info: { productName: "GaussDB Kernel", driverName: "PostgreSQL JDBC Driver" },
    };

    expect(inferJdbcDialect(connection)).toBe("gaussdb");
    expect(effectiveDatabaseTypeForConnection(connection)).toBe("gaussdb");
    expect(supportsGaussdbIdentifierQuoteStyle(connection)).toBe(true);
  });

  it("supports persisted GaussDB identifier quote overrides", () => {
    const native = { db_type: "gaussdb" as const, external_config: undefined as unknown };
    const jdbc = { db_type: "jdbc" as const, jdbc_driver_paths: ["/drivers/gaussdb.jar"], external_config: { retained: true } as unknown };

    expect(supportsGaussdbIdentifierQuoteStyle(native)).toBe(true);
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("auto");
    expect(gaussdbIdentifierQuoteOverride(native)).toBeUndefined();

    setGaussdbIdentifierQuoteStyle(native, "backtick");
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("backtick");
    expect(gaussdbIdentifierQuoteOverride(native)).toBe("`");

    setGaussdbIdentifierQuoteStyle(jdbc, "double");
    expect(jdbc.external_config).toEqual({ retained: true, gaussdbIdentifierQuoteStyle: "double" });
    expect(gaussdbIdentifierQuoteOverride(jdbc)).toBe('"');
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(false);

    setGaussdbIdentifierQuoteStyle(jdbc, "auto");
    expect(jdbc.external_config).toEqual({ retained: true });
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(true);
  });

  it("detects Dameng JDBC connections", () => {
    const damengConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:dm://localhost:5236/DAMENG",
      jdbc_driver_class: "dm.jdbc.driver.DmDriver",
    };

    expect(inferJdbcDialect(damengConnection)).toBe("dameng");
  });

  it("detects GBase JDBC connections for transfer dialect selection", () => {
    const gbaseConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:gbase://localhost:5258/dbx_test",
      jdbc_driver_class: "cn.gbase.Driver",
    };

    expect(inferJdbcDialect(gbaseConnection)).toBe("gbase");
    expect(effectiveDatabaseTypeForConnection(gbaseConnection)).toBe("gbase");

    // GBase 8s is Informix-based and must stay on generic jdbc (no MySQL-family transfer dialect).
    const gbase8sByUrl = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:gbasedbt-sqli://localhost:9088/dbx_test:INFORMIXSERVER=ol_gbasedbt",
      jdbc_driver_class: "com.gbasedbt.jdbc.Driver",
    };
    const gbase8sByProfile = {
      db_type: "jdbc" as const,
      driver_profile: "gbase8s",
    };
    const gbase8sProfileWithLegacyGbaseUrl = {
      db_type: "jdbc" as const,
      driver_profile: "gbase8s",
      connection_string: "jdbc:gbase://localhost:5258/dbx_test",
      jdbc_driver_class: "cn.gbase.Driver",
    };
    expect(inferJdbcDialect(gbase8sByUrl)).toBe("informix");
    expect(effectiveDatabaseTypeForConnection(gbase8sByUrl)).toBe("informix");
    expect(inferJdbcDialect(gbase8sByProfile)).toBeUndefined();
    expect(effectiveDatabaseTypeForConnection(gbase8sByProfile)).toBe("jdbc");
    expect(inferJdbcDialect(gbase8sProfileWithLegacyGbaseUrl)).toBeUndefined();
    expect(effectiveDatabaseTypeForConnection(gbase8sProfileWithLegacyGbaseUrl)).toBe("jdbc");
  });

  it("keeps doris-family mysql connections on the mysql transfer path", () => {
    // Doris/SelectDB/StarRocks connections are saved as db_type=mysql with a
    // doris-family driver_profile. The SQL dialect stays doris/starrocks
    // (3-part catalog names), but transfer admission and object kinds must ride
    // the raw mysql db_type: the standalone doris/starrocks manifest entries are
    // not transfer-capable, so the effective type would hide these connections
    // from the transfer dialog and drop their non-table object kinds.
    for (const driver_profile of ["starrocks", "doris", "selectdb"]) {
      const connection = { db_type: "mysql" as const, driver_profile };
      const transferType = transferDatabaseTypeForConnection(connection);

      expect(transferType).toBe("mysql");
      expect(supportsTransfer(transferType)).toBe(true);
      expect(transferObjectKindsForDatabase(transferType)).toContain("VIEW");
    }
  });

  it("resolves transfer types for non-doris-family connections through the effective type", () => {
    expect(transferDatabaseTypeForConnection(undefined)).toBeUndefined();
    expect(transferDatabaseTypeForConnection({ db_type: "mysql" })).toBe("mysql");
    expect(transferDatabaseTypeForConnection({ db_type: "postgres" })).toBe("postgres");
    expect(transferDatabaseTypeForConnection({ db_type: "gbase" })).toBe("mysql");
    expect(transferDatabaseTypeForConnection({ db_type: "jdbc", connection_string: "jdbc:gbase://localhost:5258/dbx_test" })).toBe("gbase");
    // A generic-JDBC Doris URL keeps its raw db_type (never admitted), matching
    // the pre-effective-type behavior for unknown jdbc connections.
    expect(transferDatabaseTypeForConnection({ db_type: "jdbc", connection_string: "jdbc:doris://localhost:9030/dbx_test" })).toBe("jdbc");
  });

  it("uses Hive tree and execution semantics for Inceptor JDBC metadata", () => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:hive2://inceptor.example.com:10000/default",
      database_info: { productName: "Apache Hive", driverName: "Inceptor JDBC 8.37.3" },
    };

    expect(inferJdbcDialect(connection)).toBe("hive");
    expect(effectiveDatabaseTypeForConnection(connection)).toBe("hive");
    expect(connectionUsesDatabaseObjectTreeMode(connection)).toBe(false);
    expect(connectionObjectTreeNodeSchema(connection, "CS")).toBe("CS");
    expect(connectionQueryExecutionSchema(connection, "CS", undefined, false)).toBe("CS");
  });

  it.each([
    { driver_profile: "inceptor" },
    { driver_label: "Inceptor JDBC 8.37.3" },
    { jdbc_driver_class: "io.transwarp.inceptor.jdbc.InceptorDriver" },
    { jdbc_driver_paths: ["C:\\drivers\\InceptorJDBC.jar"] },
    { database_info: { driverName: "Inceptor JDBC 8.37.3" } },
    { database_info: { serverComment: "Transwarp Inceptor Server" } },
  ])("detects Inceptor from explicit JDBC identity %#", (identity) => {
    expect(inferJdbcDialect({ db_type: "jdbc", ...identity })).toBe("hive");
  });

  it("recognizes Apache Hive metadata without changing generic hive2 or MySQL inference", () => {
    expect(inferJdbcDialect({ db_type: "jdbc", database_info: { productName: "Apache Hive" } })).toBe("hive");
    expect(inferJdbcDialect({ db_type: "jdbc", driver_label: "Kyuubi JDBC", connection_string: "jdbc:hive2://kyuubi.example.com/default" })).toBe("mysql");
    expect(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:hive2://hiveserver.example.com/default" })).toBe("mysql");
    expect(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:mysql://mysql.example.com/app" })).toBe("mysql");
  });

  it("prefers explicit Kyuubi identity over Apache Hive product metadata", () => {
    expect(inferJdbcDialect({ db_type: "jdbc", driver_label: "Kyuubi JDBC", database_info: { productName: "Apache Hive" } })).toBe("mysql");
  });
});

describe("GaussDB connection mode", () => {
  it("keeps native connections compatible and configures M mode for the vendor JDBC driver", () => {
    const connection = { db_type: "gaussdb", driver_profile: "gaussdb", driver_label: "GaussDB" } as ConnectionConfig;

    expect(gaussdbConnectionMode(connection)).toBe("native");
    setGaussdbConnectionMode(connection, "m-jdbc");
    expect(connection.driver_profile).toBe("gaussdb-m");
    expect(connection.jdbc_driver_class).toBe(GAUSSDB_M_JDBC_DRIVER_CLASS);
    expect(gaussdbIdentifierQuoteOverride(connection)).toBeUndefined();

    setGaussdbConnectionMode(connection, "native");
    expect(connection.driver_profile).toBe("gaussdb");
    expect(connection.jdbc_driver_class).toBeUndefined();
  });

  it("uses the driver default and preserves targetServerType from legacy URL fields", () => {
    const connection = { db_type: "gaussdb", driver_profile: "gaussdb-m" } as ConnectionConfig;

    expect(gaussdbTargetServerType(connection)).toBe("any");

    connection.url_params = "currentSchema=app&targetServerType=slave";
    expect(gaussdbTargetServerType(connection)).toBe("slave");

    connection.url_params = undefined;
    connection.connection_string = "jdbc:gaussdb://db.internal:8000/app?targetServerType=MASTER&ssl=true";
    expect(gaussdbTargetServerType(connection)).toBe("master");

    setGaussdbTargetServerType(connection, "any");
    expect(gaussdbTargetServerType(connection)).toBe("any");
    expect(connection.external_config).toEqual({ gaussdbTargetServerType: "any" });
  });

  it("keeps count query parallelism disabled until explicitly configured", () => {
    const connection = { db_type: "gaussdb", external_config: { retained: true } } as ConnectionConfig;

    expect(gaussdbCountQueryDop(connection)).toBe(1);
    expect(gaussdbCountQueryDopHint(connection)).toBeUndefined();

    setGaussdbCountQueryDop(connection, 8);
    expect(connection.external_config).toEqual({ retained: true, gaussdbCountQueryDop: 8 });
    expect(gaussdbCountQueryDopHint(connection)).toBe("/*+ set(query_dop 8) */");

    connection.external_config = { retained: true, gaussdbCountQueryDop: 32 };
    expect(gaussdbCountQueryDop(connection)).toBe(1);
    expect(gaussdbCountQueryDopHint(connection)).toBeUndefined();

    setGaussdbCountQueryDop(connection, 1);
    expect(connection.external_config).toEqual({ retained: true });
  });
});

describe("query execution schema", () => {
  it.each(["spark", "hive"] as const)("uses the selected database as the %s execution schema", (dbType) => {
    expect(connectionQueryExecutionSchema({ db_type: dbType }, "ai_test", undefined, false)).toBe("ai_test");
  });

  it("prefers an explicit schema for PostgreSQL", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", "reporting", false)).toBe("reporting");
  });

  it("prefers an explicit schema for Kingbase query execution", () => {
    expect(connectionQueryExecutionSchema({ db_type: "kingbase" }, "qinzhou", "sdy_smartsite", false)).toBe("sdy_smartsite");
  });

  it("does not send a schema for MySQL database context", () => {
    expect(connectionQueryExecutionSchema({ db_type: "mysql" }, "app", undefined, false)).toBeUndefined();
  });

  it("does not change data-tab execution context", () => {
    expect(connectionQueryExecutionSchema({ db_type: "spark" }, "ai_test", undefined, true)).toBeUndefined();
  });

  it("keeps generic JDBC Databend schema fallback", () => {
    expect(connectionQueryExecutionSchema({ db_type: "jdbc", connection_string: "jdbc:databend://localhost:8000/default" }, "analytics", undefined, false)).toBe("analytics");
  });
});

describe("object tree node schema", () => {
  it("ignores database-shaped schema metadata for MySQL tables", () => {
    expect(connectionObjectTreeNodeSchema({ db_type: "mysql" }, "app", "app")).toBeUndefined();
  });

  it("uses the SQLite database alias to qualify attached tables", () => {
    expect(connectionObjectTreeNodeSchema({ db_type: "sqlite" }, "analytics")).toBe("analytics");
  });

  it("keeps unqualified Informix metadata on the login owner", () => {
    expect(connectionObjectTreeQuerySchema({ db_type: "informix" }, "prulife")).toBe("");
    expect(connectionObjectTreeNodeSchema({ db_type: "informix" }, "prulife")).toBeUndefined();
  });

  it.each([
    { db_type: "jdbc" as const, connection_string: "jdbc:informix-sqli://localhost:9088/prulife" },
    { db_type: "gbase" as const, driver_profile: "gbase8s" },
  ])("keeps compatible Informix metadata on the login owner", (connection) => {
    expect(connectionObjectTreeQuerySchema(connection, "prulife")).toBe("");
    expect(connectionObjectTreeNodeSchema(connection, "prulife")).toBeUndefined();
  });

  it("preserves explicit Informix owners", () => {
    expect(connectionObjectTreeQuerySchema({ db_type: "informix" }, "prulife", "xtdpcky")).toBe("xtdpcky");
    expect(connectionObjectTreeNodeSchema({ db_type: "informix" }, "prulife", "xtdpcky")).toBe("xtdpcky");
  });

  it("never sends the Cloud Spanner resource path as a metadata schema", () => {
    const connection = { db_type: "spanner" as const };
    const resourcePath = "projects/p/instances/i/databases/db";

    // GoogleSQL's default schema is the empty string, which must survive the
    // `schema || database` default: sending the resource path matches no objects.
    expect(connectionObjectTreeQuerySchema(connection, resourcePath, "")).toBe("");
    expect(connectionObjectTreeQuerySchema(connection, resourcePath)).toBe("");
    expect(metadataSchemaForConnection(connection, resourcePath, "")).toBe("");
    // PostgreSQL-dialect databases and named schemas pass through unchanged.
    expect(connectionObjectTreeQuerySchema(connection, resourcePath, "public")).toBe("public");
    expect(connectionObjectTreeQuerySchema(connection, resourcePath, "analytics")).toBe("analytics");
    expect(metadataSchemaForConnection(connection, resourcePath, "analytics")).toBe("analytics");
    // The tree node resolves to GoogleSQL's blank default schema rather than to the resource
    // path, so the path can never reach qualifiedTableName as a qualifier. It is the empty
    // string and not undefined because Spanner does have a schema level: "" is the literal
    // name of the GoogleSQL user schema.
    expect(connectionObjectTreeNodeSchema(connection, resourcePath)).toBe("");
    expect(connectionObjectTreeNodeSchema(connection, resourcePath, "")).toBe("");
    expect(connectionObjectTreeNodeSchema(connection, resourcePath, "sales")).toBe("sales");
    expect(connectionObjectTreeNodeSchema(connection, resourcePath, resourcePath)).toBe("");
    // Named schemas (Spanner 2024+) reach the tree unchanged now that Spanner is schema-aware.
    expect(connectionObjectTreeQuerySchema(connection, resourcePath, "sales")).toBe("sales");
    expect(databaseObjectTreeNodeSchema("spanner", resourcePath, "sales")).toBe("sales");
    expect(databaseObjectTreeNodeSchema("spanner", resourcePath, "")).toBe("");
    expect(databaseObjectTreeNodeSchema("spanner", resourcePath)).toBe("");
    // Callers that collapsed `node.schema || node.database` before calling in (the sidebar
    // SQL template and DDL paths) hand over the resource path as the schema.
    expect(connectionObjectTreeQuerySchema(connection, resourcePath, resourcePath)).toBe("");
    expect(metadataSchemaForConnection(connection, resourcePath, resourcePath)).toBe("");
  });

  it("keeps the database-as-schema fallback for flat engines and blanks it for Cloud Spanner", () => {
    // Editor completion paths send the database name as the metadata schema when a
    // connection has no schema level; only Spanner must send a blank schema instead.
    expect(connectionDatabaseMetadataSchema({ db_type: "mysql" }, "shop")).toBe("shop");
    expect(connectionDatabaseMetadataSchema({ db_type: "hbase" }, "shop")).toBe("shop");
    expect(connectionDatabaseMetadataSchema({ db_type: "mysql" }, "shop", "other")).toBe("other");
    expect(connectionDatabaseMetadataSchema({ db_type: "spanner" }, "projects/p/instances/i/databases/db")).toBe("");
    expect(connectionDatabaseMetadataSchema({ db_type: "spanner" }, "projects/p/instances/i/databases/db", "")).toBe("");
    expect(connectionDatabaseMetadataSchema({ db_type: "spanner" }, "projects/p/instances/i/databases/db", "public")).toBe("public");
  });
});
