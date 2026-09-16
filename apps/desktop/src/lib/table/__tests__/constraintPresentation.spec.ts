import { describe, expect, it } from "vitest";
import { constraintsForConstraintsTab, isForeignKeyConstraint } from "@/lib/table/constraintPresentation";
import type { ConstraintInfo } from "@/types/database";

function constraint(name: string, constraint_type: string): ConstraintInfo {
  return {
    name,
    constraint_type,
    definition: "",
    columns: [],
    ref_schema: null,
    ref_table: null,
    ref_columns: [],
    match_type: null,
    on_update: null,
    on_delete: null,
    deferrable: false,
    initially_deferred: false,
    enabled: true,
    valid: true,
  };
}

const pk = constraint("t_pkey", "PRIMARY KEY");
const fk = constraint("t_parent_fk", "FOREIGN KEY");
const unique = constraint("t_code_key", "UNIQUE");
const check = constraint("t_qty_check", "CHECK");
const all = [pk, fk, unique, check];

describe("isForeignKeyConstraint", () => {
  it("normalizes case and whitespace and accepts the bare F contype letter", () => {
    expect(isForeignKeyConstraint(constraint("a", "FOREIGN KEY"))).toBe(true);
    expect(isForeignKeyConstraint(constraint("a", "foreign key"))).toBe(true);
    expect(isForeignKeyConstraint(constraint("a", "  Foreign Key  "))).toBe(true);
    expect(isForeignKeyConstraint(constraint("a", "F"))).toBe(true);
    expect(isForeignKeyConstraint(constraint("a", "f"))).toBe(true);
  });

  it("rejects non-foreign-key constraint types", () => {
    expect(isForeignKeyConstraint(pk)).toBe(false);
    expect(isForeignKeyConstraint(unique)).toBe(false);
    expect(isForeignKeyConstraint(check)).toBe(false);
    expect(isForeignKeyConstraint(constraint("a", "EXCLUDE"))).toBe(false);
  });
});

describe("constraintsForConstraintsTab", () => {
  it("drops foreign keys when a dedicated Foreign Keys tab is shown", () => {
    expect(constraintsForConstraintsTab(all, true)).toEqual([pk, unique, check]);
  });

  it("normalizes foreign-key spellings before filtering", () => {
    const variants = [constraint("a", "foreign key"), constraint("b", "  Foreign Key  "), constraint("c", "F"), constraint("d", "PRIMARY KEY")];
    expect(constraintsForConstraintsTab(variants, true)).toEqual([variants[3]]);
  });

  it("keeps foreign keys when there is no dedicated Foreign Keys tab", () => {
    expect(constraintsForConstraintsTab(all, false)).toEqual(all);
  });

  it("keeps non-foreign-key constraints in order and handles an empty list", () => {
    expect(constraintsForConstraintsTab([fk], true)).toEqual([]);
    expect(constraintsForConstraintsTab([], true)).toEqual([]);
  });
});
