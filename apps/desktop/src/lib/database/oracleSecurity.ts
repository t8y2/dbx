import type { ConnectionConfig, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export type SecurityReadState = "ok" | "empty" | "denied" | "unavailable" | "error" | "unsupported";
export interface SecurityRead<T> {
  state: SecurityReadState;
  visibility: "complete" | "limited";
  source: string;
  rows: T[];
  message?: string;
  truncated: boolean;
}
export interface OracleSecurityUser { name: string; accountStatus?: string; profile?: string; defaultTablespace?: string; temporaryTablespace?: string }
export interface OracleSecurityRole { name: string; authentication?: string }
export interface OracleRoleGrant { grantee: string; role: string; adminOption: boolean; defaultRole?: boolean }
export interface OracleSystemGrant { grantee: string; privilege: string; adminOption: boolean }
export interface OracleObjectGrant { grantee: string; owner: string; objectName: string; grantor: string; privilege: string; grantable: boolean }
export interface OracleColumnGrant extends OracleObjectGrant { columnName: string }
export interface OracleSecuritySnapshot {
  currentUser: SecurityRead<string>;
  users: SecurityRead<OracleSecurityUser>;
  roles: SecurityRead<OracleSecurityRole>;
  roleGrants: SecurityRead<OracleRoleGrant>;
  systemGrants: SecurityRead<OracleSystemGrant>;
  objectGrants: SecurityRead<OracleObjectGrant>;
  columnGrants: SecurityRead<OracleColumnGrant>;
}
export type OracleSecurityQuery = (sql: string) => Promise<QueryResult>;
export const ORACLE_SECURITY_ROW_LIMIT = 10000;

export function supportsOracleSecurity(connection: ConnectionConfig | undefined): boolean {
  const type = effectiveDatabaseTypeForConnection(connection);
  return type === "oracle" || type === "oceanbase-oracle";
}

type DictionaryRow = Record<string, string>;
function dictionaryRows(result: QueryResult): DictionaryRow[] {
  if (result.execution_error) throw new Error(result.error?.detail ?? result.error?.code ?? "Dictionary query failed");
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column.toUpperCase(), String(row[i] ?? "")])));
}
function readState(error: unknown): SecurityReadState {
  const message = String(error);
  if (/ORA-01031|insufficient privileges/i.test(message)) return "denied";
  // ORA-00942 does not distinguish an absent view from a hidden view.
  if (/ORA-00942|table or view does not exist/i.test(message)) return "unavailable";
  return "error";
}
const yes = (value: string | undefined) => value === "YES";
const user = (row: DictionaryRow): OracleSecurityUser => ({ name: row.USERNAME, accountStatus: row.ACCOUNT_STATUS || undefined, profile: row.PROFILE || undefined, defaultTablespace: row.DEFAULT_TABLESPACE || undefined, temporaryTablespace: row.TEMPORARY_TABLESPACE || undefined });
const role = (row: DictionaryRow): OracleSecurityRole => ({ name: row.ROLE, authentication: row.PASSWORD_REQUIRED || undefined });
const roleGrant = (row: DictionaryRow): OracleRoleGrant => ({ grantee: row.GRANTEE, role: row.GRANTED_ROLE, adminOption: yes(row.ADMIN_OPTION), defaultRole: row.DEFAULT_ROLE ? yes(row.DEFAULT_ROLE) : undefined });
const systemGrant = (row: DictionaryRow): OracleSystemGrant => ({ grantee: row.GRANTEE, privilege: row.PRIVILEGE, adminOption: yes(row.ADMIN_OPTION) });
const objectGrant = (row: DictionaryRow): OracleObjectGrant => ({ grantee: row.GRANTEE, owner: row.OWNER, objectName: row.TABLE_NAME, grantor: row.GRANTOR, privilege: row.PRIVILEGE, grantable: yes(row.GRANTABLE) });

async function readDictionary<T>(query: OracleSecurityQuery, primary: string, fallback: string | undefined, parse: (row: DictionaryRow) => T): Promise<SecurityRead<T>> {
  let message: string | undefined;
  for (const [index, sql] of [primary, fallback].entries()) {
    if (!sql) break;
    try {
      const result = await query(sql);
      const raw = dictionaryRows(result);
      const truncated = result.truncated === true || result.has_more === true || raw.length >= ORACLE_SECURITY_ROW_LIMIT;
      return { state: raw.length ? "ok" : "empty", visibility: index || truncated ? "limited" : "complete", source: sql, rows: raw.map(parse), message, truncated };
    } catch (error) {
      const state = readState(error);
      message = message ? `${message}; ${String(error)}` : String(error);
      if (index || !fallback || (state !== "denied" && state !== "unavailable")) {
        return { state, visibility: "limited", source: sql, rows: [], message, truncated: false };
      }
    }
  }
  return { state: "error", visibility: "limited", source: primary, rows: [], message, truncated: false };
}

