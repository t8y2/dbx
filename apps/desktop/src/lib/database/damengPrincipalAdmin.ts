import type { QueryResult } from "@/types/database";

/**
 * Dameng (达梦 DM8) user & role administration SQL layer.
 *
 * Follows the same architecture as `damengJobAdmin.ts` / `databaseUserAdmin.ts`:
 * SQL is generated on the frontend and executed through the generic query
 * channel (`api.executeQuery` / `executeWithProductionSqlGuard`).
 *
 * Metadata views are Oracle-style: DBA_USERS, DBA_ROLES, DBA_ROLE_PRIVS,
 * DBA_SYS_PRIVS and DBA_TABLESPACES. Identifiers (users, roles, tablespaces)
 * are double-quoted; string literals (passwords) are single-quoted and escaped.
 */

export interface DamengUser {
  username: string;
  accountStatus: string;
  locked: boolean;
  defaultTablespace: string;
  temporaryTablespace: string;
  profile: string;
  created: string;
  raw: Record<string, unknown>;
}

export interface DamengRole {
  role: string;
  passwordRequired: string;
  raw: Record<string, unknown>;
}

export interface DamengGrant {
  grantee: string;
  grantedRole: string;
  adminOption: boolean;
  defaultRole: boolean;
  /** True when the role is only reachable through role nesting (not granted directly). */
  inherited?: boolean;
  /** The parent role through which an inherited role is reachable. */
  via?: string;
}

export interface DamengRoleEntry {
  role: string;
  direct: boolean;
  via?: string;
}

export interface DamengSysPrivilege {
  grantee: string;
  privilege: string;
  adminOption: boolean;
}

export interface DamengCreateUserInput {
  username: string;
  password: string;
  tablespace?: string;
  locked?: boolean;
}

/**
 * Built-in system accounts that must never be dropped, locked or altered from
 * the UI. Compared case-insensitively (see `isDamengSystemUser`).
 */
export const DAMENG_SYSTEM_USERS = ["SYSDBA", "SYSSSO", "SYSAUDITOR", "SYSDBO", "SYS"] as const;

/**
 * Identity category of each built-in system account, matching the DM
 * management tool terminology: SYSDBA = admin, SYSAUDITOR = audit,
 * SYSSSO = security. SYSDBO and SYS remain in the protected system group.
 */
export const DAMENG_SYSTEM_USER_CATEGORIES: Record<string, string> = {
  SYSDBA: "admin",
  SYSAUDITOR: "auditor",
  SYSSSO: "security",
  SYSDBO: "system",
  SYS: "system",
};

/** Returns the category key ("admin" | "auditor" | "security" | "system") of a system user, or undefined for regular users. */
export function damengSystemUserCategory(username: string): string | undefined {
  const normalized = username.trim().toUpperCase();
  return DAMENG_SYSTEM_USER_CATEGORIES[normalized];
}

/** Sidebar list grouping: the four system-user categories plus regular users. */
export type DamengUserGroup = "admin" | "auditor" | "security" | "system" | "other";

export const DAMENG_USER_GROUPS: readonly DamengUserGroup[] = ["admin", "auditor", "security", "system", "other"];

/**
 * Groups a username: the four system accounts map to their category; a regular
 * user is grouped by the management roles they hold (DBA -> admin,
 * DB_AUDIT_ADMIN -> auditor, DB_POLICY_ADMIN -> security), everything else to
 * "other". Pass the user's directly granted roles (e.g. from DBA_ROLE_PRIVS).
 */
export function damengUserGroup(username: string, grantedRoles?: Iterable<string>): DamengUserGroup {
  const normalized = username.trim().toUpperCase();
  const system = DAMENG_SYSTEM_USER_CATEGORIES[normalized];
  if (system) return system as DamengUserGroup;
  if (grantedRoles) {
    const roles = new Set([...grantedRoles].map((role) => role.trim().toUpperCase()));
    if (roles.has("DBA")) return "admin";
    if (roles.has("DB_AUDIT_ADMIN")) return "auditor";
    if (roles.has("DB_POLICY_ADMIN")) return "security";
  }
  return "other";
}

