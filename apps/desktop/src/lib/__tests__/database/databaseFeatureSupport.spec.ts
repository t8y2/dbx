import { describe, expect, it } from "vitest";
import { connectionNamespaceCreationTarget, databaseNodeNamespaceCreationTarget } from "@/lib/database/databaseNamespaceCreation";
import { editableDatabasePropertyGroups, editableSchemaPropertyGroups } from "@/lib/database/databasePropertyEditing";
import { buildGetDatabaseCommentSql } from "@/lib/database/dbAdminSql";
import { supportsSqlInListPaste, supportsTransaction } from "@/lib/database/databaseFeatureSupport";

describe("supportsTransaction", () => {
  it("returns true for supported database types", () => {
    expect(supportsTransaction("postgres")).toBe(true);
    expect(supportsTransaction("mysql")).toBe(true);
  });

  it("returns false for unsupported database types", () => {
    expect(supportsTransaction("redis")).toBe(false);
    expect(supportsTransaction("mongodb")).toBe(false);
    expect(supportsTransaction("duckdb")).toBe(false);
    expect(supportsTransaction("qdrant")).toBe(false);
    expect(supportsTransaction("turso")).toBe(false);
    expect(supportsTransaction("sqlite")).toBe(false);
    expect(supportsTransaction("clickhouse")).toBe(false);
    expect(supportsTransaction("sqlserver")).toBe(false);
    expect(supportsTransaction("oracle")).toBe(false);
    expect(supportsTransaction("dameng")).toBe(false);
    expect(supportsTransaction("rqlite")).toBe(false);
    expect(supportsTransaction("agent")).toBe(false);
  });

  it("returns false for undefined or empty input", () => {
    expect(supportsTransaction(undefined)).toBe(false);
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

  it("keeps special creation flows explicit", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "duckdb" })).toBe("attach");
    expect(connectionNamespaceCreationTarget({ db_type: "mongodb" })).toBe("special");
    expect(connectionNamespaceCreationTarget({ db_type: "mongodb", driver_profile: "mongodb-legacy" })).toBeNull();
  });

  it("hides creation for read-only, file-only, and unknown generic targets", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "mysql", read_only: true })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "sqlite" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "jdbc" })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "oracle" })).toBeNull();
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
