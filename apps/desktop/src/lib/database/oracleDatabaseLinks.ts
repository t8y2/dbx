import type { QueryResult } from "@/types/database";

export interface OracleDatabaseLink {
  name: string;
  owner: string;
  username: string;
  host: string;
  created: string;
}

// Links belong to the login user, independently of ALTER SESSION SET CURRENT_SCHEMA.
// Do not expose another user's private links when connected with catalog privileges.
export const ORACLE_DATABASE_LINKS_SQL = `SELECT OWNER, DB_LINK, USERNAME, HOST,
       TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS') AS CREATED
FROM ALL_DB_LINKS
WHERE OWNER IN (SYS_CONTEXT('USERENV', 'SESSION_USER'), 'PUBLIC')
ORDER BY DB_LINK, CASE WHEN OWNER = 'PUBLIC' THEN 1 ELSE 0 END`;

export function oracleDatabaseLinksFromResult(result: QueryResult): OracleDatabaseLink[] {
  const indexes = new Map(result.columns.map((name, index) => [name.toUpperCase(), index]));
  return result.rows
    .map((row) => {
      const value = (name: string) => String(row[indexes.get(name) ?? -1] ?? "");
      return { name: value("DB_LINK"), owner: value("OWNER"), username: value("USERNAME"), host: value("HOST"), created: value("CREATED") };
    })
    .filter((link) => !!link.name && !!link.owner);
}

export function oracleDatabaseLinkName(name: string): string {
  // Oracle link names are ASCII, case insensitive, and may include a domain.
  // A dot is part of the link name, never a schema qualifier.
  if (!/^[A-Za-z][A-Za-z0-9_$#]*(?:\.[A-Za-z0-9_$#]+)*$/.test(name) || name.length > 128) throw new Error("Invalid database link name");
  return name;
}

function oracleQuotedIdentifier(value: string, fromMetadata = false): string {
  if (!value || /[\0\r\n]/.test(value)) throw new Error("Invalid identifier");
  const name = fromMetadata ? value : value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toUpperCase();
  return `"${name.replaceAll('"', '""')}"`;
}

export function createOracleDatabaseLinkSql(input: { name: string; public: boolean; username: string; password: string; host: string }): string {
  if (!input.host.trim() || !input.password || /[\0\r\n"]/.test(input.password)) throw new Error("A connect string and a password without double quotes or line breaks are required");
  return `CREATE ${input.public ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(input.name)} CONNECT TO ${oracleQuotedIdentifier(input.username)} IDENTIFIED BY "${input.password}" USING '${input.host.replaceAll("'", "''")}'`;
}

export function alterOracleDatabaseLinkSql(link: OracleDatabaseLink, password: string): string {
  if (!link.username || !password || /[\0\r\n"]/.test(password)) throw new Error("A fixed-user link and a password without double quotes or line breaks are required");
  return `ALTER ${link.owner === "PUBLIC" ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(link.name)} CONNECT TO ${oracleQuotedIdentifier(link.username, true)} IDENTIFIED BY "${password}"`;
}

export function dropOracleDatabaseLinkSql(link: OracleDatabaseLink): string {
  return `DROP ${link.owner === "PUBLIC" ? "PUBLIC " : ""}DATABASE LINK ${oracleDatabaseLinkName(link.name)}`;
}
export function testOracleDatabaseLinkSql(link: OracleDatabaseLink): string {
  return `SELECT 1 AS DBX_LINK_OK FROM DUAL@${oracleDatabaseLinkName(link.name)}`;
}
