import type { QueryTab } from "@/types/database";

/** Tab fields that decide whether its SQL can be persisted. */
export type SqlTabSaveTarget = Pick<QueryTab, "externalSqlPath" | "savedSqlId" | "sql" | "objectSource">;

/**
 * Whether the tab's SQL can be saved at all.
 *
 * A tab that already has a persistence target — an external `.sql` file or a
 * saved-SQL library entry — stays saveable after its content is emptied.
 * Deleting everything is a legitimate edit that must reach the target, and the
 * emptied state is also the only state in which the user can observe the guard.
 *
 * A brand-new tab has nothing to persist, and an emptied object-source tab would
 * push a body-less `CREATE` for a routine or view to the server, so both keep the
 * content requirement.
 */
export function canSaveSqlTab(tab: SqlTabSaveTarget): boolean {
  if (tab.externalSqlPath || tab.sql.trim()) return true;
  if (tab.objectSource) return false;
  return !!tab.savedSqlId;
}