/** Common Oracle-style system privileges supported by Dameng DM8. */
export const DAMENG_SYSTEM_PRIVILEGES = [
  "CREATE SESSION",
  "CREATE TABLE",
  "CREATE ANY TABLE",
  "ALTER ANY TABLE",
  "DROP ANY TABLE",
  "SELECT ANY TABLE",
  "INSERT ANY TABLE",
  "UPDATE ANY TABLE",
  "DELETE ANY TABLE",
  "CREATE VIEW",
  "CREATE ANY VIEW",
  "DROP ANY VIEW",
  "CREATE PROCEDURE",
  "CREATE ANY PROCEDURE",
  "ALTER ANY PROCEDURE",
  "DROP ANY PROCEDURE",
  "EXECUTE ANY PROCEDURE",
  "CREATE FUNCTION",
  "CREATE PACKAGE",
  "CREATE SEQUENCE",
  "CREATE ANY SEQUENCE",
  "ALTER ANY SEQUENCE",
  "DROP ANY SEQUENCE",
  "SELECT ANY SEQUENCE",
  "CREATE TRIGGER",
  "CREATE ANY TRIGGER",
  "ALTER ANY TRIGGER",
  "DROP ANY TRIGGER",
  "CREATE SYNONYM",
  "CREATE PUBLIC SYNONYM",
  "DROP PUBLIC SYNONYM",
  "CREATE ROLE",
  "DROP ROLE",
  "CREATE USER",
  "ALTER USER",
  "DROP USER",
  "ALTER ANY USER",
  "MANAGE ANY USER",
  "CREATE TABLESPACE",
  "ALTER TABLESPACE",
  "DROP TABLESPACE",
  "MANAGE TABLESPACE",
  "CREATE DATABASE LINK",
  "CREATE MATERIALIZED VIEW",
  "ALTER DATABASE",
  "ALTER SYSTEM",
  "GRANT ANY PRIVILEGE",
  "GRANT ANY ROLE",
  "UNLIMITED TABLESPACE",
  "SELECT ANY DICTIONARY",
  "EXECUTE ANY TYPE",
] as const;

export function isDamengSystemUser(username: string): boolean {
  const normalized = username.trim().toUpperCase();
  return DAMENG_SYSTEM_USERS.some((systemUser) => systemUser === normalized);
}

/** Direct role grants on regular users may be revoked, including predefined roles. */
export function canDamengRevokeRoleGrant(username: string | undefined, grant: Pick<DamengGrant, "grantedRole" | "inherited"> | undefined): boolean {
  return !!username && !!grant && !isDamengSystemUser(username) && !grant.inherited;
}

/**
 * Whether the given connection user may ALTER USER (change password) for the
 * target user, following the DM (达梦) security model:
 * - SYS is a built-in non-login user with no password: never changeable.
 * - SYSDBA / SYSSSO / SYSAUDITOR passwords can only be changed by themselves
 *   (a SYSDBA session cannot reset SYSSSO or SYSAUDITOR passwords).
 * - SYSDBA can change any regular (non-system) user's password.
 * - A regular user can only change their own password.
 */