/** Only fixed SELECTs: loading or filtering this snapshot never grants permissions. */
export async function loadOracleSecurity(query: OracleSecurityQuery): Promise<OracleSecuritySnapshot> {
  const [currentUser, users, roles, roleGrants, systemGrants, objectGrants, columnGrants] = await Promise.all([
    readDictionary(query, "SELECT USER AS USERNAME FROM DUAL", undefined, (row) => row.USERNAME),
    readDictionary(query, "SELECT USERNAME, ACCOUNT_STATUS, PROFILE, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE FROM DBA_USERS ORDER BY USERNAME", "SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME", user),
    readDictionary(query, "SELECT ROLE, PASSWORD_REQUIRED FROM DBA_ROLES ORDER BY ROLE", "SELECT DISTINCT GRANTED_ROLE AS ROLE FROM USER_ROLE_PRIVS ORDER BY ROLE", role),
    readDictionary(query, "SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE FROM DBA_ROLE_PRIVS ORDER BY GRANTEE, GRANTED_ROLE", "SELECT USERNAME AS GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE FROM USER_ROLE_PRIVS UNION SELECT ROLE AS GRANTEE, GRANTED_ROLE, ADMIN_OPTION, NULL AS DEFAULT_ROLE FROM ROLE_ROLE_PRIVS", roleGrant),
    readDictionary(query, "SELECT GRANTEE, PRIVILEGE, ADMIN_OPTION FROM DBA_SYS_PRIVS ORDER BY GRANTEE, PRIVILEGE", "SELECT USERNAME AS GRANTEE, PRIVILEGE, ADMIN_OPTION FROM USER_SYS_PRIVS UNION SELECT ROLE AS GRANTEE, PRIVILEGE, ADMIN_OPTION FROM ROLE_SYS_PRIVS", systemGrant),
    readDictionary(query, "SELECT GRANTEE, OWNER, TABLE_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM DBA_TAB_PRIVS ORDER BY OWNER, TABLE_NAME, GRANTEE, PRIVILEGE", "SELECT GRANTEE, TABLE_SCHEMA AS OWNER, TABLE_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS", objectGrant),
    readDictionary(query, "SELECT GRANTEE, OWNER, TABLE_NAME, COLUMN_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM DBA_COL_PRIVS ORDER BY OWNER, TABLE_NAME, COLUMN_NAME, GRANTEE", "SELECT GRANTEE, TABLE_SCHEMA AS OWNER, TABLE_NAME, COLUMN_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM ALL_COL_PRIVS", (row): OracleColumnGrant => ({ ...objectGrant(row), columnName: row.COLUMN_NAME })),
  ]);
  return { currentUser, users, roles, roleGrants, systemGrants, objectGrants, columnGrants };
}

export interface OracleGrantSource {
  kind: "system" | "object" | "column";
  grant: OracleSystemGrant | OracleObjectGrant | OracleColumnGrant;
  source: "direct" | "role" | "public";
  rolePath: string[];
}
/** Grant provenance, not a claim that inherited roles are enabled in this session. */
export function oracleGrantSources(snapshot: OracleSecuritySnapshot, principal: string): { grants: OracleGrantSource[]; bounded: boolean } {
  const roots = principal === "PUBLIC" ? [principal] : [principal, "PUBLIC"];
  const grants: OracleGrantSource[] = [];
  let bounded = false;
  for (const root of roots) {
    const paths = new Map<string, string[]>([[root, root === "PUBLIC" ? ["PUBLIC"] : []]]);
    const queue = [...paths.keys()];
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index];
      for (const edge of snapshot.roleGrants.rows) {
        if (edge.grantee !== parent || paths.has(edge.role)) continue;
        if (paths.size >= 1000) { bounded = true; continue; }
        paths.set(edge.role, [...paths.get(parent)!, edge.role]);
        queue.push(edge.role);
      }
    }
    for (const [kind, rows] of [["system", snapshot.systemGrants.rows], ["object", snapshot.objectGrants.rows], ["column", snapshot.columnGrants.rows]] as const) {
      for (const grant of rows) {
        const path = paths.get(grant.grantee);
        if (!path) continue;
        grants.push({ kind, grant, source: root === "PUBLIC" ? "public" : grant.grantee === principal ? "direct" : "role", rolePath: path });
      }
    }
  }
  return { grants, bounded };
}

export function oracleObjectGrantSources(snapshot: OracleSecuritySnapshot): OracleGrantSource[] {
  return [
    ...snapshot.objectGrants.rows.map((grant): OracleGrantSource => ({ kind: "object", grant, source: grant.grantee === "PUBLIC" ? "public" : "direct", rolePath: [] })),
    ...snapshot.columnGrants.rows.map((grant): OracleGrantSource => ({ kind: "column", grant, source: grant.grantee === "PUBLIC" ? "public" : "direct", rolePath: [] })),
  ];
}

export function oracleSecurityObjectMatches(grant: OracleGrantSource["grant"], owner: string, objectName: string): boolean {
  return "owner" in grant && (!owner || grant.owner === owner) && (!objectName || grant.objectName === objectName);
}
