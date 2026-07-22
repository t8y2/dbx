import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  connectionSupportsDatabaseUserAdmin,
  dorisAlterUserPasswordSql,
  dorisGrantPrivilegesSql,
  dorisGrantsResult,
  dorisListUsersSql,
  dorisPrivilegeTargetSql,
  dorisRevokePrivilegesSql,
  dorisUsersResult,
  grantsFromQueryResult,
  getDatabaseUserAdminProvider,
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
  postgresListRolesSql,
  postgresPrivilegeTargetSql,
  postgresRevokePrivilegesSql,
  postgresRoleLabel,
  postgresShowGrantsSql,
  quoteMySqlIdentifier,
  quoteMySqlString,
  quotePostgresIdentifier,
  resolveDatabaseUserAdminProviderForConnection,
  starrocksGrantPrivilegesSql,
  starrocksGrantsResult,
  starrocksListUsersSql,
  starrocksPrivilegeTargetSql,
  starrocksRevokePrivilegesSql,
  starrocksUsersResult,
  usersFromMySqlGranteeResult,
  usersFromMySqlUserResult,
  usersFromPostgresRolesResult,
} from "../../apps/desktop/src/lib/database/databaseUserAdmin.ts";
import type { ConnectionConfig, QueryResult } from "../../apps/desktop/src/types/database.ts";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns,
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

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

test("builds PostgreSQL role metadata SQL without directly requiring rolbypassrls", () => {
  const listSql = postgresListRolesSql();
  const grantsSql = postgresShowGrantsSql({ user: "reporter", host: "LOGIN" });

  assert.match(listSql, /row_to_json\(r\)::text LIKE '%"rolbypassrls":true%'/);
  assert.match(grantsSql, /row_to_json\(r\)::text LIKE '%"rolbypassrls":true%'/);
  assert.doesNotMatch(listSql, /r\.rolbypassrls/);
  assert.doesNotMatch(grantsSql, /r\.rolbypassrls/);
  assert.match(grantsSql, /AS rolbypassrls/);
  assert.match(grantsSql, /n\.nspname NOT LIKE 'pg~_%' ESCAPE '~'/);
  assert.ok(!grantsSql.includes("ESCAPE '\\'"));
});

test("builds StarRocks user listing SQL", () => {
  assert.equal(starrocksListUsersSql(), "SHOW USERS;");
});

test("builds StarRocks table privilege SQL", () => {
  const input = {
    user: { user: "reporter", host: "%" },
    privileges: ["select", "EXPORT"],
    database: "analytics",
    table: "daily`rollup",
    grantOption: true,
  };

  assert.equal(starrocksPrivilegeTargetSql("*"), "ALL TABLES IN ALL DATABASES");
  assert.equal(starrocksPrivilegeTargetSql("analytics"), "ALL TABLES IN DATABASE `analytics`");
  assert.equal(starrocksPrivilegeTargetSql("analytics", "daily`rollup"), "TABLE `analytics`.`daily``rollup`");
  assert.equal(starrocksGrantPrivilegesSql(input), "GRANT SELECT, EXPORT ON TABLE `analytics`.`daily``rollup` TO USER 'reporter'@'%' WITH GRANT OPTION;");
  assert.equal(starrocksRevokePrivilegesSql(input), "REVOKE SELECT, EXPORT ON TABLE `analytics`.`daily``rollup` FROM USER 'reporter'@'%';");
});

test("parses StarRocks SHOW USERS result", () => {
  assert.deepEqual(starrocksUsersResult(result(["User"], [["'root'@'%'"], ["'grader_reader'@'%'"], ["'o''brien'@'localhost'"], ["malformed"]])), [
    { user: "root", host: "%" },
    { user: "grader_reader", host: "%" },
    { user: "o'brien", host: "localhost" },
  ]);
});

