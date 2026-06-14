import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SCHEMA_AWARE_TYPES,
  TREE_SCHEMA_TYPES,
  databaseProductCapabilities,
  databaseSupportLevel,
  databaseObjectTreeNodeSchema,
  databaseObjectTreeQuerySchema,
  getDatabaseCapability,
  manifestDatabaseTypes,
  sidebarObjectKindsForDatabase,
  supportsDatabaseCreation,
  supportsDatabaseSearch,
  supportsDriverManagement,
  supportsFieldLineage,
  supportsObjectBrowser,
  supportsObjectBrowserTreeNode,
  supportsSchemaDiagram,
  supportsSqlFileExecution,
  supportsTableImport,
  supportsTableTruncate,
  supportsTableStructureEditing,
  supportsTransfer,
  usesDatabaseObjectTreeMode,
  usesPostgresLikeStructureCopy,
  usesTreeSchemaMode,
} from "../../apps/desktop/src/lib/databaseCapabilities.ts";

test("treats Trino catalogs as schema tree roots", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("trino"), true);
});

test("treats DB2 databases as schema tree roots", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("db2"), true);
  assert.equal(usesTreeSchemaMode("db2"), true);
});

test("treats TDengine databases as schema tree roots and agent driver databases", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("tdengine"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("tdengine"), true);
  assert.equal(supportsDriverManagement("tdengine"), true);
});

test("treats XuguDB as a schema-aware agent driver database", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("xugu"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("xugu"), true);
  assert.equal(supportsDatabaseSearch("xugu"), true);
  assert.equal(supportsDriverManagement("xugu"), true);
});

test("treats IoTDB as a schema-aware agent driver database", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("iotdb"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("iotdb"), true);
  assert.equal(supportsDatabaseSearch("iotdb"), true);
  assert.equal(supportsDriverManagement("iotdb"), true);
});

test("treats Access as a local single-database agent driver", () => {
  assert.equal(SCHEMA_AWARE_TYPES.has("access"), false);
  assert.equal(supportsDriverManagement("access"), true);
  assert.equal(supportsDatabaseSearch("access"), true);
  assert.equal(supportsTableImport("access"), true);
});

test("exposes the extended JDBC agent ecosystem through driver management", () => {
  for (const dbType of ["databricks", "saphana", "teradata", "vertica", "firebird", "exasol", "opengauss", "oceanbase-oracle", "gbase", "questdb"] as const) {
    assert.equal(supportsDriverManagement(dbType), true, `${dbType} should be agent-managed`);
    assert.equal(supportsDatabaseSearch(dbType), true, `${dbType} should support database search`);
  }

  assert.equal(SCHEMA_AWARE_TYPES.has("databricks"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("opengauss"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("oceanbase-oracle"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("firebird"), false);
});

test("describes schema tree mode through the capability helper", () => {
  assert.equal(usesTreeSchemaMode("trino"), true);
  assert.equal(usesTreeSchemaMode("h2"), true);
  assert.equal(usesTreeSchemaMode("mysql"), false);
  assert.equal(usesTreeSchemaMode(undefined), false);
});

test("generic JDBC database nodes list objects directly under catalogs", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("jdbc"), true);
  assert.equal(usesDatabaseObjectTreeMode("jdbc"), true);
  assert.equal(databaseObjectTreeQuerySchema("jdbc", "test"), "");
  assert.equal(databaseObjectTreeNodeSchema("jdbc", "test"), undefined);
  assert.equal(databaseObjectTreeQuerySchema("jdbc", "test", "dataeye_starpony"), "");
  assert.equal(databaseObjectTreeNodeSchema("jdbc", "test", "dataeye_starpony"), undefined);
});

test("schema tree databases still use database nodes as default schema context", () => {
  assert.equal(usesDatabaseObjectTreeMode("postgres"), false);
  assert.equal(databaseObjectTreeQuerySchema("postgres", "app"), "app");
  assert.equal(databaseObjectTreeNodeSchema("postgres", "app"), "app");
});

test("treats Trino tables as schema-qualified SQL targets", () => {
  assert.equal(SCHEMA_AWARE_TYPES.has("trino"), true);
});

test("describes table editing capabilities for special database engines", () => {
  assert.deepEqual(getDatabaseCapability("hive").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: true,
    transaction: false,
  });

  assert.deepEqual(getDatabaseCapability("dameng").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });

  assert.deepEqual(getDatabaseCapability("trino").tableData, {
    insert: true,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    keylessRowPredicate: false,
    requiresTransactionalTableForExistingRows: false,
    transaction: false,
  });

  assert.deepEqual(getDatabaseCapability("manticoresearch").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: false,
  });

  assert.deepEqual(getDatabaseCapability("jdbc").tableData, {
    insert: false,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    keylessRowPredicate: false,
    requiresTransactionalTableForExistingRows: false,
    transaction: false,
  });

  assert.deepEqual(getDatabaseCapability("yashandb").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });

  assert.equal(getDatabaseCapability("oracle").syntheticKey, "oracle-rowid");
  assert.equal(getDatabaseCapability("neo4j").syntheticKey, "neo4j-element-id");
});

