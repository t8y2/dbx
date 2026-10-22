/**
 * Composer database-selection rules for the AI panel (#12972).
 *
 * The composer's database multi-select is *context*: every selected database can
 * be inspected by the model (#11660). The database the chat executes SQL on is
 * the conversation binding, shown in the picker as the target. These helpers keep
 * the selection from silently following changes that are not a target change —
 * notably a schema change, which used to reset the selection (and therefore the
 * execution target) to the connection's default database (`postgres` for
 * PostgreSQL).
 */

export interface AiComposerScope {
  /** Persisted conversation on screen; `""` while the chat has no record yet. */
  conversationId: string;
  connectionId: string;
  /**
   * Namespace the run targets: the database, or the schema for engines whose
   * top-level namespace is a schema (Dameng — see `resolveAiNamespaceSelection`).
   */
  namespace: string;
}

/**
 * Selection to apply after the chat's scope moved, or `null` to keep it.
 *
 * Reset to the new namespace only for a real scope switch: another conversation,
 * another connection, or (on schema-scoped engines) another namespace. A schema
 * change on a database-scoped engine leaves `namespace` untouched, so the
 * selection survives it. A namespace change that the panel itself initiated
 * ("set as target") already contains the new target in `selection`, so it is
 * kept as-is — the remaining context databases must not be dropped.
 */
export function resolveComposerDatabaseReset(previous: AiComposerScope, next: AiComposerScope, selection: readonly string[]): string[] | null {
  if (previous.connectionId !== next.connectionId || previous.conversationId !== next.conversationId) {
    return next.namespace ? [next.namespace] : [];
  }
  if (next.namespace === previous.namespace) return null;
  if (next.namespace && selection.includes(next.namespace)) return null;
  return next.namespace ? [next.namespace] : [];
}

/**
 * Selection and the new target after a toggle. `null` means the toggle is a
 * no-op: the target is always part of the scope (removing it would leave SQL
 * executing on a database the context no longer lists), and the picker never
 * becomes empty.
 */
export function toggleSelectedDatabase(selection: readonly string[], database: string, target: string): string[] | null {
  if (!database) return null;
  if (!selection.includes(database)) return [...selection, database];
  if (database === target || selection.length === 1) return null;
  return selection.filter((item) => item !== database);
}

/** `selection` with `database` appended when it is not already selected. */
export function withDatabaseSelected(selection: readonly string[], database: string): string[] {
  if (!database || selection.includes(database)) return [...selection];
  return [...selection, database];
}
