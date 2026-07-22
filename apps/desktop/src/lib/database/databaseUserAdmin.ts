import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export type UserAdminDialect = "mysql" | "postgres";
export type PrivilegeScope = "mysql" | "database" | "schema" | "table" | "role";

export interface DatabaseUserIdentity {
  user: string;
  host: string;
  plugin?: string;
}

export interface CreatePrincipalInput extends DatabaseUserIdentity {
  password: string;
  canLogin?: boolean;
}

export interface PrivilegeChangeInput {
  user: DatabaseUserIdentity;
  privileges: string[];
  database: string;
  table?: string;
  grantOption?: boolean;
  scope?: PrivilegeScope;
  role?: string;
}

export interface PrivilegeSelectionInput {
  grants: readonly string[];
  database: string;
  table?: string;
  availablePrivileges: readonly string[];
}

export interface PrivilegeSelection {
  privileges: string[];
  grantOption: boolean;
}

export interface DatabaseUserAdminProvider {
  dialect: UserAdminDialect;
  defaultScope: PrivilegeScope;
  listUsersSql(): string;
  fallbackListUsersSql?: () => string;
  parseUsers(result: QueryResult): DatabaseUserIdentity[];
  parseFallbackUsers?: (result: QueryResult) => DatabaseUserIdentity[];
  showGrantsSql(user: DatabaseUserIdentity): string;
  parseGrants?(result: QueryResult): string[];
  createUserSql?(input: CreatePrincipalInput): string;
  alterPasswordSql?(user: DatabaseUserIdentity, password: string): string;
  alterLoginSql?(user: DatabaseUserIdentity, enabled: boolean): string;
  dropUserSql?(user: DatabaseUserIdentity): string;
  grantPrivilegesSql?(input: PrivilegeChangeInput): string;
  revokePrivilegesSql?(input: PrivilegeChangeInput): string;
  label(user: DatabaseUserIdentity): string;
  detail(user: DatabaseUserIdentity): string | undefined;
  privilegesForScope?(scope: PrivilegeScope): readonly string[];
  defaultPrivilegesForScope?(scope: PrivilegeScope): string[];
  privilegeSelectionFromGrants?(input: PrivilegeSelectionInput): PrivilegeSelection;
}

export const MYSQL_USER_ADMIN_TYPES = new Set<DatabaseType>(["mysql", "goldendb"]);
export const KINGBASE_USER_ADMIN_TYPES = new Set<DatabaseType>(["kingbase"]);
export const POSTGRES_USER_ADMIN_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "highgo", "kwdb", "opengauss", "questdb", "vastbase"]);

export const MYSQL_COMMON_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "EXECUTE", "SHOW VIEW", "CREATE VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "TRIGGER", "EVENT", "CREATE TEMPORARY TABLES", "LOCK TABLES"] as const;
export const DORIS_TABLE_PRIVILEGES = ["SELECT_PRIV", "LOAD_PRIV", "ALTER_PRIV", "CREATE_PRIV", "DROP_PRIV", "SHOW_VIEW_PRIV"] as const;
export const STARROCKS_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "EXPORT", "ALL"] as const;

export const POSTGRES_DATABASE_PRIVILEGES = ["CONNECT", "CREATE", "TEMPORARY"] as const;
export const POSTGRES_SCHEMA_PRIVILEGES = ["USAGE", "CREATE"] as const;
export const POSTGRES_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteMySqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function quoteMySqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function mysqlUserAccount(user: DatabaseUserIdentity): string {
  return `${quoteMySqlString(user.user)}@${quoteMySqlString(user.host)}`;
}

export function mysqlUserLabel(user: DatabaseUserIdentity): string {
  return `${user.user}@${user.host}`;
}

export function postgresRoleLabel(user: DatabaseUserIdentity): string {
  return user.user;
}

export function mysqlListUsersSql(): string {
  return "SELECT User AS user, Host AS host, plugin AS plugin FROM mysql.user ORDER BY User, Host;";
}

export function mysqlListUsersFallbackSql(): string {
  return "SELECT DISTINCT GRANTEE AS grantee FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE;";
}

export function starrocksListUsersSql(): string {
  return "SHOW USERS;";
}

export function dorisListUsersSql(): string {
  return "SHOW ALL GRANTS;";
}

