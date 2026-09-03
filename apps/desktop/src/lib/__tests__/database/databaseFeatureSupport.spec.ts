import { describe, expect, it } from "vitest";
import { connectionNamespaceCreationTarget, databaseNodeNamespaceCreationTarget } from "@/lib/database/databaseNamespaceCreation";
import { editableDatabasePropertyGroups, editableSchemaPropertyGroups } from "@/lib/database/databasePropertyEditing";
import { buildGetDatabaseCommentSql } from "@/lib/database/dbAdminSql";
import {
  defaultAutoCommitForDbType,
  isSchemaAware,
  supportsConnectionScopedQueryExecution,
  supportsConnectionDatabaseBrowser,
  supportsDatabaseNameCompletion,
  supportsDatabaseSchemaQualifier,
  supportsObjectBrowser,
  supportsObjectBrowserTreeNode,
  supportsQueryTargetDatabaseListing,
  supportsQueryEditorBlockComments,
  supportsSqlInListPaste,
  supportsTableImport,
  supportsTableVacuum,
  supportsTransaction,
  usesConnectionOnlyQueryTarget,
  usesTreeSchemaMode,
  schemaNodeHasLoadableName,
} from "@/lib/database/databaseFeatureSupport";

describe("schema awareness", () => {
  it("keeps SQLite database aliases separate from schema-capable databases", () => {
    expect(isSchemaAware("sqlite")).toBe(false);
  });

  it("puts Cloud Spanner in both schema sets because they gate different surfaces", () => {
    // Spanner 2024+ has named schemas and they are queryable, so both have to be true. The two sets
    // are not interchangeable: SCHEMA_AWARE_TYPES reaches the schema pickers in dialogs, while
    // TREE_SCHEMA_TYPES is what makes a database node load schemas instead of tables. With only the
    // former, `sales` showed up in the schema-diff dropdown but was unreachable in the object tree.
    expect(isSchemaAware("spanner")).toBe(true);
    expect(usesTreeSchemaMode("spanner")).toBe(true);
  });

  it("treats Cloud Spanner's blank schema as a loadable node name", () => {
    // The GoogleSQL default schema node carries "", so a truthiness check would render an
    // expandable node that never loads its tables. Other types keep the truthiness test, which is
    // what filters the undefined schema on nodes that have no schema level at all.
    expect(schemaNodeHasLoadableName("spanner", "")).toBe(true);
    expect(schemaNodeHasLoadableName("spanner", "sales")).toBe(true);
    expect(schemaNodeHasLoadableName("spanner", undefined)).toBe(false);
    expect(schemaNodeHasLoadableName("postgres", "")).toBe(false);
    expect(schemaNodeHasLoadableName("postgres", "public")).toBe(true);
  });
});

describe("connection database browser", () => {
  it("follows object browser support without enabling unsupported connection types", () => {
    expect(supportsConnectionDatabaseBrowser("postgres")).toBe(true);
    expect(supportsConnectionDatabaseBrowser("redis")).toBe(false);
    expect(supportsConnectionDatabaseBrowser("mongodb")).toBe(false);
  });
});

describe("object browser tree nodes", () => {
  it("opens MongoDB object browser from mongo-db nodes without the SQL database list", () => {
    expect(supportsObjectBrowser("mongodb")).toBe(true);
    expect(supportsObjectBrowserTreeNode("mongodb", "mongo-db")).toBe(true);
    expect(supportsObjectBrowserTreeNode("mongodb", "database")).toBe(false);
    expect(supportsObjectBrowserTreeNode("mysql", "database")).toBe(true);
    expect(supportsObjectBrowserTreeNode("mysql", "mongo-db")).toBe(false);
  });
});

