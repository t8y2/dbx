import type { DatabaseType } from "@/types/database";
import type { OracleDatabaseLink } from "@/lib/database/oracleDatabaseLinks";
import { isSqlCompletionSuppressedContext } from "@/lib/sql/sqlCompletion";

export function oracleDatabaseLinkCompletionContext(sql: string, cursor: number, databaseType?: DatabaseType) {
  if (databaseType !== "oracle" || isSqlCompletionSuppressedContext(sql, cursor, { databaseType })) return null;
  const before = sql.slice(0, cursor);
  const match = /(?:[A-Za-z0-9_$#]|"(?:[^"]|"")+"|\))@([A-Za-z0-9_$#.]*)$/.exec(before);
  if (!match) return null;
  const prefix = match[1];
  return { prefix, from: cursor - prefix.length, to: cursor + (/^[A-Za-z0-9_$#.]*/.exec(sql.slice(cursor))?.[0].length ?? 0) };
}

export function oracleDatabaseLinkCompletionItems(links: readonly OracleDatabaseLink[], prefix: string, currentSchema?: string) {
  const seen = new Set<string>();
  // Oracle resolves a private link in the current schema, while another user's
  // private link cannot be used just by switching CURRENT_SCHEMA.
  return links
    .filter((link) => link.owner === "PUBLIC" || !currentSchema || link.owner === currentSchema)
    .sort((a, b) => Number(a.owner === "PUBLIC") - Number(b.owner === "PUBLIC"))
    .filter((link) => {
      const key = link.name.toUpperCase();
      if (seen.has(key) || !key.startsWith(prefix.toUpperCase())) return false;
      seen.add(key);
      return true;
    })
    .map((link) => ({ label: link.name, apply: link.name, type: "namespace", detail: `${link.owner} · ${link.username || "—"} · ${link.host}` }));
}