export function canDamengAlterUserPassword(connectionUser: string | undefined, target: string | undefined): boolean {
  if (!target) return false;
  const conn = (connectionUser || "").trim().toUpperCase();
  const tgt = target.trim().toUpperCase();
  if (tgt === "SYS") return false;
  if (isDamengSystemUser(tgt)) return conn === tgt;
  return conn === "SYSDBA" || conn === tgt;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function damengListUsersSql(): string {
  return `SELECT USERNAME, ACCOUNT_STATUS, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, PROFILE, CREATED
FROM DBA_USERS
ORDER BY USERNAME`;
}

export function damengListRolesSql(): string {
  return `SELECT ROLE, PASSWORD_REQUIRED
FROM DBA_ROLES
ORDER BY ROLE`;
}

export function damengListTablespacesSql(): string {
  return `SELECT TABLESPACE_NAME
FROM DBA_TABLESPACES
  ORDER BY TABLESPACE_NAME`;
}

export function damengSystemPrivilegeMapSql(): string {
  return `SELECT NAME FROM SYSTEM_PRIVILEGE_MAP ORDER BY NAME`;
}

export function damengEnableDdlAnyPrivSql(): string {
  return `SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'ENABLE_DDL_ANY_PRIV'`;
}

export function damengListRoleMembersSql(role: string): string {
  return `SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE
FROM DBA_ROLE_PRIVS
WHERE GRANTED_ROLE = ${quoteDamengString(role)}
ORDER BY GRANTEE`;
}

export function damengListUserRolesSql(user: string): string {
  return `SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE
FROM DBA_ROLE_PRIVS
WHERE GRANTEE = ${quoteDamengString(user)}
ORDER BY GRANTED_ROLE`;
}

export function damengRoleGraphSql(): string {
  return `SELECT GRANTEE, GRANTED_ROLE FROM DBA_ROLE_PRIVS`;
}

export function damengListUserSysPrivsSql(user: string): string {
  return `SELECT GRANTEE, PRIVILEGE, ADMIN_OPTION
FROM DBA_SYS_PRIVS
WHERE GRANTEE = ${quoteDamengString(user)}
ORDER BY PRIVILEGE`;
}

export function damengListRoleSysPrivsSql(role: string): string {
  return `SELECT GRANTEE, PRIVILEGE, ADMIN_OPTION
FROM DBA_SYS_PRIVS
WHERE GRANTEE = ${quoteDamengString(role)}
ORDER BY PRIVILEGE`;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export function damengCreateUserSql(input: DamengCreateUserInput): string {
  const username = input.username.trim();
  const password = input.password;
  if (!username) throw new Error("Dameng username must not be empty");
  if (!password || !password.trim()) throw new Error("Dameng user password must not be empty");
  const parts: string[] = [`CREATE USER ${quoteDamengIdentifier(username)} IDENTIFIED BY ${quoteDamengPassword(password)}`];
  if (input.tablespace && input.tablespace.trim()) {
    parts.push(`DEFAULT TABLESPACE ${quoteDamengIdentifier(input.tablespace)}`);
  }
  if (input.locked) parts.push("ACCOUNT LOCK");
  return `${parts.join(" ")};`;
}

/**
 * Predefined DM role automatically granted when creating a user of each type,
 * matching the roles the built-in accounts hold: SYSDBA has DBA, SYSAUDITOR has
 * DB_AUDIT_ADMIN, SYSSSO has DB_POLICY_ADMIN. "system" (SYS) has no grantable
 * role — SYS is a built-in non-login user that cannot be replicated via GRANT.
 */
export const DAMENG_USER_TYPE_GRANTS: Record<string, readonly string[]> = {
  admin: ["DBA"],
  auditor: ["DB_AUDIT_ADMIN"],
  security: ["DB_POLICY_ADMIN"],
  system: [],
};

/** GRANT statements to append when creating a user with the given type. */
export function damengUserTypeGrantSqls(userType: string, username: string): string[] {
  const roles = DAMENG_USER_TYPE_GRANTS[userType] ?? [];
  return roles.map((role) => `GRANT ${quoteDamengIdentifier(role)} TO ${quoteDamengIdentifier(username)};`);
}

export function damengAlterUserPasswordSql(username: string, password: string): string {
  return `ALTER USER ${quoteDamengIdentifier(username)} IDENTIFIED BY ${quoteDamengPassword(password)};`;
}

export function damengLockUserSql(username: string): string {
  return `ALTER USER ${quoteDamengIdentifier(username)} ACCOUNT LOCK;`;
}

export function damengUnlockUserSql(username: string): string {
  return `ALTER USER ${quoteDamengIdentifier(username)} ACCOUNT UNLOCK;`;
}

export function damengDropUserSql(username: string): string {
  return `DROP USER ${quoteDamengIdentifier(username)} CASCADE;`;
}

export function damengCreateRoleSql(role: string): string {
  return `CREATE ROLE ${quoteDamengIdentifier(role)};`;
}

export function damengDropRoleSql(role: string): string {
  return `DROP ROLE ${quoteDamengIdentifier(role)};`;
}

// ---------------------------------------------------------------------------
// DCL
// ---------------------------------------------------------------------------

export function damengGrantRoleSql(grantee: string, role: string): string {
  return `GRANT ${quoteDamengIdentifier(role)} TO ${quoteDamengIdentifier(grantee)};`;
}

export function damengRevokeRoleSql(grantee: string, role: string): string {
  return `REVOKE ${quoteDamengIdentifier(role)} FROM ${quoteDamengIdentifier(grantee)};`;
}

export function damengGrantSystemPrivilegeSql(grantee: string, privilege: string, adminOption = false): string {
  const suffix = adminOption ? " WITH ADMIN OPTION" : "";
  return `GRANT ${privilege} TO ${quoteDamengIdentifier(grantee)}${suffix};`;
}

export function damengRevokeSystemPrivilegeSql(grantee: string, privilege: string): string {
  return `REVOKE ${privilege} FROM ${quoteDamengIdentifier(grantee)};`;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseDamengUsers(result: QueryResult): DamengUser[] {
  return result.rows.map((row) => {
    const raw = rowToObject(result.columns, row);
    const accountStatus = valueAt(raw, "ACCOUNT_STATUS").toUpperCase();
    return {
      username: valueAt(raw, "USERNAME"),
      accountStatus,
      locked: /LOCKED/i.test(accountStatus),
      defaultTablespace: valueAt(raw, "DEFAULT_TABLESPACE"),
      temporaryTablespace: valueAt(raw, "TEMPORARY_TABLESPACE"),
      profile: valueAt(raw, "PROFILE"),
      created: valueAt(raw, "CREATED"),
      raw,
    };
  });
}

export function parseDamengRoles(result: QueryResult): DamengRole[] {
  return result.rows.map((row) => {
    const raw = rowToObject(result.columns, row);
    return {
      role: valueAt(raw, "ROLE"),
      passwordRequired: valueAt(raw, "PASSWORD_REQUIRED"),
      raw,
    };
  });
}

export function parseDamengRoleGrants(result: QueryResult): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const raw = rowToObject(result.columns, row);
    const grantee = valueAt(raw, "GRANTEE").trim().toUpperCase();
    const role = valueAt(raw, "GRANTED_ROLE").trim().toUpperCase();
    if (!grantee || !role) continue;
    let roles = grants.get(grantee);
    if (!roles) {
      roles = new Set();
      grants.set(grantee, roles);
    }
    roles.add(role);
  }
  return grants;
}

export function parseDamengRolePrivs(result: QueryResult): DamengGrant[] {
  return result.rows.map((row) => {
    const raw = rowToObject(result.columns, row);
    return {
      grantee: valueAt(raw, "GRANTEE"),
      grantedRole: valueAt(raw, "GRANTED_ROLE"),
      adminOption: isYes(valueAt(raw, "ADMIN_OPTION")),
      defaultRole: isYes(valueAt(raw, "DEFAULT_ROLE")),
    };
  });
}

export function parseDamengSysPrivs(result: QueryResult): DamengSysPrivilege[] {
  return result.rows.map((row) => {
    const raw = rowToObject(result.columns, row);
    return {
      grantee: valueAt(raw, "GRANTEE"),
      privilege: valueAt(raw, "PRIVILEGE"),
      adminOption: isYes(valueAt(raw, "ADMIN_OPTION")),
    };
  });
}

export function parseDamengTablespaces(result: QueryResult): string[] {
  return result.rows
    .map((row) => {
      const raw = rowToObject(result.columns, row);
      return valueAt(raw, "TABLESPACE_NAME");
    })
    .filter((name) => name !== "");
}

/** The set of system privilege names this DM instance supports (SYSTEM_PRIVILEGE_MAP). */
export function parseDamengSystemPrivilegeMap(result: QueryResult): Set<string> {
  const names = new Set<string>();
  for (const row of result.rows) {
    const raw = rowToObject(result.columns, row);
    const name = valueAt(raw, "NAME").trim().toUpperCase();
    if (name) names.add(name);
  }
  return names;
}

/**
 * Whether the instance allows granting/revoking ANY-type DDL system privileges
 * (DM8 default: ENABLE_DDL_ANY_PRIV=0, which rejects them with error -5567).
 */
export function parseDamengEnableDdlAnyPriv(result: QueryResult): boolean {
  if (result.rows.length === 0) return true;
  const raw = rowToObject(result.columns, result.rows[0]);
  return String(valueAt(raw, "PARA_VALUE") ?? "0").trim() !== "0";
}

/** True for ANY-type system privileges (CREATE ANY TABLE, SELECT ANY VIEW, ...). */
export function isDamengAnyPrivilege(privilege: string): boolean {
  return /\bANY\b/.test(privilege.toUpperCase());
}

/**
 * Filters the static privilege catalog down to privileges that actually exist
 * on this DM instance. The static catalog is an Oracle-style best-effort list
 * and DM versions differ; the runtime map makes the grant dialog accurate.
 */
export function damengAvailableSystemPrivileges(catalog: readonly string[], existing: Set<string>): string[] {
  const normalized = new Set([...existing].map((name) => name.toUpperCase()));
  return catalog.filter((privilege) => normalized.has(privilege.toUpperCase()));
}

/**
 * The DM role graph as GRANTEE -> directly granted roles. SVI / VTI and other
 * roles are often granted through nesting (DBA -> VTI, PUBLIC -> SVI), and the
 * official DM management tool shows the transitive closure, so we compute it
 * client-side from this full graph.
 */
export function parseDamengRoleGraph(result: QueryResult): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const row of result.rows) {
    const raw = rowToObject(result.columns, row);
    const grantee = valueAt(raw, "GRANTEE").toUpperCase();
    const role = valueAt(raw, "GRANTED_ROLE").toUpperCase();
    if (!grantee || !role) continue;
    const list = graph.get(grantee) ?? [];
    if (!list.includes(role)) list.push(role);
    graph.set(grantee, list);
  }
  return graph;
}

