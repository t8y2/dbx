// Regression test for t8y2/dbx #6190.
//
// The sidebar label matcher itself matches "erpncs"/"terpncs" against
// "T_Erp_Nc_SuPlan_List" (via the separator-blind tiers). The reported bug is
// not a matcher defect: it is that local-mode first searches only had the
// currently loaded first page of children available. This test locks in both
// halves of the behavior so the fix cannot regress.
import { test } from "vitest";
import assert from "node:assert/strict";
import { matchSidebarLabel } from "../../apps/desktop/src/lib/sidebar/sidebarSearch.ts";

const TARGET = "T_Erp_Nc_SuPlan_List";

function erpTables(): string[] {
  const names: string[] = [];
  for (let i = 0; i < 700; i++) names.push(`A_Erp_Nc_Sys_${i}`);
  for (let i = 0; i < 100; i++) names.push(`T_Erp_Nc_Su_Table_${i}`);
  for (let i = 0; i < 300; i++) names.push(`T_Bas_Customer_${i}`);
  for (let i = 0; i < 300; i++) names.push(`T_Fin_Account_${i}`);
  names.push(TARGET);
  return names;
}

function filterNames(names: string[], query: string): string[] {
  return names.filter((name) => !!matchSidebarLabel(name, query));
}

test("matcher hits the target for erpncs / terpncs and case variants", () => {
  for (const query of ["erpncs", "terpncs", "ERPnCS", "ERPNCS"]) {
    assert.ok(matchSidebarLabel(TARGET, query), `expected ${query} to match ${TARGET}`);
  }
});

test("first page of a large schema does not contain the target (pre-fix fallback failed)", () => {
  const all = erpTables();
  const sorted = [...all].sort((a, b) => a.localeCompare(b));
  const firstPage = sorted.slice(0, 501);
  assert.equal(firstPage.includes(TARGET), false, "target must sort beyond the first page");
  // The pre-fix first search only had these children: even a correct matcher
  // cannot surface a table that is not in the candidate set.
  assert.equal(filterNames(firstPage, "erpncs").includes(TARGET), false);
  assert.equal(filterNames(firstPage, "terpncs").includes(TARGET), false);
});

test("complete index search finds the target for erpncs / terpncs on first search", () => {
  const all = erpTables();
  assert.ok(filterNames(all, "erpncs").includes(TARGET));
  assert.ok(filterNames(all, "terpncs").includes(TARGET));
});

test("existing fuzzy behavior is unchanged (per-word subsequence, not cross-word)", () => {
  // Per-word subsequence: "odr" inside "orders" matches, but a sequence that
  // would cross a word separator does not (deliberate anti-overmatch design,
  // see sidebarSearch.test.ts "resets at _"). The #6190 fix does not alter the
  // matcher, so these tiers must stay untouched.
  assert.equal(matchSidebarLabel("orders", "odr")?.kind, "fuzzy");
  assert.equal(matchSidebarLabel("system_user", "sysu"), null);
  // Separator-blind tiers still work for the target table itself.
  assert.equal(matchSidebarLabel("T_Erp_Nc_SuPlan_List", "erpncs")?.kind, "substring");
});

test("single-character query does not enable loose fuzzy on the target", () => {
  // "u" only matches via plain substring containment.
  assert.equal(matchSidebarLabel("T_Erp_Nc_SuPlan_List", "u")?.kind, "substring");
  assert.equal(matchSidebarLabel("orders", "u"), null);
});
