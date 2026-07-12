export type SqliteDataTypeHelpKey = "integer" | "real" | "text" | "blob" | "numeric";

export interface SqliteDataTypeHelp {
  key: SqliteDataTypeHelpKey;
}

/**
 * Maps declared types using SQLite's ordered affinity rules. The order matters:
 * for example, FLOATING POINT has INTEGER affinity because it contains "INT".
 */
export function getSqliteDataTypeHelp(rawType: string): SqliteDataTypeHelp | undefined {
  const normalized = rawType
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return { key: "blob" };
  if (normalized.includes("int")) return { key: "integer" };
  if (normalized.includes("char") || normalized.includes("clob") || normalized.includes("text")) return { key: "text" };
  if (normalized.includes("blob")) return { key: "blob" };
  if (normalized.includes("real") || normalized.includes("floa") || normalized.includes("doub")) return { key: "real" };
  return { key: "numeric" };
}