export function dorisUsersResult(result: QueryResult): DatabaseUserIdentity[] {
  const userIndex = columnIndex(result, "UserIdentity");
  if (userIndex < 0) return [];
  return result.rows.flatMap((row) => {
    const parsed = parseMySqlGrantee(String(row[userIndex] ?? ""));
    return parsed ? [parsed] : [];
  });
}

export function dorisGrantsResult(result: QueryResult): string[] {
  const ignoredColumns = new Set(["useridentity", "comment", "password"]);
  return result.rows.flatMap((row) =>
    result.columns.flatMap((column, index) => {
      if (ignoredColumns.has(column.toLowerCase())) return [];
      const value = String(row[index] ?? "").trim();
      return value && value.toUpperCase() !== "NULL" ? [`${column}: ${value}`] : [];
    }),
  );
}

export function starrocksUsersResult(result: QueryResult): DatabaseUserIdentity[] {
  const userIndex = columnIndex(result, "user", "User");
  if (userIndex < 0) return [];
  return result.rows.flatMap((row) => {
    const parsed = parseMySqlGrantee(String(row[userIndex] ?? ""));
    return parsed ? [parsed] : [];
  });
}

export function starrocksGrantsResult(result: QueryResult): string[] {
  const grantsIndex = columnIndex(result, "grants", "Grants");
  if (grantsIndex < 0) return result.rows.map((row) => String(row[0] ?? "")).filter(Boolean);
  return result.rows.map((row) => String(row[grantsIndex] ?? "")).filter(Boolean);
}

export function mysqlShowGrantsSql(user: DatabaseUserIdentity): string {
  return `SHOW GRANTS FOR ${mysqlUserAccount(user)};`;
}

export function mysqlCreateUserSql(input: CreatePrincipalInput): string {
  return `CREATE USER ${mysqlUserAccount(input)} IDENTIFIED BY ${quoteMySqlString(input.password)};`;
}

export function mysqlAlterUserPasswordSql(user: DatabaseUserIdentity, password: string): string {
  return `ALTER USER ${mysqlUserAccount(user)} IDENTIFIED BY ${quoteMySqlString(password)};`;
}

export function dorisAlterUserPasswordSql(user: DatabaseUserIdentity, password: string): string {
  return `SET PASSWORD FOR ${mysqlUserAccount(user)} = PASSWORD(${quoteMySqlString(password)});`;
}

export function mysqlAlterUserAccountLockSql(user: DatabaseUserIdentity, locked: boolean): string {
  return `ALTER USER ${mysqlUserAccount(user)} ACCOUNT ${locked ? "LOCK" : "UNLOCK"};`;
}

export function mysqlDropUserSql(user: DatabaseUserIdentity): string {
  return `DROP USER ${mysqlUserAccount(user)};`;
}

export function mysqlPrivilegeTargetSql(database: string, table = "*"): string {
  const db = database.trim() || "*";
  const tbl = table.trim() || "*";
  const dbSql = db === "*" ? "*" : quoteMySqlIdentifier(db);
  const tableSql = tbl === "*" ? "*" : quoteMySqlIdentifier(tbl);
  return `${dbSql}.${tableSql}`;
}

export function mysqlGrantPrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges).join(", ");
  const grantOption = input.grantOption ? " WITH GRANT OPTION" : "";
  return `GRANT ${privileges} ON ${mysqlPrivilegeTargetSql(input.database, input.table)} TO ${mysqlUserAccount(input.user)}${grantOption};`;
}

export function mysqlRevokePrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges).join(", ");
  return `REVOKE ${privileges} ON ${mysqlPrivilegeTargetSql(input.database, input.table)} FROM ${mysqlUserAccount(input.user)};`;
}

export function starrocksPrivilegeTargetSql(database: string, table = "*"): string {
  const db = database.trim();
  const tbl = table.trim();
  if (!tbl || tbl === "*") {
    return !db || db === "*" ? "ALL TABLES IN ALL DATABASES" : `ALL TABLES IN DATABASE ${quoteMySqlIdentifier(db)}`;
  }
  const tableName = quoteMySqlIdentifier(tbl);
  return !db || db === "*" ? `TABLE ${tableName}` : `TABLE ${quoteMySqlIdentifier(db)}.${tableName}`;
}

export function starrocksGrantPrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges).join(", ");
  const grantOption = input.grantOption ? " WITH GRANT OPTION" : "";
  return `GRANT ${privileges} ON ${starrocksPrivilegeTargetSql(input.database, input.table)} TO USER ${mysqlUserAccount(input.user)}${grantOption};`;
}

