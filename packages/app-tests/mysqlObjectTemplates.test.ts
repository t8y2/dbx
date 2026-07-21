import assert from "node:assert/strict";
import { test } from "vitest";
import { buildMysqlObjectTemplate, mysqlObjectTemplateForGroup, supportsMysqlObjectTemplates } from "../../apps/desktop/src/lib/sidebar/mysqlObjectTemplates.ts";
import { executableStatementRanges } from "../../apps/desktop/src/lib/sql/sqlStatementRanges.ts";
import type { ConnectionConfig, TreeNode } from "../../apps/desktop/src/types/database.ts";

function connection(dbType: ConnectionConfig["db_type"], driverProfile?: string): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Test",
    db_type: dbType,
    driver_profile: driverProfile,
    host: "127.0.0.1",
    port: 3306,
    username: "root",
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

test("MySQL object templates are limited to native and custom MySQL profiles", () => {
  assert.equal(supportsMysqlObjectTemplates(connection("mysql")), true);
  assert.equal(supportsMysqlObjectTemplates(connection("mysql", "mysql")), true);
  assert.equal(supportsMysqlObjectTemplates(connection("mysql", "CUSTOM_MYSQL")), true);

  for (const profile of ["doris", "selectdb", "starrocks", "tidb", "oceanbase", "mariadb"]) {
    assert.equal(supportsMysqlObjectTemplates(connection("mysql", profile)), false, profile);
  }
  assert.equal(supportsMysqlObjectTemplates(connection("starrocks", "starrocks")), false);
  assert.equal(supportsMysqlObjectTemplates(connection("jdbc", "mysql")), false);
});

test("only supported MySQL object groups expose creation templates", () => {
  const mysql = connection("mysql", "mysql");
  assert.equal(mysqlObjectTemplateForGroup(mysql, group("group-procedures"))?.kind, "procedure");
  assert.equal(mysqlObjectTemplateForGroup(mysql, group("group-functions"))?.kind, "function");
  assert.equal(mysqlObjectTemplateForGroup(mysql, group("group-triggers"))?.kind, "trigger");
  assert.equal(mysqlObjectTemplateForGroup(mysql, group("group-views")), null);
  assert.equal(mysqlObjectTemplateForGroup(mysql, group("group-functions", { database: "" })), null);
});

test("procedure and function templates are executable and database-qualified", () => {
  assert.equal(buildMysqlObjectTemplate("procedure", "db`x").sql, "DELIMITER $$\n\nCREATE PROCEDURE `db``x`.`new_procedure`()\nBEGIN\n  SELECT 1;\nEND$$\n\nDELIMITER ;");
  assert.equal(buildMysqlObjectTemplate("function", "app").sql, "DELIMITER $$\n\nCREATE FUNCTION `app`.`new_function`()\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 0;\nEND$$\n\nDELIMITER ;");
});

test("DBX parses every template as one executable MySQL statement", () => {
  for (const kind of ["procedure", "function", "trigger"] as const) {
    const ranges = executableStatementRanges(buildMysqlObjectTemplate(kind, "app", "orders").sql, "mysql");
    assert.equal(ranges.length, 1, kind);
    assert.match(ranges[0].sql, new RegExp(`^CREATE ${kind.toUpperCase()}`));
    assert.doesNotMatch(ranges[0].sql, /DELIMITER/i);
  }
});

test("trigger templates use table context when available and otherwise keep an editable placeholder", () => {
  assert.match(buildMysqlObjectTemplate("trigger", "app", "order`items").sql, /BEFORE INSERT ON `app`\.`order``items`/);
  assert.match(buildMysqlObjectTemplate("trigger", "app").sql, /BEFORE INSERT ON `app`\.`table_name`/);

  const template = mysqlObjectTemplateForGroup(connection("mysql", "mysql"), group("group-triggers", { tableName: "orders" }));
  assert.equal(template?.kind, "trigger");
  assert.match(template?.sql || "", /BEFORE INSERT ON `app`\.`orders`/);
});
