export interface OracleTnsConnectionConfig {
  alias: string;
  tnsAdmin: string;
}

const ORACLE_TNS_JDBC_PREFIX = "jdbc:oracle:thin:@";

export function parseOracleTnsConnectionString(value?: string): OracleTnsConnectionConfig | null {
  const source = value?.trim() || "";
  if (!source.toLowerCase().startsWith(ORACLE_TNS_JDBC_PREFIX)) return null;

  const target = source.slice(ORACLE_TNS_JDBC_PREFIX.length);
  if (!target || target.startsWith("(") || target.startsWith("//") || target.includes(":")) return null;

  const [rawAlias, rawQuery = ""] = target.split("?", 2);
  let alias = "";
  try {
    alias = decodeURIComponent(rawAlias).trim();
  } catch {
    return null;
  }
  const tnsAdmin = new URLSearchParams(rawQuery).get("TNS_ADMIN")?.trim() || "";
  if (!alias) return null;
  return { alias, tnsAdmin };
}

export function buildOracleTnsConnectionString(alias: string, tnsAdmin: string): string {
  const normalizedAlias = alias.trim();
  const normalizedTnsAdmin = normalizeOracleTnsAdminPath(tnsAdmin);
  const query = new URLSearchParams({ TNS_ADMIN: normalizedTnsAdmin });
  return `${ORACLE_TNS_JDBC_PREFIX}${encodeURIComponent(normalizedAlias)}?${query.toString()}`;
}

export function normalizeOracleTnsAdminPath(value: string): string {
  const path = value.trim();
  if (!path) return "";
  if (!/(^|[\\/])tnsnames\.ora$/i.test(path)) return path;

  const parent = path.replace(/[\\/]tnsnames\.ora$/i, "");
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  if (parent) return parent;
  return path.startsWith("\\") ? "\\" : "/";
}