export function starrocksRevokePrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges).join(", ");
  return `REVOKE ${privileges} ON ${starrocksPrivilegeTargetSql(input.database, input.table)} FROM USER ${mysqlUserAccount(input.user)};`;
}

export function dorisPrivilegeTargetSql(database: string, table = "*"): string {
  const db = database.trim() || "*";
  const tbl = table.trim() || "*";
  if (db === "*") return "*.*.*";
  const tableSql = tbl === "*" ? "*" : quoteMySqlIdentifier(tbl);
  return `${quoteMySqlIdentifier("internal")}.${quoteMySqlIdentifier(db)}.${tableSql}`;
}

export function dorisGrantPrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges, "SELECT_PRIV").join(", ");
  // Doris 2.x GRANT has no WITH GRANT OPTION clause; GRANT_PRIV is managed as an explicit privilege instead.
  return `GRANT ${privileges} ON ${dorisPrivilegeTargetSql(input.database, input.table)} TO ${mysqlUserAccount(input.user)};`;
}

export function dorisRevokePrivilegesSql(input: PrivilegeChangeInput): string {
  const privileges = normalizePrivileges(input.privileges, "SELECT_PRIV").join(", ");
  return `REVOKE ${privileges} ON ${dorisPrivilegeTargetSql(input.database, input.table)} FROM ${mysqlUserAccount(input.user)};`;
}

export function normalizePrivileges(privileges: string[], fallback = "SELECT"): string[] {
  const normalized = privileges.map((privilege) => privilege.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set(normalized.length > 0 ? normalized : [fallback]));
}

export const normalizeMySqlPrivileges = normalizePrivileges;

export function mysqlPrivilegeSelectionFromGrants(input: PrivilegeSelectionInput): PrivilegeSelection {
  const database = normalizeMySqlScopeIdentifier(input.database || "*");
  const table = normalizeMySqlScopeIdentifier(input.table || "*");
  const availableByName = new Map(input.availablePrivileges.map((privilege) => [normalizePrivilegeName(privilege), privilege]));
  const selected = new Set<string>();
  let grantOption = false;

  for (const grantSql of input.grants) {
    const grant = parseMySqlGrant(grantSql);
    if (!grant || grant.objectType === "FUNCTION" || grant.objectType === "PROCEDURE") continue;
    if (normalizeMySqlScopeIdentifier(grant.database) !== database || normalizeMySqlScopeIdentifier(grant.table) !== table) continue;

    grantOption ||= grant.grantOption;
    if (grant.allPrivileges) {
      input.availablePrivileges.forEach((privilege) => selected.add(privilege));
      continue;
    }
    grant.privileges.forEach((privilege) => {
      const available = availableByName.get(normalizePrivilegeName(privilege));
      if (available) selected.add(available);
    });
  }

  return {
    privileges: input.availablePrivileges.filter((privilege) => selected.has(privilege)),
    grantOption,
  };
}

export function usersFromMySqlUserResult(result: QueryResult): DatabaseUserIdentity[] {
  const userIndex = columnIndex(result, "user", "User");
  const hostIndex = columnIndex(result, "host", "Host");
  const pluginIndex = columnIndex(result, "plugin", "Plugin");
  if (userIndex < 0 || hostIndex < 0) return [];
  return result.rows
    .map((row) => ({
      user: String(row[userIndex] ?? ""),
      host: String(row[hostIndex] ?? ""),
      plugin: pluginIndex >= 0 && row[pluginIndex] != null ? String(row[pluginIndex]) : undefined,
    }))
    .filter((user) => user.user || user.host);
}

export function usersFromMySqlGranteeResult(result: QueryResult): DatabaseUserIdentity[] {
  const granteeIndex = columnIndex(result, "grantee", "GRANTEE");
  if (granteeIndex < 0) return [];
  return result.rows.flatMap((row) => {
    const parsed = parseMySqlGrantee(String(row[granteeIndex] ?? ""));
    return parsed ? [parsed] : [];
  });
}

export function postgresListRolesSql(): string {
  const bypassRls = postgresRoleBypassRlsSql("r");
  return `
SELECT
  r.rolname AS user,
  CASE WHEN r.rolcanlogin THEN 'LOGIN' ELSE 'ROLE' END AS host,
  concat_ws(', ',
    CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
    CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN r.rolreplication THEN 'REPLICATION' END,
    CASE WHEN ${bypassRls} THEN 'BYPASSRLS' END
  ) AS plugin
FROM pg_catalog.pg_roles r
ORDER BY r.rolname;`.trim();
}

