import { describe, expect, it } from "vitest";
import { editableDatabasePropertyGroups, editableSchemaPropertyGroups } from "@/lib/database/databasePropertyEditing";
import { buildDatabaseOwnerSql, buildGetDatabaseOwnerSql, buildGetSchemaOwnerSql, buildSchemaOwnerSql, supportsOwnerEditing } from "@/lib/database/databaseOwnerEditing";

const postgresConnection = { db_type: "postgres" as const, driver_profile: undefined, read_only: false };

describe("database owner editing", () => {
  it("exposes owner editing for PostgreSQL databases and schemas", () => {
    expect(supportsOwnerEditing("postgres")).toBe(true);
    expect(supportsOwnerEditing("mysql")).toBe(false);
    expect(editableDatabasePropertyGroups(postgresConnection, { type: "database", database: "app_db" })).toContain("owner");
    expect(editableSchemaPropertyGroups(postgresConnection, { type: "schema", database: "app_db", schema: "sales" })).toContain("owner");
  });

  it("exposes owner editing for PostgreSQL-family dialects with pg_get_userbyid support", () => {
    for (const db_type of ["gaussdb", "kwdb", "opengauss", "kingbase", "highgo", "uxdb", "vastbase"] as const) {
      const connection = { ...postgresConnection, db_type };
      expect(supportsOwnerEditing(db_type)).toBe(true);
      expect(editableDatabasePropertyGroups(connection, { type: "database", database: "app_db" })).toContain("owner");
      expect(editableSchemaPropertyGroups(connection, { type: "schema", database: "app_db", schema: "sales" })).toContain("owner");
    }
    expect(supportsOwnerEditing("yashandb")).toBe(false);
    expect(supportsOwnerEditing("sqlite")).toBe(false);
  });

  it("hides owner editing on read-only connections", () => {
    const readOnly = { ...postgresConnection, read_only: true };
    expect(editableDatabasePropertyGroups(readOnly, { type: "database", database: "app_db" })).toEqual([]);
    expect(editableSchemaPropertyGroups(readOnly, { type: "schema", database: "app_db", schema: "sales" })).toEqual([]);
  });

  it("quotes identifiers in ALTER OWNER statements", () => {
    expect(buildDatabaseOwnerSql("app-db", 'odd"role')).toBe('ALTER DATABASE "app-db" OWNER TO "odd""role";');
    expect(buildSchemaOwnerSql("sales", "app_owner")).toBe('ALTER SCHEMA "sales" OWNER TO "app_owner";');
  });

  it("escapes literal names in owner lookup queries", () => {
    expect(buildGetDatabaseOwnerSql("app'db")).toContain("datname = 'app''db'");
    expect(buildGetSchemaOwnerSql("odd'schema")).toContain("nspname = 'odd''schema'");
  });
});
