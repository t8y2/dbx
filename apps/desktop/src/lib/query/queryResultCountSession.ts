import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

export function sqlServerCountUsesLocalTempTable(databaseType: DatabaseType | undefined, sql: string): boolean {
  if (databaseType !== "sqlserver" || !sql) return false;

  return tokenizeSqlSemantic(sql, "sqlserver").some((token) => {
    if (token.kind !== "word" && token.kind !== "quoted_identifier") return false;
    const identifier = token.kind === "quoted_identifier" ? unquoteSqlSemanticIdentifier(token) : token.text;
    return identifier.startsWith("#") && !identifier.startsWith("##");
  });
}