describe("connection-scoped query targets", () => {
  it("keeps connection-only target types separate from unregistered namespace targets", () => {
    expect(usesConnectionOnlyQueryTarget("etcd")).toBe(true);
    expect(usesConnectionOnlyQueryTarget("zookeeper")).toBe(true);
    expect(usesConnectionOnlyQueryTarget("elasticsearch")).toBe(true);
    expect(supportsConnectionScopedQueryExecution("elasticsearch")).toBe(true);
    expect(supportsQueryTargetDatabaseListing("elasticsearch")).toBe(false);
    expect(usesConnectionOnlyQueryTarget("qdrant")).toBe(true);
    expect(usesConnectionOnlyQueryTarget("milvus")).toBe(true);
    expect(usesConnectionOnlyQueryTarget("weaviate")).toBe(true);
    expect(usesConnectionOnlyQueryTarget("chromadb")).toBe(true);
    expect(supportsQueryTargetDatabaseListing("etcd")).toBe(false);
  });
});

describe("database and schema qualifiers", () => {
  it.each(["sqlserver", "trino", "prestosql"] as const)("supports three-part object names for %s", (databaseType) => {
    expect(supportsDatabaseSchemaQualifier(databaseType)).toBe(true);
  });

  it.each(["mysql", "postgres", "oracle", "snowflake"] as const)("does not widen unverified three-part completion for %s", (databaseType) => {
    expect(supportsDatabaseSchemaQualifier(databaseType)).toBe(false);
  });

  it.each(["mysql", "sqlite", "sqlserver"] as const)("suggests database names for %s", (databaseType) => {
    expect(supportsDatabaseNameCompletion(databaseType)).toBe(true);
  });

  it.each(["postgres", "oracle", "snowflake", "trino", "prestosql"] as const)("does not add database name completion for %s", (databaseType) => {
    expect(supportsDatabaseNameCompletion(databaseType)).toBe(false);
  });
});

describe("supportsTransaction", () => {
  it("returns true for supported database types", () => {
    expect(supportsTransaction("postgres")).toBe(true);
    expect(supportsTransaction("mysql")).toBe(true);
    expect(supportsTransaction("oracle")).toBe(true);
    expect(supportsTransaction("jdbc")).toBe(true);
  });

  it("returns false for unsupported database types", () => {
    expect(supportsTransaction("oceanbase-oracle")).toBe(false);
    expect(supportsTransaction("redis")).toBe(false);
    expect(supportsTransaction("mongodb")).toBe(false);
    expect(supportsTransaction("duckdb")).toBe(false);
    expect(supportsTransaction("qdrant")).toBe(false);
    expect(supportsTransaction("turso")).toBe(false);
    expect(supportsTransaction("cloudflare-d1")).toBe(false);
    expect(supportsTransaction("sqlite")).toBe(false);
    expect(supportsTransaction("clickhouse")).toBe(false);
    expect(supportsTransaction("sqlserver")).toBe(false);
    expect(supportsTransaction("dameng")).toBe(false);
    expect(supportsTransaction("rqlite")).toBe(false);
    expect(supportsTransaction("agent")).toBe(false);
  });

  it("returns false for undefined or empty input", () => {
    expect(supportsTransaction(undefined)).toBe(false);
  });
});

