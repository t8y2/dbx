export type SqlCompletionTriggerMode = "manual" | "require-prefix" | "positional";
export type SqlCompletionTriggerOrigin = "typing" | "explicit";

export const SQL_COMPLETION_TRIGGER_MODES: readonly SqlCompletionTriggerMode[] = ["manual", "require-prefix", "positional"];

export function normalizeCompletionTriggerMode(value: unknown): SqlCompletionTriggerMode {
  if (typeof value === "string" && (value === "manual" || value === "require-prefix" || value === "positional")) {
    return value;
  }
  return "positional";
}

export interface SqlCompletionTriggerFacts {
  /** typing (DBX programmatic start / implicit) vs explicit (manual completion shortcut) */
  origin: SqlCompletionTriggerOrigin;
  /** completion context context.prefix.length > 0 (not trailing '.') */
  hasIdentifierPrefix: boolean;
  /** previousChar === "." && context.qualifier != null */
  qualifierTriggered: boolean;
  /** resolveSqlServerUseDatabaseCompletion().prefix ('m' / 'Bar' / '') */
  useDatabasePrefix: string | null;
  /** Only computed for positional mode: existing shouldAutoOpenSqlCompletion(sql, cursor, options) result */
  positionalEligible?: boolean;
}

/**
 * Pure trigger policy decision (the single gate, without sql/position itself).
 *
 * Decision rules (priority order):
 * 1. suppressed context (comment / string literal) -> reject first (including explicit)
 * 2. explicit -> allow directly (manual shortcut available in any mode)
 * 3. manual -> false (return before any semantic model / metadata read)
 * 4. require-prefix -> hasIdentifierPrefix || qualifierTriggered || (useDatabasePrefix != null && useDatabasePrefix.length > 0)
 * 5. positional -> positionalEligible || useDatabasePrefix != null
 */
export function shouldAllowSqlCompletionTrigger(mode: SqlCompletionTriggerMode, facts: SqlCompletionTriggerFacts): boolean {
  // Suppressed context (comment / string literal) is checked by the caller before
  // constructing facts, so this function treats the caller as already gate-kept.
  // However, for safety, explicit still bypasses mode checks.
  if (facts.origin === "explicit") return true;
  if (mode === "manual") return false;
  if (mode === "require-prefix") {
    return facts.hasIdentifierPrefix || facts.qualifierTriggered || (facts.useDatabasePrefix != null && facts.useDatabasePrefix.length > 0);
  }
  // positional
  return (facts.positionalEligible ?? false) || facts.useDatabasePrefix != null;
}
