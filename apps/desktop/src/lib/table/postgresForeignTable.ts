import type { ConnectionConfig } from "@/types/database";

export interface PostgresForeignTableCreateOptions {
  server: string;
  options: Array<{ name: string; value: string }>;
}

export interface PostgresForeignTableDraft extends PostgresForeignTableCreateOptions {
  enabled: boolean;
}

export function supportsPostgresForeignTableCreation(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile">): boolean {
  const profile = connection?.driver_profile?.trim().toLowerCase();
  return connection?.db_type === "postgres" && (!profile || profile === "postgres");
}

export function emptyPostgresForeignTableDraft(): PostgresForeignTableDraft {
  return { enabled: false, server: "", options: [] };
}

export function restorePostgresForeignTableDraft(saved?: PostgresForeignTableDraft): PostgresForeignTableDraft {
  return { ...emptyPostgresForeignTableDraft(), ...saved, options: (saved?.options ?? []).map((option) => ({ ...option })) };
}

export function buildPostgresForeignTableOptions(draft: PostgresForeignTableDraft): PostgresForeignTableCreateOptions {
  return { server: draft.server, options: draft.options.filter((option) => option.name.trim() || option.value).map((option) => ({ name: option.name.trim(), value: option.value })) };
}

export const POSTGRES_FOREIGN_SERVERS_SQL = `SELECT s.srvname AS name, w.fdwname AS wrapper
FROM pg_catalog.pg_foreign_server s
JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw
WHERE pg_catalog.has_server_privilege(s.oid, 'USAGE')
ORDER BY s.srvname`;
