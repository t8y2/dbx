import assert from "node:assert/strict";
import { test } from "vitest";
import { buildFirebirdObjectTemplate, firebirdObjectTemplateForGroup, quoteFirebirdIdentifier, supportsFirebirdObjectTemplates } from "../../apps/desktop/src/lib/sidebar/firebirdObjectTemplates.ts";
import { sidebarObjectTemplateForGroup } from "../../apps/desktop/src/lib/sidebar/databaseObjectTemplates.ts";
import { executableStatementRanges } from "../../apps/desktop/src/lib/sql/sqlStatementRanges.ts";
import type { ConnectionConfig, TreeNode } from "../../apps/desktop/src/types/database.ts";

function connection(dbType: ConnectionConfig["db_type"], driverProfile?: string): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Test",
    db_type: dbType,
    driver_profile: driverProfile,
    host: "127.0.0.1",
    port: 3050,
    username: "sysdba",
    password: "",
  };
}

function group(type: TreeNode["type"], overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: `conn-1:app:${type}`,
    label: type,
    type,
    connectionId: "conn-1",
    database: "app",
    children: [],
    ...overrides,
  };
}

test("Firebird object templates are supported for Firebird connections", () => {
  assert.equal(supportsFirebirdObjectTemplates(connection("firebird")), true);
  assert.equal(supportsFirebirdObjectTemplates(connection("jdbc", "firebird")), true);
  assert.equal(supportsFirebirdObjectTemplates({ db_type: "jdbc", connection_string: "jdbc:firebirdsql://localhost:3050/test.fdb" }), true);
  assert.equal(supportsFirebirdObjectTemplates({ db_type: "jdbc", jdbc_driver_class: "org.firebirdsql.jdbc.FBDriver" }), true);
  assert.equal(supportsFirebirdObjectTemplates(connection("mysql")), false);
  assert.equal(supportsFirebirdObjectTemplates(connection("postgres")), false);
});

test("only supported Firebird object groups expose creation templates", () => {
  const fb = connection("firebird");
  assert.equal(firebirdObjectTemplateForGroup(fb, group("group-procedures"))?.kind, "procedure");
  assert.equal(firebirdObjectTemplateForGroup(fb, group("group-functions"))?.kind, "function");
  assert.equal(firebirdObjectTemplateForGroup(fb, group("group-triggers"))?.kind, "trigger");
  assert.equal(firebirdObjectTemplateForGroup(fb, group("group-views")), null);
  assert.equal(firebirdObjectTemplateForGroup(fb, group("group-functions", { database: "" })), null);
});

test("procedure and function templates use Firebird CREATE OR ALTER syntax", () => {
  assert.equal(
    buildFirebirdObjectTemplate("procedure").sql,
    `CREATE OR ALTER PROCEDURE "new_procedure"
AS
BEGIN
  /* Procedure body */
END;`,
  );
  assert.equal(
    buildFirebirdObjectTemplate("function").sql,
    `CREATE OR ALTER FUNCTION "new_function"()
RETURNS INTEGER
AS
BEGIN
  RETURN 0;
END;`,
  );
});

test("DBX parses every Firebird template as one executable statement", () => {
  for (const kind of ["procedure", "function"] as const) {
    const ranges = executableStatementRanges(buildFirebirdObjectTemplate(kind).sql, "firebird");
    assert.equal(ranges.length, 1, kind);
    assert.match(ranges[0].sql, new RegExp(`^CREATE OR ALTER ${kind.toUpperCase()}`));
  }
  const tableTriggerRanges = executableStatementRanges(buildFirebirdObjectTemplate("trigger", "A_DETAIL").sql, "firebird");
  assert.equal(tableTriggerRanges.length, 1, "table trigger");
  assert.match(tableTriggerRanges[0].sql, /^CREATE OR ALTER TRIGGER/);

  const dbTriggerRanges = executableStatementRanges(buildFirebirdObjectTemplate("trigger").sql, "firebird");
  assert.equal(dbTriggerRanges.length, 1, "database trigger");
  assert.match(dbTriggerRanges[0].sql, /^CREATE OR ALTER TRIGGER/);
});

test("trigger templates use table context when available and ON CONNECT for database triggers", () => {
  const tableTrigger = buildFirebirdObjectTemplate("trigger", 'order"items');
  assert.match(tableTrigger.sql, /FOR "order""items"/);
  assert.match(tableTrigger.sql, /ACTIVE BEFORE INSERT POSITION 0/);

  const dbTrigger = buildFirebirdObjectTemplate("trigger");
  assert.match(dbTrigger.sql, /ACTIVE ON CONNECT POSITION 0/);

  const groupTemplate = firebirdObjectTemplateForGroup(connection("firebird"), group("group-triggers", { tableName: "A_DETAIL" }));
  assert.equal(groupTemplate?.kind, "trigger");
  assert.match(groupTemplate?.sql || "", /FOR "A_DETAIL"/);
});

test("quoteFirebirdIdentifier properly escapes quotes", () => {
  assert.equal(quoteFirebirdIdentifier("table_name"), '"table_name"');
  assert.equal(quoteFirebirdIdentifier('my"table"name'), '"my""table""name"');
});

test("sidebarObjectTemplateForGroup routes both MySQL and Firebird templates", () => {
  const mysql = connection("mysql", "mysql");
  const fb = connection("firebird");
  const pg = connection("postgres");

  const mysqlTpl = sidebarObjectTemplateForGroup(mysql, group("group-triggers", { tableName: "orders" }));
  assert.equal(mysqlTpl?.kind, "trigger");
  assert.match(mysqlTpl?.sql || "", /DELIMITER/);

  const fbTpl = sidebarObjectTemplateForGroup(fb, group("group-triggers", { tableName: "ORDERS" }));
  assert.equal(fbTpl?.kind, "trigger");
  assert.match(fbTpl?.sql || "", /CREATE OR ALTER TRIGGER "new_trigger" FOR "ORDERS"/);

  assert.equal(sidebarObjectTemplateForGroup(pg, group("group-triggers", { tableName: "orders" })), null);
});