describe("defaultAutoCommitForDbType", () => {
  it("defaults query tabs to auto-commit unless the user configured manual", () => {
    expect(defaultAutoCommitForDbType("oceanbase-oracle")).toBe(true);
    expect(defaultAutoCommitForDbType("oracle")).toBe(true);
    expect(defaultAutoCommitForDbType("mysql")).toBe(true);
    expect(defaultAutoCommitForDbType("postgres")).toBe(true);
    expect(defaultAutoCommitForDbType("dameng")).toBe(true);
    expect(defaultAutoCommitForDbType(undefined)).toBe(true);
  });

  it("honors the configured default transaction mode", () => {
    expect(defaultAutoCommitForDbType("mysql", "manual")).toBe(false);
    expect(defaultAutoCommitForDbType("postgres", "manual")).toBe(false);
    expect(defaultAutoCommitForDbType("oracle", "manual")).toBe(false);
    expect(defaultAutoCommitForDbType("jdbc", "manual")).toBe(false);
    expect(defaultAutoCommitForDbType("mysql", "auto")).toBe(true);
    expect(defaultAutoCommitForDbType(undefined, "auto")).toBe(true);
  });

  it("keeps non-transaction databases auto-commit even when manual is configured", () => {
    expect(defaultAutoCommitForDbType("redis", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType("mongodb", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType("sqlite", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType("dameng", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType("clickhouse", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType("oceanbase-oracle", "manual")).toBe(true);
    expect(defaultAutoCommitForDbType(undefined, "manual")).toBe(true);
  });
});

describe("supportsSqlInListPaste", () => {
  it("allows generic and SQL-like editors", () => {
    expect(supportsSqlInListPaste(undefined)).toBe(true);
    expect(supportsSqlInListPaste("mysql")).toBe(true);
    expect(supportsSqlInListPaste("postgres")).toBe(true);
    expect(supportsSqlInListPaste("oracle")).toBe(true);
    expect(supportsSqlInListPaste("sqlserver")).toBe(true);
    expect(supportsSqlInListPaste("sqlite")).toBe(true);
    expect(supportsSqlInListPaste("cassandra")).toBe(true);
    expect(supportsSqlInListPaste("tdengine")).toBe(true);
    expect(supportsSqlInListPaste("iotdb")).toBe(true);
    expect(supportsSqlInListPaste("jdbc")).toBe(true);
  });

  it("hides SQL IN list paste in non-SQL editors", () => {
    expect(supportsSqlInListPaste("redis")).toBe(false);
    expect(supportsSqlInListPaste("mongodb")).toBe(false);
    expect(supportsSqlInListPaste("elasticsearch")).toBe(false);
    expect(supportsSqlInListPaste("easysearch")).toBe(false);
    expect(supportsSqlInListPaste("meilisearch")).toBe(false);
    expect(supportsSqlInListPaste("qdrant")).toBe(false);
    expect(supportsSqlInListPaste("milvus")).toBe(false);
    expect(supportsSqlInListPaste("weaviate")).toBe(false);
    expect(supportsSqlInListPaste("chromadb")).toBe(false);
    expect(supportsSqlInListPaste("etcd")).toBe(false);
    expect(supportsSqlInListPaste("zookeeper")).toBe(false);
    expect(supportsSqlInListPaste("mq")).toBe(false);
    expect(supportsSqlInListPaste("nacos")).toBe(false);
  });

  it("excludes Neo4j because Cypher uses list syntax instead of SQL IN tuples", () => {
    expect(supportsSqlInListPaste("neo4j")).toBe(false);
  });
});

describe("supportsQueryEditorBlockComments", () => {
  it("allows block comments in generic and SQL editors", () => {
    expect(supportsQueryEditorBlockComments(undefined)).toBe(true);
    expect(supportsQueryEditorBlockComments("mysql")).toBe(true);
    expect(supportsQueryEditorBlockComments("postgres")).toBe(true);
    expect(supportsQueryEditorBlockComments("sqlserver")).toBe(true);
  });

  it("hides block comments in non-SQL editors", () => {
    expect(supportsQueryEditorBlockComments("redis")).toBe(false);
    expect(supportsQueryEditorBlockComments("mongodb")).toBe(false);
    expect(supportsQueryEditorBlockComments("elasticsearch")).toBe(false);
  });
});

describe("supportsTableVacuum", () => {
  it("enables VACUUM for the supported PostgreSQL family", () => {
    for (const databaseType of ["postgres", "gaussdb", "opengauss", "kingbase", "vastbase", "highgo", "uxdb", "kwdb"] as const) {
      expect(supportsTableVacuum(databaseType)).toBe(true);
    }
  });

  it("does not enable VACUUM for unrelated database types", () => {
    for (const databaseType of ["mysql", "sqlite", "redshift", "oracle", "jdbc"] as const) {
      expect(supportsTableVacuum(databaseType)).toBe(false);
    }
  });
});

describe("supportsTableImport", () => {
  it("enables OceanBase Oracle table import", () => {
    expect(supportsTableImport("oceanbase-oracle")).toBe(true);
  });
});

describe("database property editing", () => {
  it("allows MySQL-compatible charset and collation edits on database nodes", () => {
    expect(editableDatabasePropertyGroups({ db_type: "mysql" }, { type: "database", database: "app" })).toEqual(["charsetCollation"]);
    expect(editableDatabasePropertyGroups({ db_type: "goldendb" }, { type: "database", database: "app" })).toEqual(["charsetCollation"]);
    expect(editableDatabasePropertyGroups({ db_type: "jdbc", driver_profile: "mysql" }, { type: "database", database: "app" })).toEqual([]);
  });

  it("allows PostgreSQL-style comment edits on supported database and schema nodes", () => {
    expect(editableDatabasePropertyGroups({ db_type: "postgres" }, { type: "database", database: "postgres" })).toEqual(["databaseComment"]);
    expect(editableDatabasePropertyGroups({ db_type: "kingbase" }, { type: "database", database: "TEST" })).toEqual(["databaseComment"]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres" }, { type: "schema", database: "postgres", schema: "public" })).toEqual(["schemaComment"]);
    expect(editableSchemaPropertyGroups({ db_type: "highgo" }, { type: "schema", database: "postgres", schema: "public" })).toEqual(["schemaComment"]);
  });

  it("hides property editing for read-only, unsupported, and wrong tree nodes", () => {
    expect(editableDatabasePropertyGroups({ db_type: "mysql", read_only: true }, { type: "database", database: "app" })).toEqual([]);
    expect(editableDatabasePropertyGroups({ db_type: "sqlite" }, { type: "database", database: "main" })).toEqual([]);
    expect(editableDatabasePropertyGroups({ db_type: "sqlserver" }, { type: "database", database: "master" })).toEqual([]);
    expect(editableDatabasePropertyGroups({ db_type: "hbase" }, { type: "database", database: "default" })).toEqual([]);
    expect(editableDatabasePropertyGroups({ db_type: "postgres" }, { type: "connection" })).toEqual([]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres", read_only: true }, { type: "schema", database: "postgres", schema: "public" })).toEqual([]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres" }, { type: "database", database: "postgres" })).toEqual([]);
  });

  it("queries PostgreSQL database comments from shared object descriptions", () => {
    expect(buildGetDatabaseCommentSql({ databaseType: "postgres", name: "app" })).toContain("shobj_description(db.oid, 'pg_database')");
  });
});

describe("database namespace creation", () => {
  it("allows connection-level database creation for verified database targets", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "mysql" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "sqlserver" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "clickhouse" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "snowflake" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "databend" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "tdengine" })).toBe("database");
  });

  it("keeps non-database creation flows explicit", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "dameng" })).toBe("schema");
    expect(connectionNamespaceCreationTarget({ db_type: "duckdb" })).toBe("attach");
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite" })).toBe("attach");
    expect(connectionNamespaceCreationTarget({ db_type: "mongodb" })).toBe("special");
    expect(connectionNamespaceCreationTarget({ db_type: "mongodb", driver_profile: "mongodb-legacy" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "mongodb", driver_profile: "legacy" })).toBeNull();
  });

  it("hides persistent SQLite attachment for memory and SQLCipher connections", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite", host: ":memory:", password: "" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite", host: "/tmp/main.sqlite", password: "secret" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite", host: "/tmp/main.sqlite", password: "" })).toBe("attach");
  });

  it("hides creation for read-only, file-only, and unknown generic targets", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "mysql", read_only: true })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite", read_only: true })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "jdbc" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "oracle" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "hbase" })).toBeNull();
  });

  it("allows schema creation only on writable database nodes with schema targets", () => {
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres" }, { type: "database", database: "postgres" })).toBe("schema");
    expect(databaseNodeNamespaceCreationTarget({ db_type: "sqlserver" }, { type: "database", database: "master" })).toBe("schema");
    expect(databaseNodeNamespaceCreationTarget({ db_type: "db2" }, { type: "database", database: "SAMPLE" })).toBe("schema");
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres", read_only: true }, { type: "database", database: "postgres" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres" }, { type: "connection" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "mysql" }, { type: "database", database: "app" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "goldendb" }, { type: "database", database: "app" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "duckdb" }, { type: "database", database: "main" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "jdbc" }, { type: "database", database: "main" })).toBeNull();
  });
});
