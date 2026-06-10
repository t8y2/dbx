import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  grantsFromQueryResult,
  mysqlAlterUserAccountLockSql,
  mysqlAlterUserPasswordSql,
  mysqlCreateUserSql,
  mysqlDropUserSql,
  mysqlGrantPrivilegesSql,
  mysqlPrivilegeTargetSql,
  mysqlRevokePrivilegesSql,
  mysqlShowGrantsSql,
  mysqlUserAccount,
  normalizeMySqlPrivileges,
  postgresAlterRoleLoginSql,
  postgresAlterRolePasswordSql,
  postgresCreateRoleSql,
  postgresDropRoleSql,
  postgresGrantPrivilegesSql,
  postgresPrivilegeTargetSql,
  postgresRevokePrivilegesSql,
  postgresRoleLabel,
  quoteMySqlIdentifier,
  quoteMySqlString,
  quotePostgresIdentifier,
  supportsDatabaseUserAdmin,
  usersFromMySqlGranteeResult,
  usersFromMySqlUserResult,
  usersFromPostgresRolesResult,
} from "../../apps/desktop/src/lib/databaseUserAdmin.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns,
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

test("detects supported user administration dialects", () => {
  assert.equal(supportsDatabaseUserAdmin("mysql"), true);
  assert.equal(supportsDatabaseUserAdmin("goldendb"), true);
  assert.equal(supportsDatabaseUserAdmin("postgres"), true);
  assert.equal(supportsDatabaseUserAdmin("opengauss"), true);
  assert.equal(supportsDatabaseUserAdmin("sqlserver"), false);
  assert.equal(supportsDatabaseUserAdmin(undefined), false);
});

test("quotes MySQL account parts and identifiers", () => {
  assert.equal(quoteMySqlString("app'user\\"), "'app''user\\\\'");
  assert.equal(quoteMySqlIdentifier("tenant`01"), "`tenant``01`");
  assert.equal(mysqlUserAccount({ user: "app'user", host: "10.0.0.%" }), "'app''user'@'10.0.0.%'");
});

test("builds MySQL user lifecycle SQL", () => {
  const user = { user: "app", host: "%" };

  assert.equal(mysqlShowGrantsSql(user), "SHOW GRANTS FOR 'app'@'%';");
  assert.equal(mysqlCreateUserSql({ ...user, password: "secret" }), "CREATE USER 'app'@'%' IDENTIFIED BY 'secret';");
  assert.equal(mysqlAlterUserPasswordSql(user, "new'secret"), "ALTER USER 'app'@'%' IDENTIFIED BY 'new''secret';");
  assert.equal(mysqlAlterUserAccountLockSql(user, true), "ALTER USER 'app'@'%' ACCOUNT LOCK;");
  assert.equal(mysqlAlterUserAccountLockSql(user, false), "ALTER USER 'app'@'%' ACCOUNT UNLOCK;");
  assert.equal(mysqlDropUserSql(user), "DROP USER 'app'@'%';");
});

test("builds MySQL grant and revoke SQL with normalized privileges", () => {
  const input = {
    user: { user: "reporter", host: "localhost" },
    privileges: ["select", " SELECT ", "show view"],
    database: "analytics",
    table: "daily`rollup",
    grantOption: true,
  };

  assert.deepEqual(normalizeMySqlPrivileges(input.privileges), ["SELECT", "SHOW VIEW"]);
  assert.equal(mysqlPrivilegeTargetSql("analytics", "daily`rollup"), "`analytics`.`daily``rollup`");
  assert.equal(mysqlGrantPrivilegesSql(input), "GRANT SELECT, SHOW VIEW ON `analytics`.`daily``rollup` TO 'reporter'@'localhost' WITH GRANT OPTION;");
  assert.equal(mysqlRevokePrivilegesSql(input), "REVOKE SELECT, SHOW VIEW ON `analytics`.`daily``rollup` FROM 'reporter'@'localhost';");
  assert.equal(mysqlPrivilegeTargetSql("", ""), "*.*");
});