export function usersFromPostgresRolesResult(result: QueryResult): DatabaseUserIdentity[] {
  return usersFromMySqlUserResult(result);
}

export function postgresShowGrantsSql(user: DatabaseUserIdentity): string {
  const role = quoteSqlString(user.user);
  const bypassRls = postgresRoleBypassRlsSql("r");
  return `
WITH target AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, ${bypassRls} AS rolbypassrls
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = ${role}
)
SELECT line
FROM (
  SELECT 1 AS sort, 'Role: ' || quote_ident(rolname) AS line
  FROM target
  UNION ALL
  SELECT 2, 'Attributes: ' || COALESCE(NULLIF(concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END
  ), ''), 'none')
  FROM target
  UNION ALL
  SELECT 10, 'Member of: ' || quote_ident(parent.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM pg_catalog.pg_auth_members m
  JOIN target t ON t.oid = m.member
  JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
  UNION ALL
  SELECT 20, 'Has member: ' || quote_ident(member.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM pg_catalog.pg_auth_members m
  JOIN target t ON t.oid = m.roleid
  JOIN pg_catalog.pg_roles member ON member.oid = m.member
  UNION ALL
  SELECT 30, 'Database: ' || quote_ident(d.datname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CONNECT') THEN 'CONNECT' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CREATE') THEN 'CREATE' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'TEMPORARY') THEN 'TEMPORARY' END
    )
  FROM target t
  CROSS JOIN pg_catalog.pg_database d
  WHERE has_database_privilege(t.rolname, d.oid, 'CONNECT')
     OR has_database_privilege(t.rolname, d.oid, 'CREATE')
     OR has_database_privilege(t.rolname, d.oid, 'TEMPORARY')
  UNION ALL
  SELECT 40, 'Schema: ' || quote_ident(n.nspname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'USAGE') THEN 'USAGE' END,
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'CREATE') THEN 'CREATE' END
    )
  FROM target t
  CROSS JOIN pg_catalog.pg_namespace n
  WHERE n.nspname NOT LIKE 'pg~_%' ESCAPE '~'
    AND n.nspname <> 'information_schema'
    AND (has_schema_privilege(t.rolname, n.oid, 'USAGE') OR has_schema_privilege(t.rolname, n.oid, 'CREATE'))
  UNION ALL
  SELECT 50, 'Table: ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' = ' ||
    string_agg(privilege_type || CASE WHEN is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END, ', ' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee = ${role}
  GROUP BY table_schema, table_name
) grants
ORDER BY sort, line;`.trim();
}

export function kingbaseListRolesSql(): string {
  return `
SELECT
  r.rolname AS user,
  CASE WHEN r.rolcanlogin THEN 'LOGIN' ELSE 'ROLE' END AS host,
  concat_ws(', ',
    CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
    CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN r.rolreplication THEN 'REPLICATION' END,
    CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END
  ) AS plugin
FROM sys_catalog.sys_roles r
ORDER BY r.rolname;`.trim();
}

