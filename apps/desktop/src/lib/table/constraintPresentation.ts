import type { ConstraintInfo } from "@/types/database";

/**
 * Whether a constraint is a foreign key. `constraint_type` is a plain string
 * from the driver/agent API, so normalize (trim + upper-case) and also accept
 * the bare `F` letter (PostgreSQL's `pg_constraint.contype`) rather than
 * relying on an exact "FOREIGN KEY" spelling.
 */
export function isForeignKeyConstraint(constraint: ConstraintInfo): boolean {
  const type = constraint.constraint_type.trim().toUpperCase();
  return type === "FOREIGN KEY" || type === "F";
}

/**
 * Constraints to render on the structured "Constraints" tab.
 *
 * Foreign keys are omitted when a dedicated Foreign Keys tab is also shown,
 * so each constraint appears exactly once and the FK tab's navigation keeps
 * working (this mirrors the existing Oracle convention, whose
 * list_constraints already excludes FK rows). When there is no FK tab,
 * foreign keys remain visible here so they are never hidden entirely.
 */
export function constraintsForConstraintsTab(constraints: ConstraintInfo[], hasForeignKeysTab: boolean): ConstraintInfo[] {
  if (!hasForeignKeysTab) return constraints;
  return constraints.filter((constraint) => !isForeignKeyConstraint(constraint));
}