/** Internal DM roles that cannot be granted or revoked (GRANT fails with
 * "Grantor no granted privilege") and are hidden from the official client. */
/** Internal DM roles that cannot be granted or revoked (GRANT fails with
 * "Grantor no granted privilege") and are hidden from the official client. */
export const DAMENG_HIDDEN_ROLES = ["SYS_ADMIN"] as const;

/**
 * DM pre-defined roles that exist from database initialization and cannot be
 * dropped or modified (their privilege sets are fixed by the system). Includes
 * the DBA / AUDITOR / SSO / DBO type roles documented in the DM8 safety manual.
 */
export const DAMENG_PREDEFINED_ROLES: readonly string[] = [
  "DBA",
  "RESOURCE",
  "PUBLIC",
  "VTI",
  "SOI",
  "SVI",
  "SYS_ADMIN",
  "SELECT_CATALOG_ROLE",
  "DB_AUDIT_ADMIN",
  "DB_AUDIT_OPER",
  "DB_AUDIT_PUBLIC",
  "DB_AUDIT_VTI",
  "DB_AUDIT_SOI",
  "DB_AUDIT_SVI",
  "DB_AUDIT_SELECT_CATALOG_ROLE",
  "DB_POLICY_ADMIN",
  "DB_POLICY_OPER",
  "DB_POLICY_PUBLIC",
  "DB_POLICY_VTI",
  "DB_POLICY_SOI",
  "DB_POLICY_SVI",
  "DB_POLICY_SELECT_CATALOG_ROLE",
  "DB_OBJECT_ADMIN",
  "DB_OBJECT_OPER",
  "DB_OBJECT_PUBLIC",
  "DB_OBJECT_VTI",
  "DB_OBJECT_SOI",
  "DB_OBJECT_SVI",
  "DB_OBJECT_SELECT_CATALOG_ROLE",
];