export function kingbaseShowGrantsSql(user: DatabaseUserIdentity): string {
  const role = quoteSqlString(user.user);
  return `
WITH target AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
  FROM sys_catalog.sys_roles r
  WHERE r.rolname = ${role}
)
SELECT line
FROM (
  SELECT 1 AS sort, 'Role: ' || quote_ident(rolname) AS line
  FROM target
  UNION ALL
  SELECT 2, 'Attributes: ' || COALESCE(NULLIF(concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END
  ), ''), 'none')
  FROM target
  UNION ALL
  SELECT 10, 'Member of: ' || quote_ident(parent.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM sys_catalog.sys_auth_members m
  JOIN target t ON t.oid = m.member
  JOIN sys_catalog.sys_roles parent ON parent.oid = m.roleid
  UNION ALL
  SELECT 20, 'Has member: ' || quote_ident(member.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM sys_catalog.sys_auth_members m
  JOIN target t ON t.oid = m.roleid
  JOIN sys_catalog.sys_roles member ON member.oid = m.member
  UNION ALL
  SELECT 30, 'Database: ' || quote_ident(d.datname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CONNECT') THEN 'CONNECT' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CREATE') THEN 'CREATE' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'TEMPORARY') THEN 'TEMPORARY' END
    )
  FROM target t
  CROSS JOIN sys_catalog.sys_database d
  WHERE has_database_privilege(t.rolname, d.oid, 'CONNECT')
     OR has_database_privilege(t.rolname, d.oid, 'CREATE')
     OR has_database_privilege(t.rolname, d.oid, 'TEMPORARY')
  UNION ALL
  SELECT 40, 'Schema: ' || quote_ident(n.nspname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'USAGE') THEN 'USAGE' END,
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'CREATE') THEN 'CREATE' END
    )
  FROM target t
  CROSS JOIN sys_catalog.sys_namespace n
  WHERE UPPER(n.nspname) <> 'INFORMATION_SCHEMA'
    AND UPPER(n.nspname) NOT LIKE 'SYS%'
    AND UPPER(n.nspname) NOT LIKE 'XLOG%'
    AND (has_schema_privilege(t.rolname, n.oid, 'USAGE') OR has_schema_privilege(t.rolname, n.oid, 'CREATE'))
  UNION ALL
  SELECT 50, 'Table: ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' = ' ||
    string_agg(privilege_type || CASE WHEN is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END, ', ' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee = ${role}
    AND UPPER(table_schema) <> 'INFORMATION_SCHEMA'
    AND UPPER(table_schema) NOT LIKE 'SYS%'
    AND UPPER(table_schema) NOT LIKE 'XLOG%'
  GROUP BY table_schema, table_name
) grants
ORDER BY sort, line;`.trim();
}

export function postgresCreateRoleSql(input: CreatePrincipalInput): string {
  const login = input.canLogin === false ? "NOLOGIN" : "LOGIN";
  return `CREATE ROLE ${quotePostgresIdentifier(input.user)} ${login} PASSWORD ${quoteSqlString(input.password)};`;
}

export function postgresAlterRolePasswordSql(user: DatabaseUserIdentity, password: string): string {
  return `ALTER ROLE ${quotePostgresIdentifier(user.user)} PASSWORD ${quoteSqlString(password)};`;
}

export function postgresAlterRoleLoginSql(user: DatabaseUserIdentity, enabled: boolean): string {
  return `ALTER ROLE ${quotePostgresIdentifier(user.user)} ${enabled ? "LOGIN" : "NOLOGIN"};`;
}

export function postgresDropRoleSql(user: DatabaseUserIdentity): string {
  return `DROP ROLE ${quotePostgresIdentifier(user.user)};`;
}