test("parses MySQL user result variants", () => {
  assert.deepEqual(
    usersFromMySqlUserResult(
      result(
        ["User", "Host", "plugin"],
        [
          ["root", "localhost", "caching_sha2_password"],
          ["app", "%", null],
        ],
      ),
    ),
    [
      { user: "root", host: "localhost", plugin: "caching_sha2_password" },
      { user: "app", host: "%", plugin: undefined },
    ],
  );

  assert.deepEqual(usersFromMySqlGranteeResult(result(["GRANTEE"], [["'app'@'%'"], ["'o''brien'@'localhost'"], ["CURRENT_USER"]])), [
    { user: "app", host: "%" },
    { user: "o'brien", host: "localhost" },
  ]);
});

test("extracts grants from show grants result", () => {
  assert.deepEqual(grantsFromQueryResult(result(["Grants for app@%"], [["GRANT SELECT ON `app`.* TO 'app'@'%'"], [null]])), ["GRANT SELECT ON `app`.* TO 'app'@'%'"]);
});

test("builds PostgreSQL role lifecycle SQL", () => {
  const role = { user: 'report"reader', host: "LOGIN" };

  assert.equal(quotePostgresIdentifier('report"reader'), '"report""reader"');
  assert.equal(postgresRoleLabel(role), 'report"reader');
  assert.equal(postgresCreateRoleSql({ ...role, password: "it'works", canLogin: true }), "CREATE ROLE \"report\"\"reader\" LOGIN PASSWORD 'it''works';");
  assert.equal(postgresCreateRoleSql({ ...role, password: "secret", canLogin: false }), 'CREATE ROLE "report""reader" NOLOGIN PASSWORD \'secret\';');
  assert.equal(postgresAlterRolePasswordSql(role, "next"), 'ALTER ROLE "report""reader" PASSWORD \'next\';');
  assert.equal(postgresAlterRoleLoginSql(role, false), 'ALTER ROLE "report""reader" NOLOGIN;');
  assert.equal(postgresAlterRoleLoginSql(role, true), 'ALTER ROLE "report""reader" LOGIN;');
  assert.equal(postgresDropRoleSql(role), 'DROP ROLE "report""reader";');
});

test("builds PostgreSQL privilege and membership SQL", () => {
  const user = { user: "reporter", host: "LOGIN" };

  assert.equal(postgresPrivilegeTargetSql({ scope: "database", database: "analytics" }), 'DATABASE "analytics"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "schema", database: "mart" }), 'SCHEMA "mart"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "table", database: "mart", table: 'daily"rollup' }), 'TABLE "mart"."daily""rollup"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "table", database: "mart", table: "*" }), 'ALL TABLES IN SCHEMA "mart"');
  assert.equal(
    postgresGrantPrivilegesSql({
      user,
      scope: "database",
      database: "analytics",
      privileges: ["connect", "CREATE"],
      grantOption: true,
    }),
    'GRANT CONNECT, CREATE ON DATABASE "analytics" TO "reporter" WITH GRANT OPTION;',
  );
  assert.equal(postgresRevokePrivilegesSql({ user, scope: "schema", database: "mart", privileges: ["usage"] }), 'REVOKE USAGE ON SCHEMA "mart" FROM "reporter";');
  assert.equal(
    postgresGrantPrivilegesSql({
      user,
      scope: "role",
      database: "",
      privileges: [],
      role: "readonly",
      grantOption: true,
    }),
    'GRANT "readonly" TO "reporter" WITH ADMIN OPTION;',
  );
  assert.equal(postgresRevokePrivilegesSql({ user, scope: "role", database: "", privileges: [], role: "readonly" }), 'REVOKE "readonly" FROM "reporter";');
});

test("parses PostgreSQL role rows", () => {
  assert.deepEqual(
    usersFromPostgresRolesResult(
      result(
        ["user", "host", "plugin"],
        [
          ["postgres", "LOGIN", "SUPERUSER, CREATEDB"],
          ["readonly", "ROLE", ""],
        ],
      ),
    ),
    [
      { user: "postgres", host: "LOGIN", plugin: "SUPERUSER, CREATEDB" },
      { user: "readonly", host: "ROLE", plugin: "" },
    ],
  );
});
