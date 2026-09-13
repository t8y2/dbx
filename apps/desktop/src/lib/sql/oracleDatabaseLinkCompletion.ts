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

export function oracleDatabaseLinkCompletionItems(links: readonly OracleDatabaseLink[], prefix: string) {
  const seen = new Set<string>();
  // Oracle resolves object@link against the login user's private links plus
  // PUBLIC links; CURRENT_SCHEMA never enables or disables either, and the
  // link query already restricts owners to SESSION_USER and PUBLIC.
  return [...links]
    .sort((a, b) => Number(a.owner === "PUBLIC") - Number(b.owner === "PUBLIC"))
    .filter((link) => {
      const key = link.name.toUpperCase();
      if (seen.has(key) || !key.startsWith(prefix.toUpperCase())) return false;
      seen.add(key);
      return true;
    })
    .map((link) => ({ label: link.name, apply: link.name, type: "namespace", detail: `${link.owner} · ${link.username || "—"} · ${link.host}` }));
}