export function postgresPrivilegeTargetSql(input: Pick<PrivilegeChangeInput, "scope" | "database" | "table">): string {
  const scope = input.scope || "database";
  const name = input.database.trim();
  if (scope === "database") return `DATABASE ${quotePostgresIdentifier(name || "postgres")}`;
  if (scope === "schema") return `SCHEMA ${quotePostgresIdentifier(name || "public")}`;
  const schema = name || "public";
  const table = input.table?.trim() || "*";
  if (table === "*") return `ALL TABLES IN SCHEMA ${quotePostgresIdentifier(schema)}`;
  return `TABLE ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

export function postgresGrantPrivilegesSql(input: PrivilegeChangeInput): string {
  if (input.scope === "role") {
    return `GRANT ${quotePostgresIdentifier(input.role?.trim() || "")} TO ${quotePostgresIdentifier(input.user.user)}${input.grantOption ? " WITH ADMIN OPTION" : ""};`;
  }
  const privileges = normalizePrivileges(input.privileges, postgresDefaultPrivilege(input.scope)).join(", ");
  return `GRANT ${privileges} ON ${postgresPrivilegeTargetSql(input)} TO ${quotePostgresIdentifier(input.user.user)}${input.grantOption ? " WITH GRANT OPTION" : ""};`;
}

export function postgresRevokePrivilegesSql(input: PrivilegeChangeInput): string {
  if (input.scope === "role") {
    return `REVOKE ${quotePostgresIdentifier(input.role?.trim() || "")} FROM ${quotePostgresIdentifier(input.user.user)};`;
  }
  const privileges = normalizePrivileges(input.privileges, postgresDefaultPrivilege(input.scope)).join(", ");
  return `REVOKE ${privileges} ON ${postgresPrivilegeTargetSql(input)} FROM ${quotePostgresIdentifier(input.user.user)};`;
}

export function grantsFromQueryResult(result: QueryResult): string[] {
  return result.rows.map((row) => String(row[0] ?? "")).filter(Boolean);
}

function columnIndex(result: QueryResult, ...names: string[]): number {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return result.columns.findIndex((column) => wanted.has(column.toLowerCase()));
}

function parseMySqlGrantee(value: string): DatabaseUserIdentity | null {
  const match = /^'((?:''|[^'])*)'@'((?:''|[^'])*)'$/.exec(value.trim());
  if (!match) return null;
  return {
    user: match[1].replace(/''/g, "'"),
    host: match[2].replace(/''/g, "'"),
  };
}

interface ParsedMySqlGrant {
  privileges: string[];
  database: string;
  table: string;
  objectType?: "TABLE" | "FUNCTION" | "PROCEDURE";
  allPrivileges: boolean;
  grantOption: boolean;
}

function parseMySqlGrant(sql: string): ParsedMySqlGrant | null {
  const identifier = String.raw`(?:\x60(?:\x60\x60|[^\x60])*\x60|\*|[^\s.]+)`;
  const match = new RegExp(String.raw`^\s*GRANT\s+(.+?)\s+ON\s+(?:(TABLE|FUNCTION|PROCEDURE)\s+)?(${identifier})\s*\.\s*(${identifier})\s+TO\s+`, "i").exec(sql);
  if (!match) return null;

  const privileges = match[1].split(",").map(normalizePrivilegeName).filter(Boolean);
  return {
    privileges,
    database: unquoteMySqlIdentifier(match[3]),
    table: unquoteMySqlIdentifier(match[4]),
    objectType: match[2]?.toUpperCase() as ParsedMySqlGrant["objectType"],
    allPrivileges: privileges.some((privilege) => privilege === "ALL" || privilege === "ALL PRIVILEGES"),
    grantOption: /\s+WITH\s+GRANT\s+OPTION\s*;?\s*$/i.test(sql),
  };
}

function normalizePrivilegeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeMySqlScopeIdentifier(value: string): string {
  return unquoteMySqlIdentifier(value.trim()).toLocaleLowerCase("en-US");
}

function unquoteMySqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).replace(/``/g, "`");
  }
  return trimmed;
}

function postgresDefaultPrivilege(scope: PrivilegeScope | undefined): string {
  if (scope === "schema") return "USAGE";
  if (scope === "database") return "CONNECT";
  return "SELECT";
}

function postgresPrivilegesForScope(scope: PrivilegeScope): readonly string[] {
  if (scope === "database") return POSTGRES_DATABASE_PRIVILEGES;
  if (scope === "schema") return POSTGRES_SCHEMA_PRIVILEGES;
  if (scope === "table") return POSTGRES_TABLE_PRIVILEGES;
  return [];
}

function postgresRoleBypassRlsSql(alias: string): string {
  return `row_to_json(${alias})::text LIKE '%"rolbypassrls":true%'`;
}

export const mysqlUserAdminProvider: DatabaseUserAdminProvider = {
  dialect: "mysql",
  defaultScope: "mysql",
  listUsersSql: mysqlListUsersSql,
  fallbackListUsersSql: mysqlListUsersFallbackSql,
  parseUsers: usersFromMySqlUserResult,
  parseFallbackUsers: usersFromMySqlGranteeResult,
  showGrantsSql: mysqlShowGrantsSql,
  createUserSql: mysqlCreateUserSql,
  alterPasswordSql: mysqlAlterUserPasswordSql,
  alterLoginSql: (user, enabled) => mysqlAlterUserAccountLockSql(user, !enabled),
  dropUserSql: mysqlDropUserSql,
  grantPrivilegesSql: mysqlGrantPrivilegesSql,
  revokePrivilegesSql: mysqlRevokePrivilegesSql,
  label: mysqlUserLabel,
  detail: (user) => user.plugin,
  privilegesForScope: () => MYSQL_COMMON_PRIVILEGES,
  defaultPrivilegesForScope: () => ["SELECT"],
  privilegeSelectionFromGrants: mysqlPrivilegeSelectionFromGrants,
};