/** Case-insensitive check for DM pre-defined roles. */
export function isDamengPredefinedRole(role: string | undefined): boolean {
  if (!role) return false;
  const normalized = role.trim().toUpperCase();
  return DAMENG_PREDEFINED_ROLES.some((predefined) => predefined === normalized);
}

/**
 * Transitive closure of the roles a user effectively holds, mirroring the
 * official DM management tool: direct grants plus roles reachable through
 * role nesting (e.g. SYSDBA -> DBA -> VTI). Hidden internal roles such as
 * SYS_ADMIN are excluded.
 */
export function damengRolesClosure(username: string, graph: Map<string, string[]>): DamengRoleEntry[] {
  const start = username.trim().toUpperCase();
  const seen = new Set<string>();
  const entries: DamengRoleEntry[] = [];
  const queue: { role: string; direct: boolean; via?: string }[] = (graph.get(start) ?? []).map((role) => ({
    role,
    direct: true,
  }));
  while (queue.length > 0) {
    const { role, direct, via } = queue.shift()!;
    if (seen.has(role) || DAMENG_HIDDEN_ROLES.includes(role as (typeof DAMENG_HIDDEN_ROLES)[number])) continue;
    seen.add(role);
    entries.push({ role, direct, via });
    for (const child of graph.get(role) ?? []) {
      queue.push({ role: child, direct: false, via: role });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function quoteDamengIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteDamengString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteDamengPassword(value: string): string {
  // DM8 CREATE/ALTER USER IDENTIFIED BY takes a double-quoted password token
  // (single quotes are string literals and fail with a parse error there).
  // Double quotes preserve case; a literal " inside the password is escaped as "".
  return `"${value.replace(/"/g, '""')}"`;
}

function isYes(value: string): boolean {
  return value.trim().toUpperCase() === "YES";
}

function rowToObject(columns: string[], row: QueryResult["rows"][number]): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    object[column] = row[index] ?? null;
  });
  return object;
}

function valueAt(row: Record<string, unknown>, column: string): string {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.toLowerCase());
  const value = key ? row[key] : undefined;
  return value == null ? "" : String(value);
}