test("parses StarRocks SHOW GRANTS three-column result", () => {
  assert.deepEqual(
    starrocksGrantsResult(
      result(
        ["UserIdentity", "Catalog", "Grants"],
        [
          ["'root'@'%'", null, "GRANT 'root' TO 'root'@'%'"],
          ["'grader_reader'@'%'", "default_catalog", "GRANT SELECT ON ALL TABLES IN DATABASE grader_events TO USER 'grader_reader'@'%'"],
          ["'reader'@'%'", "paimon", null],
        ],
      ),
    ),
    ["GRANT 'root' TO 'root'@'%'", "GRANT SELECT ON ALL TABLES IN DATABASE grader_events TO USER 'grader_reader'@'%'"],
  );
});

test("StarRocks grants parser falls back to first column when Grants column is absent", () => {
  assert.deepEqual(starrocksGrantsResult(result(["Grants for app@%"], [["GRANT SELECT ON `app`.* TO 'app'@'%'"]])), ["GRANT SELECT ON `app`.* TO 'app'@'%'"]);
});

test("routes StarRocks to the StarRocks user admin provider", () => {
  const provider = getDatabaseUserAdminProvider("starrocks");
  assert.ok(provider, "expected a provider for starrocks");
  assert.equal(provider?.dialect, "mysql");
  assert.equal(provider?.listUsersSql(), "SHOW USERS;");
  assert.equal(provider?.showGrantsSql({ user: "root", host: "%" }), "SHOW GRANTS FOR 'root'@'%';");
  assert.equal(provider?.createUserSql?.({ user: "app", host: "%", password: "secret" }), "CREATE USER 'app'@'%' IDENTIFIED BY 'secret';");
  assert.equal(provider?.dropUserSql?.({ user: "app", host: "%" }), "DROP USER 'app'@'%';");
  assert.equal(
    provider?.grantPrivilegesSql?.({
      user: { user: "reporter", host: "%" },
      privileges: ["SELECT"],
      database: "analytics",
    }),
    "GRANT SELECT ON ALL TABLES IN DATABASE `analytics` TO USER 'reporter'@'%';",
  );
  assert.equal(provider?.alterLoginSql, undefined);
  assert.deepEqual(provider?.privilegesForScope?.("table"), ["SELECT", "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "EXPORT", "ALL"]);
});

test("routes Doris to a Doris 2.x user admin provider", () => {
  const provider = getDatabaseUserAdminProvider("doris");
  assert.ok(provider, "expected a provider for doris");
  assert.equal(provider?.dialect, "mysql");
  assert.equal(provider?.listUsersSql(), "SHOW ALL GRANTS;");
  assert.equal(provider?.showGrantsSql({ user: "root", host: "%" }), "SHOW GRANTS FOR 'root'@'%';");
  assert.equal(provider?.createUserSql?.({ user: "app", host: "%", password: "secret" }), "CREATE USER 'app'@'%' IDENTIFIED BY 'secret';");
  assert.equal(dorisAlterUserPasswordSql({ user: "app", host: "%" }, "new'secret"), "SET PASSWORD FOR 'app'@'%' = PASSWORD('new''secret');");
  assert.equal(provider?.dropUserSql?.({ user: "app", host: "%" }), "DROP USER 'app'@'%';");
  assert.equal(dorisPrivilegeTargetSql("*"), "*.*.*");
  assert.equal(dorisPrivilegeTargetSql("analytics"), "`internal`.`analytics`.*");
  assert.equal(dorisPrivilegeTargetSql("analytics", "daily`rollup"), "`internal`.`analytics`.`daily``rollup`");
  const privilegeInput = {
    user: { user: "reporter", host: "%" },
    privileges: ["select_priv", "LOAD_PRIV"],
    database: "analytics",
    grantOption: true,
  };
  assert.equal(dorisGrantPrivilegesSql(privilegeInput), "GRANT SELECT_PRIV, LOAD_PRIV ON `internal`.`analytics`.* TO 'reporter'@'%';");
  assert.equal(dorisRevokePrivilegesSql(privilegeInput), "REVOKE SELECT_PRIV, LOAD_PRIV ON `internal`.`analytics`.* FROM 'reporter'@'%';");
  assert.equal(provider?.alterLoginSql, undefined);
  assert.deepEqual(provider?.privilegesForScope?.("table"), ["SELECT_PRIV", "LOAD_PRIV", "ALTER_PRIV", "CREATE_PRIV", "DROP_PRIV", "SHOW_VIEW_PRIV"]);
});

test("parses Doris SHOW ALL GRANTS results", () => {
  const grants = result(
    ["UserIdentity", "Comment", "Password", "Roles", "GlobalPrivs", "CatalogPrivs", "DatabasePrivs", "TablePrivs"],
    [
      ["'root'@'%'", "ROOT", "No", "operator", "Admin_priv", null, "internal.mysql: Select_priv", null],
      ["'o''brien'@'localhost'", "", "Yes", "", null, "internal: Select_priv", null, "internal.analytics.orders: Select_priv"],
    ],
  );

  assert.equal(dorisListUsersSql(), "SHOW ALL GRANTS;");
  assert.deepEqual(dorisUsersResult(grants), [
    { user: "root", host: "%" },
    { user: "o'brien", host: "localhost" },
  ]);
  assert.deepEqual(dorisGrantsResult(grants), ["Roles: operator", "GlobalPrivs: Admin_priv", "DatabasePrivs: internal.mysql: Select_priv", "CatalogPrivs: internal: Select_priv", "TablePrivs: internal.analytics.orders: Select_priv"]);
});

test("resolves user admin support from the effective connection type", () => {
  const mysqlProtocolStarRocks = {
    id: "starrocks-1",
    db_type: "mysql",
    driver_profile: "starrocks",
  } as ConnectionConfig;
  const jdbcStarRocks = {
    id: "starrocks-jdbc-1",
    db_type: "jdbc",
    connection_string: "jdbc:mysql://localhost:9030/analytics",
    driver_profile: "starrocks",
  } as ConnectionConfig;
  const mysqlProtocolDoris = {
    id: "doris-1",
    db_type: "mysql",
    driver_profile: "doris",
  } as ConnectionConfig;
  const jdbcDoris = {
    id: "doris-jdbc-1",
    db_type: "jdbc",
    connection_string: "jdbc:mysql://localhost:9030/analytics",
    driver_profile: "doris",
  } as ConnectionConfig;
  const mysql = { id: "mysql-1", db_type: "mysql" } as ConnectionConfig;
  const goldenDb = { id: "goldendb-1", db_type: "goldendb" } as ConnectionConfig;

  assert.equal(resolveDatabaseUserAdminProviderForConnection(mysqlProtocolStarRocks), getDatabaseUserAdminProvider("starrocks"));
  assert.equal(resolveDatabaseUserAdminProviderForConnection(jdbcStarRocks), getDatabaseUserAdminProvider("starrocks"));
  assert.equal(resolveDatabaseUserAdminProviderForConnection(mysqlProtocolDoris), getDatabaseUserAdminProvider("doris"));
  assert.equal(resolveDatabaseUserAdminProviderForConnection(jdbcDoris), getDatabaseUserAdminProvider("doris"));
  assert.equal(resolveDatabaseUserAdminProviderForConnection(mysql), getDatabaseUserAdminProvider("mysql"));
  assert.equal(resolveDatabaseUserAdminProviderForConnection(goldenDb), getDatabaseUserAdminProvider("goldendb"));
  assert.equal(connectionSupportsDatabaseUserAdmin(mysqlProtocolStarRocks), true);
  assert.equal(connectionSupportsDatabaseUserAdmin(mysqlProtocolDoris), true);
  assert.equal(connectionSupportsDatabaseUserAdmin({ id: "sqlite-1", db_type: "sqlite" } as ConnectionConfig), false);
});