export const postgresUserAdminProvider: DatabaseUserAdminProvider = {
  dialect: "postgres",
  defaultScope: "database",
  listUsersSql: postgresListRolesSql,
  parseUsers: usersFromPostgresRolesResult,
  showGrantsSql: postgresShowGrantsSql,
  createUserSql: postgresCreateRoleSql,
  alterPasswordSql: postgresAlterRolePasswordSql,
  alterLoginSql: postgresAlterRoleLoginSql,
  dropUserSql: postgresDropRoleSql,
  grantPrivilegesSql: postgresGrantPrivilegesSql,
  revokePrivilegesSql: postgresRevokePrivilegesSql,
  label: postgresRoleLabel,
  detail: (user) => [user.host, user.plugin].filter(Boolean).join(" · ") || undefined,
  privilegesForScope: postgresPrivilegesForScope,
  defaultPrivilegesForScope: (scope) => (scope === "role" ? [] : [postgresDefaultPrivilege(scope)]),
};

export const kingbaseUserAdminProvider: DatabaseUserAdminProvider = {
  ...postgresUserAdminProvider,
  listUsersSql: kingbaseListRolesSql,
  showGrantsSql: kingbaseShowGrantsSql,
};

export const dorisUserAdminProvider: DatabaseUserAdminProvider = {
  dialect: "mysql",
  defaultScope: "table",
  listUsersSql: dorisListUsersSql,
  parseUsers: dorisUsersResult,
  showGrantsSql: mysqlShowGrantsSql,
  parseGrants: dorisGrantsResult,
  createUserSql: mysqlCreateUserSql,
  alterPasswordSql: dorisAlterUserPasswordSql,
  dropUserSql: mysqlDropUserSql,
  grantPrivilegesSql: dorisGrantPrivilegesSql,
  revokePrivilegesSql: dorisRevokePrivilegesSql,
  label: mysqlUserLabel,
  detail: (user) => user.plugin,
  privilegesForScope: () => DORIS_TABLE_PRIVILEGES,
  defaultPrivilegesForScope: () => ["SELECT_PRIV"],
};

export const starrocksUserAdminProvider: DatabaseUserAdminProvider = {
  dialect: "mysql",
  defaultScope: "table",
  listUsersSql: starrocksListUsersSql,
  parseUsers: starrocksUsersResult,
  showGrantsSql: mysqlShowGrantsSql,
  parseGrants: starrocksGrantsResult,
  createUserSql: mysqlCreateUserSql,
  alterPasswordSql: mysqlAlterUserPasswordSql,
  dropUserSql: mysqlDropUserSql,
  grantPrivilegesSql: starrocksGrantPrivilegesSql,
  revokePrivilegesSql: starrocksRevokePrivilegesSql,
  label: mysqlUserLabel,
  detail: (user) => user.plugin,
  privilegesForScope: () => STARROCKS_TABLE_PRIVILEGES,
  defaultPrivilegesForScope: () => ["SELECT"],
};

const DATABASE_USER_ADMIN_PROVIDER_BY_TYPE = new Map<DatabaseType, DatabaseUserAdminProvider>([
  ["mysql", mysqlUserAdminProvider],
  ["goldendb", mysqlUserAdminProvider],
  ["doris", dorisUserAdminProvider],
  ["kingbase", kingbaseUserAdminProvider],
  ["postgres", postgresUserAdminProvider],
  ["gaussdb", postgresUserAdminProvider],
  ["highgo", postgresUserAdminProvider],
  ["kwdb", postgresUserAdminProvider],
  ["opengauss", postgresUserAdminProvider],
  ["questdb", postgresUserAdminProvider],
  ["vastbase", postgresUserAdminProvider],
  ["starrocks", starrocksUserAdminProvider],
]);

export function getDatabaseUserAdminProvider(dbType: DatabaseType | undefined): DatabaseUserAdminProvider | null {
  return dbType ? (DATABASE_USER_ADMIN_PROVIDER_BY_TYPE.get(dbType) ?? null) : null;
}

export function supportsDatabaseUserAdmin(dbType: DatabaseType | undefined): boolean {
  return !!dbType && supportsDatabaseFeature(dbType, "userAdmin") && DATABASE_USER_ADMIN_PROVIDER_BY_TYPE.has(dbType);
}

export function resolveDatabaseUserAdminProviderForConnection(connection: ConnectionConfig | undefined): DatabaseUserAdminProvider | null {
  const dbType = effectiveDatabaseTypeForConnection(connection);
  return supportsDatabaseUserAdmin(dbType) ? getDatabaseUserAdminProvider(dbType) : null;
}

export function connectionSupportsDatabaseUserAdmin(connection: ConnectionConfig | undefined): boolean {
  return resolveDatabaseUserAdminProviderForConnection(connection) !== null;
}
