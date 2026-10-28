import { describe, expect, it } from "vitest";
import {
  customTypeCapabilities,
  databaseObjectCapabilities,
  normalizeSidebarObjectKind,
  schemaDiffRoutineObjectTypes,
  schemaDiffRoutineObjectTypesIntersection,
  supportsOracleFamilyTypeManagement,
  sidebarObjectKindsForDatabase,
  supportsPackageMemberExpansion,
  supportsSchemaDiffRoutines,
  supportsTypeObjectSource,
} from "@/lib/database/databaseObjectCapabilities";
import { buildObjectGroupPlaceholderNodes } from "@/lib/table/tableTree";

describe("databaseObjectCapabilities", () => {
  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("exposes the schema index group for %s without advertising index source", (dbType) => {
    const capabilities = databaseObjectCapabilities(dbType);
    expect(capabilities.sidebarObjects).toContain("INDEX");
    expect(capabilities.sourceReadable).not.toContain("INDEX");
    expect(
      buildObjectGroupPlaceholderNodes({
        nodeId: "connection:database:APP",
        connectionId: "connection",
        database: "database",
        schema: "APP",
        objectTypes: capabilities.sidebarObjects,
      }).map((node) => node.type),
    ).toContain("group-database-indexes");
  });

  it("exposes supported programmable objects for Dameng", () => {
    expect(sidebarObjectKindsForDatabase("dameng")).toEqual(expect.arrayContaining(["MATERIALIZED_VIEW", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"]));
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("exposes %s types and bodies through the existing read-only browsing paths", (dbType) => {
    expect(sidebarObjectKindsForDatabase(dbType)).toEqual(expect.arrayContaining(["TYPE", "TYPE_BODY"]));
    expect(databaseObjectCapabilities(dbType).sourceReadable).toEqual(expect.arrayContaining(["TYPE", "TYPE_BODY"]));
    expect(supportsTypeObjectSource(dbType)).toBe(true);
    expect(customTypeCapabilities(dbType)).toEqual({ details: true, members: true, ddl: false });
  });

  it("exposes synonyms only for database paths with synonym metadata", () => {
    expect(sidebarObjectKindsForDatabase("oracle")).toContain("SYNONYM");
    expect(sidebarObjectKindsForDatabase("xugu")).toContain("SYNONYM");
    expect(sidebarObjectKindsForDatabase("oceanbase-oracle")).toContain("SYNONYM");
    expect(sidebarObjectKindsForDatabase("postgres")).not.toContain("SYNONYM");
  });

  it("exposes OceanBase Oracle sequences and synonyms through the grouped object path", () => {
    const oceanBaseObjects = sidebarObjectKindsForDatabase("oceanbase-oracle");

    expect(oceanBaseObjects).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "INDEX", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"]);
    expect(databaseObjectCapabilities("oceanbase-oracle").sourceReadable).toEqual(["VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"]);
    expect(
      buildObjectGroupPlaceholderNodes({
        nodeId: "connection:database:APP",
        connectionId: "connection",
        database: "database",
        schema: "APP",
        objectTypes: oceanBaseObjects,
      }).map((node) => node.type),
    ).toEqual(["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-sequences", "group-database-indexes", "group-synonyms", "group-packages", "group-package-bodies", "group-types"]);
  });

  it("exposes Oracle sequences through the existing grouped object path", () => {
    const oracleObjects = sidebarObjectKindsForDatabase("oracle");

    expect(oracleObjects).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "INDEX", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"]);
    expect(databaseObjectCapabilities("oracle").sourceReadable).toContain("SEQUENCE");
    expect(
      buildObjectGroupPlaceholderNodes({
        nodeId: "connection:database:HR",
        connectionId: "connection",
        database: "database",
        schema: "HR",
        objectTypes: oracleObjects,
      }).map((node) => node.type),
    ).toContain("group-sequences");
  });

  it("expands package members only for implemented database paths", () => {
    expect(supportsPackageMemberExpansion("oracle")).toBe(true);
    expect(supportsPackageMemberExpansion("xugu")).toBe(true);
    expect(supportsPackageMemberExpansion("dameng")).toBe(false);
    expect(supportsPackageMemberExpansion("opengauss")).toBe(false);
  });

  it("exposes only tables for HBase namespaces", () => {
    expect(sidebarObjectKindsForDatabase("hbase")).toEqual(["TABLE"]);
  });

  it("exposes materialized views for StarRocks only", () => {
    // StarRocks has a dedicated MV listing/classification path in
    // crates/dbx-driver-mysql/src/mysql.rs (`list_starrocks_tables` +
    // `classify_starrocks_materialized_views`).
    expect(sidebarObjectKindsForDatabase("starrocks")).toContain("MATERIALIZED_VIEW");

    // Doris uses the generic SHOW TABLES listing path with no MV classifier,
    // so advertising MV in the sidebar would have nothing to route to.
    // Keep Doris on TABLE_VIEW_OBJECTS until a Doris-specific listing path
    // lands.
    expect(sidebarObjectKindsForDatabase("doris")).not.toContain("MATERIALIZED_VIEW");
    expect(sidebarObjectKindsForDatabase("doris")).toEqual(expect.arrayContaining(["TABLE", "VIEW"]));
  });

  it("exposes triggers only for native MySQL among MySQL-compatible paths", () => {
    expect(sidebarObjectKindsForDatabase("mysql")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);
    expect(databaseObjectCapabilities("mysql").sourceReadable).toEqual(["VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);

    expect(sidebarObjectKindsForDatabase("doris")).toEqual(["TABLE", "VIEW"]);
    expect(sidebarObjectKindsForDatabase("starrocks")).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW"]);
    expect(sidebarObjectKindsForDatabase("manticoresearch")).toEqual(["TABLE", "FUNCTION"]);
    expect(sidebarObjectKindsForDatabase("jdbc")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION"]);
  });

  it("normalizes space separated materialized view types", () => {
    expect(normalizeSidebarObjectKind("MATERIALIZED VIEW")).toBe("MATERIALIZED_VIEW");
  });

  it("exposes TYPE for verified PostgreSQL-family databases only", () => {
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      expect(sidebarObjectKindsForDatabase(dbType), dbType).toContain("TYPE");
    }
    // Unverified PG-like databases must not advertise TYPE this cycle.
    for (const dbType of ["highgo", "uxdb", "redshift", "kwdb"] as const) {
      expect(sidebarObjectKindsForDatabase(dbType), dbType).not.toContain("TYPE");
    }
  });

  it("exposes schema triggers for Kingbase without widening Vastbase", () => {
    expect(sidebarObjectKindsForDatabase("kingbase")).toContain("TRIGGER");
    expect(databaseObjectCapabilities("kingbase").sourceReadable).toContain("TRIGGER");
    expect(sidebarObjectKindsForDatabase("vastbase")).not.toContain("TRIGGER");
  });

  it("discovers Oracle-family triggers alongside the main TYPE and INDEX capabilities", () => {
    for (const dbType of ["oracle", "oceanbase-oracle", "dameng"] as const) {
      expect(databaseObjectCapabilities(dbType).sourceReadable).toContain("TRIGGER");
      expect(sidebarObjectKindsForDatabase(dbType)).toEqual(expect.arrayContaining(["TRIGGER", "TYPE", "TYPE_BODY", "INDEX"]));
    }
  });

  it("exposes sequences for Kingbase and Vastbase via the agent PostgreSQL catalogs", () => {
    for (const dbType of ["kingbase", "vastbase"] as const) {
      expect(sidebarObjectKindsForDatabase(dbType), dbType).toContain("SEQUENCE");
      expect(databaseObjectCapabilities(dbType).sourceReadable, dbType).toContain("SEQUENCE");
    }
  });

  it("opens Oracle-family and Xugu TYPE nodes as source while PG types keep details", () => {
    expect(supportsTypeObjectSource("xugu")).toBe(true);
    for (const dbType of ["oracle", "oceanbase-oracle", "dameng"] as const) {
      expect(supportsTypeObjectSource(dbType)).toBe(true);
      expect(databaseObjectCapabilities(dbType).sourceReadable).toEqual(expect.arrayContaining(["TYPE", "TYPE_BODY"]));
    }
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase", undefined] as const) {
      expect(supportsTypeObjectSource(dbType), String(dbType)).toBe(false);
    }
  });

  it("limits controlled type management to Oracle, OceanBase Oracle, and Dameng", () => {
    for (const dbType of ["oracle", "oceanbase-oracle", "dameng"] as const) {
      expect(supportsOracleFamilyTypeManagement(dbType), dbType).toBe(true);
    }
    for (const dbType of ["xugu", "postgres", "jdbc", undefined] as const) {
      expect(supportsOracleFamilyTypeManagement(dbType), String(dbType)).toBe(false);
    }
  });

  it("keeps sourceReadable in sync with supportsTypeObjectSource", () => {
    expect(databaseObjectCapabilities("xugu").sourceReadable).toContain("TYPE");
    expect(databaseObjectCapabilities("xugu").sourceReadable).toContain("TYPE_BODY");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      expect(databaseObjectCapabilities(dbType).sourceReadable, dbType).not.toContain("TYPE");
      expect(databaseObjectCapabilities(dbType).sourceReadable, dbType).not.toContain("TYPE_BODY");
      // Non-type programmable objects stay source-readable on PG-family.
      expect(databaseObjectCapabilities(dbType).sourceReadable, dbType).toContain("FUNCTION");
    }
  });

  it("exposes packages only for openGauss A compatibility mode", () => {
    expect(sidebarObjectKindsForDatabase("opengauss", "A")).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
    expect(sidebarObjectKindsForDatabase("opengauss", "a")).toContain("PACKAGE");
    for (const mode of ["B", "C", "PG", undefined]) {
      expect(sidebarObjectKindsForDatabase("opengauss", mode), String(mode)).not.toContain("PACKAGE");
    }
    expect(databaseObjectCapabilities("opengauss", "A").sourceReadable).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
  });

  it("enables custom type details only for verified PG-family databases", () => {
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"] as const) {
      expect(customTypeCapabilities(dbType), dbType).toEqual({ details: true, members: true, ddl: true });
    }
    for (const dbType of ["xugu", "highgo", "uxdb", "redshift", "mysql", undefined] as const) {
      expect(customTypeCapabilities(dbType), String(dbType)).toEqual({ details: false, members: false, ddl: false });
    }
  });

  it("opens schema diff routines only for same-dialect allowlisted databases", () => {
    for (const dbType of ["postgres", "opengauss", "mysql", "sqlserver", "gaussdb", "kingbase", "oracle", "oceanbase-oracle"] as const) {
      expect(supportsSchemaDiffRoutines(dbType), dbType).toBe(true);
    }
    for (const dbType of ["dameng", "hive", "sqlite", "doris", "databend", "manticoresearch"] as const) {
      expect(supportsSchemaDiffRoutines(dbType), dbType).toBe(false);
    }
    // Fallback ROUTINE_OBJECTS must not open schema-diff routine compare.
    expect(supportsSchemaDiffRoutines("jdbc")).toBe(false);
    expect(supportsSchemaDiffRoutines(undefined)).toBe(false);
    expect(schemaDiffRoutineObjectTypes("mysql")).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypes("sqlserver")).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypes("oracle")).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypesIntersection("oracle", "oceanbase-oracle")).toEqual([]);
    expect(schemaDiffRoutineObjectTypesIntersection("mysql", "mysql")).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypesIntersection("mysql", "oracle")).toEqual([]);
    expect(schemaDiffRoutineObjectTypesIntersection("mysql", "sqlserver")).toEqual([]);
    expect(schemaDiffRoutineObjectTypesIntersection("postgres", "opengauss")).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(sidebarObjectKindsForDatabase("sqlserver")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION"]);
  });

  it("gates sidebar object kinds per engine", () => {
    // GBase 8s only lists tables and views.
    expect(sidebarObjectKindsForDatabase("gbase8s")).toEqual(["TABLE", "VIEW"]);
    expect(databaseObjectCapabilities("gbase8s").sourceReadable).toEqual(["VIEW"]);
    // Native Informix lists procedures/functions from sysprocedures natively.
    for (const dbType of ["gbase", "informix"] as const) {
      // "gbase" has no explicit entry: in production it resolves to the "mysql"
      // effective type, so direct callers hit the unknown-type ROUTINE_OBJECTS fallback.
      expect(sidebarObjectKindsForDatabase(dbType)).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION"]);
      expect(databaseObjectCapabilities(dbType).sourceReadable).toEqual(["VIEW", "PROCEDURE", "FUNCTION"]);
    }
  });
});