test("uses Navicat-style table editing defaults for updateable SQL table engines", () => {
  assert.deepEqual(getDatabaseCapability("postgres").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
  assert.deepEqual(getDatabaseCapability("mysql").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
  assert.deepEqual(getDatabaseCapability("sqlite").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
  assert.deepEqual(getDatabaseCapability("rqlite").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
  assert.deepEqual(getDatabaseCapability("kwdb").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    keylessRowPredicate: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
});

test("keeps conservative table editing defaults for unknown database types", () => {
  assert.deepEqual(getDatabaseCapability(undefined).tableData, {
    insert: false,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    keylessRowPredicate: false,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
});

test("describes feature support through capability helpers", () => {
  assert.equal(supportsSqlFileExecution("mysql"), true);
  assert.equal(supportsSqlFileExecution("redis"), false);
  assert.equal(supportsSchemaDiagram("oracle"), true);
  assert.equal(supportsSchemaDiagram("trino"), false);
  assert.equal(supportsDatabaseSearch("neo4j"), true);
  assert.equal(supportsDatabaseSearch("redis"), false);
  assert.equal(supportsTableImport("duckdb"), true);
  assert.equal(supportsTableImport("hive"), false);
  assert.equal(supportsTableStructureEditing("postgres"), true);
  assert.equal(supportsTableStructureEditing("duckdb"), true);
  assert.equal(supportsTableStructureEditing("oracle"), true);
  assert.equal(supportsTableStructureEditing("dameng"), true);
  assert.equal(supportsTableStructureEditing("gaussdb"), true);
  assert.equal(supportsTableStructureEditing("kwdb"), true);
  assert.equal(supportsTableStructureEditing("opengauss"), true);
  assert.equal(supportsTableStructureEditing("redshift"), true);
  assert.equal(supportsTableStructureEditing("clickhouse"), true);
  assert.equal(supportsTableStructureEditing("gbase"), true);
  assert.equal(supportsTableStructureEditing("informix"), true);
  assert.equal(supportsTableStructureEditing("rqlite"), true);
  assert.equal(supportsTableStructureEditing("mongodb"), false);
  assert.equal(supportsTableStructureEditing("manticoresearch"), true);
  assert.equal(supportsDatabaseCreation("clickhouse"), true);
  assert.equal(supportsDatabaseCreation("manticoresearch"), false);
  assert.equal(supportsDatabaseCreation("sqlite"), false);
  assert.equal(supportsFieldLineage("gaussdb"), true);
  assert.equal(supportsFieldLineage("kwdb"), true);
  assert.equal(supportsFieldLineage("trino"), false);
  assert.equal(supportsTransfer("duckdb"), true);
  assert.equal(supportsTransfer("hive"), true);
  assert.equal(supportsTransfer("mongodb"), true);
  assert.equal(supportsTransfer("manticoresearch"), false);
  assert.equal(supportsDriverManagement("oracle"), true);
  assert.equal(supportsDriverManagement("mysql"), false);
  assert.equal(supportsDriverManagement("manticoresearch"), false);
  assert.equal(supportsDriverManagement("kwdb"), false);
  assert.equal(usesPostgresLikeStructureCopy("gaussdb"), true);
  assert.equal(usesPostgresLikeStructureCopy("kwdb"), true);
  assert.equal(usesPostgresLikeStructureCopy("mysql"), false);
  assert.equal(supportsObjectBrowser("mysql"), true);
  assert.equal(supportsObjectBrowser("manticoresearch"), false);
  assert.equal(supportsObjectBrowser("mongodb"), false);
  assert.equal(supportsTableTruncate("mysql"), true);
  assert.equal(supportsTableTruncate("manticoresearch"), false);
  assert.equal(supportsTableTruncate("duckdb"), false);
  assert.equal(supportsTableTruncate("rqlite"), false);
});

test("loads product support levels and capabilities from the driver manifest", () => {
  assert.equal(manifestDatabaseTypes().includes("mysql"), true);
  assert.equal(databaseSupportLevel("mysql"), "operate");
  assert.equal(databaseSupportLevel("manticoresearch"), "operate");
  assert.equal(databaseSupportLevel("jdbc"), "browse");
  assert.equal(databaseSupportLevel("redis"), "connect");

  assert.deepEqual(
    {
      metadataBrowse: databaseProductCapabilities("jdbc").metadataBrowse,
      objectBrowser: databaseProductCapabilities("jdbc").objectBrowser,
      tableStructureEdit: databaseProductCapabilities("jdbc").tableStructureEdit,
      userAdmin: databaseProductCapabilities("jdbc").userAdmin,
    },
    {
      metadataBrowse: true,
      objectBrowser: true,
      tableStructureEdit: false,
      userAdmin: false,
    },
  );

  assert.deepEqual(
    {
      queryExecution: databaseProductCapabilities("manticoresearch").queryExecution,
      metadataBrowse: databaseProductCapabilities("manticoresearch").metadataBrowse,
      objectBrowser: databaseProductCapabilities("manticoresearch").objectBrowser,
      tableDataEdit: databaseProductCapabilities("manticoresearch").tableDataEdit,
      tableStructureEdit: databaseProductCapabilities("manticoresearch").tableStructureEdit,
      sqlFileExecution: databaseProductCapabilities("manticoresearch").sqlFileExecution,
      userAdmin: databaseProductCapabilities("manticoresearch").userAdmin,
    },
    {
      queryExecution: true,
      metadataBrowse: true,
      objectBrowser: false,
      tableDataEdit: true,
      tableStructureEdit: true,
      sqlFileExecution: true,
      userAdmin: false,
    },
  );
});

test("object browser entry follows database tree shape", () => {
  assert.equal(supportsObjectBrowserTreeNode("postgres", "database"), false);
  assert.equal(supportsObjectBrowserTreeNode("postgres", "schema"), true);
  assert.equal(supportsObjectBrowserTreeNode("sqlserver", "database"), true);
  assert.equal(supportsObjectBrowserTreeNode("sqlserver", "schema"), true);
  assert.equal(supportsObjectBrowserTreeNode("mysql", "database"), true);
  assert.equal(supportsObjectBrowserTreeNode("jdbc", "database"), true);
  assert.equal(supportsObjectBrowserTreeNode("mongodb", "database"), false);
});

test("sidebar object capability registry describes object groups by database type", () => {
  assert.deepEqual(sidebarObjectKindsForDatabase("databend"), ["TABLE", "VIEW"]);
  assert.deepEqual(sidebarObjectKindsForDatabase("manticoresearch"), ["TABLE", "FUNCTION"]);
  assert.deepEqual(sidebarObjectKindsForDatabase("postgres"), ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"]);
  assert.deepEqual(sidebarObjectKindsForDatabase("oracle"), ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"]);
});
