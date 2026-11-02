import { expect, it } from "vitest";
import { analyzeEditableQueryEditability } from "../../sql/sqlAnalysis";
it("allows parentheses in JOIN predicates but not derived or function sources", () => {
  expect(analyzeEditableQueryEditability("SELECT u.id,u.name,p.id,p.title FROM users u JOIN papers p ON (u.id=p.user_id)").editable).toBe(true);
  for (const sql of ["SELECT u.id,p.id FROM users u JOIN (SELECT id FROM papers) p ON u.id=p.id", "SELECT u.id,p.id FROM users u JOIN generate_series(1,2) p ON u.id=p.id"]) {
    expect(analyzeEditableQueryEditability(sql).editable).toBe(false);
  }
});
