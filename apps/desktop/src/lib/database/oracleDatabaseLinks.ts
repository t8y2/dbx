import type { DatabaseType, QueryResult } from "@/types/database";

export function supportsOracleDatabaseLinks(databaseType?: DatabaseType): boolean {
  return databaseType === "oracle" || databaseType === "oceanbase-oracle";
}

export interface OracleDatabaseLink {
  name: string;
  owner: string;
  username: string;
  host: string;
  created: string;
  canDrop?: boolean;
}

// Links belong to the login user, independently of ALTER SESSION SET CURRENT_SCHEMA.
// Do not expose another user's private links when connected with catalog privileges.
export const ORACLE_DATABASE_LINKS_SQL = `SELECT OWNER, DB_LINK, USERNAME, HOST,
       TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS') AS CREATED
FROM ALL_DB_LINKS
WHERE OWNER IN (SYS_CONTEXT('USERENV', 'SESSION_USER'), 'PUBLIC')
ORDER BY DB_LINK, CASE WHEN OWNER = 'PUBLIC' THEN 1 ELSE 0 END`;

// OceanBase 4.2.5 links created without a PUBLIC keyword are tenant-visible
// and ALL_DB_LINKS reports them as PUBLIC. USER_DB_LINKS identifies links
// created by the login user, which are the only links that user can drop.
export const OCEANBASE_ORACLE_DATABASE_LINKS_SQL = `SELECT L.OWNER, L.DB_LINK, L.USERNAME, L.HOST,
       TO_CHAR(L.CREATED, 'YYYY-MM-DD HH24:MI:SS') AS CREATED,
       CASE WHEN EXISTS (SELECT 1 FROM USER_DB_LINKS U WHERE U.DB_LINK = L.DB_LINK) THEN 1 ELSE 0 END AS DBX_CAN_DROP
FROM ALL_DB_LINKS L
ORDER BY L.DB_LINK`;

export function oracleDatabaseLinksSql(databaseType?: DatabaseType): string {
  return databaseType === "oceanbase-oracle" ? OCEANBASE_ORACLE_DATABASE_LINKS_SQL : ORACLE_DATABASE_LINKS_SQL;
}

export function oracleDatabaseLinksFromResult(result: QueryResult): OracleDatabaseLink[] {
  const indexes = new Map(result.columns.map((name, index) => [name.toUpperCase(), index]));
  const canDropIndex = indexes.get("DBX_CAN_DROP");
  return result.rows
    .map((row) => {
      const value = (name: string) => String(row[indexes.get(name) ?? -1] ?? "");
      return {
        name: value("DB_LINK"),
        owner: value("OWNER"),
        username: value("USERNAME"),
        host: value("HOST"),
        created: value("CREATED"),
        canDrop: canDropIndex === undefined || String(row[canDropIndex]) === "1",
      };
    })
    .filter((link) => !!link.name && !!link.owner);
}

export function oracleDatabaseLinkName(name: string): string {
  // Oracle link names are ASCII, case insensitive, and may include a domain.
  // A dot is part of the link name, never a schema qualifier.
  if (!/^[A-Za-z][A-Za-z0-9_$#]*(?:\.[A-Za-z0-9_$#]+)*$/.test(name) || name.length > 128) throw new Error("Invalid database link name");
  return name;
}

export function redactOracleDatabaseLinkError(error: unknown, secret: string): string {
  let message = String(error);
  if (secret) message = message.replaceAll(secret, "[redacted]");
  // OceanBase may truncate the echoed SQL in the middle of a password, so
  // replacing only the complete input is insufficient.
  return message.replace(/(IDENTIFIED\s+BY\s+")[^"]*(?:"|$)/gi, '$1[redacted]"');
}

function oracleQuotedIdentifier(value: string, fromMetadata = false): string {
  if (!value || value.includes("\0") || value.includes("\r") || value.includes("\n")) throw new Error("Invalid identifier");
  const name = fromMetadata ? value : value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toUpperCase();
  return `"${name.replaceAll('"', '""')}"`;
}

export function createOracleDatabaseLinkSql(input: { name: string; public: boolean; username: string; password: string; host: string }): string {
  if (!input.host.trim() || !input.password || input.password.includes("\0") || input.password.includes("\r") || input.password.includes("\n") || input.password.includes('"')) {
    throw new Error("A connect string and a password without double quotes or line breaks are required");
  }
  return `CREATE ${input.public ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(input.name)} CONNECT TO ${oracleQuotedIdentifier(input.username)} IDENTIFIED BY "${input.password}" USING '${input.host.replaceAll("'", "''")}'`;
}

export function createOceanBaseDatabaseLinkSql(input: { name: string; public: boolean; username: string; tenant: string; password: string; host: string; protocol: "OB" | "OCI"; cluster?: string }): string {
  if (!["OB", "OCI"].includes(input.protocol)) throw new Error("Unsupported database link protocol");
  if (!input.password || input.password.includes("\0") || input.password.includes("\r") || input.password.includes("\n") || input.password.includes('"') || !input.host.trim() || input.host.includes("\0") || input.host.includes("\r") || input.host.includes("\n")) {
    throw new Error("A host and a password without double quotes or line breaks are required");
  }
  const tenant = input.protocol === "OCI" ? "oracle" : input.tenant.trim();
  const cluster = input.cluster?.trim();
  if (input.protocol === "OCI" && cluster) throw new Error("Cluster is only supported for OceanBase links");
  // Tenant/cluster names are case-sensitive configuration, not unquoted SQL identifiers.
  // 4.2.5 rejects the Oracle-compatible PUBLIC keyword, while links created
  // with this syntax are visible tenant-wide and reported as OWNER=PUBLIC.
  return `CREATE ${input.public ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(input.name)} CONNECT TO ${oracleQuotedIdentifier(input.username)}@${oracleQuotedIdentifier(tenant, true)} IDENTIFIED BY "${input.password}" ${input.protocol} HOST '${input.host.replaceAll("'", "''")}'${cluster ? ` CLUSTER ${oracleQuotedIdentifier(cluster, true)}` : ""}`;
}

export function alterOracleDatabaseLinkSql(link: OracleDatabaseLink, password: string): string {
  if (!link.username || !password || password.includes("\0") || password.includes("\r") || password.includes("\n") || password.includes('"')) {
    throw new Error("A fixed-user link and a password without double quotes or line breaks are required");
  }
  return `ALTER ${link.owner === "PUBLIC" ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(link.name)} CONNECT TO ${oracleQuotedIdentifier(link.username, true)} IDENTIFIED BY "${password}"`;
}

export function dropOracleDatabaseLinkSql(link: OracleDatabaseLink, databaseType?: DatabaseType): string {
  const publicKeyword = databaseType !== "oceanbase-oracle" && link.owner === "PUBLIC" ? "PUBLIC " : "";
  return `DROP ${publicKeyword}DATABASE LINK ${oracleDatabaseLinkName(link.name)}`;
}
export function testOracleDatabaseLinkSql(link: OracleDatabaseLink, databaseType?: DatabaseType): string {
  const name = oracleDatabaseLinkName(link.name);
  return databaseType === "oceanbase-oracle" ? `SELECT 1 AS DBX_LINK_OK FROM SYS.ALL_USERS@${name} WHERE ROWNUM = 1` : `SELECT 1 AS DBX_LINK_OK FROM DUAL@${name}`;
}
