// Regression test for t8y2/dbx #6190.
//
// The sidebar label matcher itself matches "erpncs"/"terpncs" against
// "T_Erp_Nc_SuPlan_List" (via the separator-blind tiers). The reported bug is
// not a matcher defect: it is that local-mode first searches only had the
// currently loaded first page of children available. This test locks in both
// halves of the behavior so the fix cannot regress.
import { describe, expect, it, test } from "vitest";
import assert from "node:assert/strict";
import { matchSidebarLabel } from "../../apps/desktop/src/lib/sidebar/sidebarSearch.ts";
import { filterLocallySearchedTables } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import type { TableInfo, TreeNode } from "../../apps/desktop/src/types/database.ts";

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

// ── Per-database table search honors the sidebar match mode (#13505) ──
//
// The per-database search box never enables regex mode, so only the plain-text
// match mode applies there. filterLocallySearchedTables must forward it to the
// matcher; otherwise the per-database box would keep returning subsequence
// hits while the global box already stopped.

describe("filterLocallySearchedTables match mode (#13505)", () => {
  const entries: TableInfo[] = [
    { name: "101", table_type: "TABLE", comment: null },
    { name: "1001", table_type: "TABLE", comment: null },
    { name: "t_101", table_type: "TABLE", comment: null },
    { name: "t_1001", table_type: "TABLE", comment: null },
    { name: "dwd_order_101", table_type: "TABLE", comment: null },
  ];

  function schemaNode(children: TreeNode[]): TreeNode {
    return { id: "conn:db", label: "db", type: "schema", connectionId: "conn", database: "db", children };
  }

  function liveChildren(): TreeNode[] {
    return entries.map((entry) => ({ id: `conn:db:${entry.name}`, label: entry.name, type: "table" as const, connectionId: "conn", database: "db" }));
  }

  function matchedLabels(matchMode: "fuzzy" | "contains" | "edges" | undefined, indexed: Record<string, TableInfo[] | null>, children = liveChildren()): string[] {
    const projected = filterLocallySearchedTables([schemaNode(children)], {
      enabled: true,
      queries: { "conn:db": "101" },
      indexedResults: indexed,
      ...(matchMode ? { matcherOptions: { matchMode } } : {}),
    });
    return (projected[0].children ?? []).map((node) => node.label).sort();
  }

  it("keeps every fuzzy hit when no matcher options are given", () => {
    // Default must stay exactly as before: fuzzy subsequence still finds 1001.
    expect(matchedLabels(undefined, {})).toEqual(["1001", "101", "dwd_order_101", "t_1001", "t_101"]);
    expect(matchedLabels("fuzzy", {})).toEqual(["1001", "101", "dwd_order_101", "t_1001", "t_101"]);
  });

  it("drops subsequence hits in contains mode on every branch", () => {
    const expected = ["101", "dwd_order_101", "t_101"];
    for (const indexed of [{ "conn:db": entries }, { "conn:db": null }, {}] as Array<Record<string, TableInfo[] | null>>) {
      expect(matchedLabels("contains", indexed)).toEqual(expected);
    }
  });

  it("only keeps whole-label edges in edges mode", () => {
    // dwd_order_101 ends with the query, so `edges` keeps it.
    expect(matchedLabels("edges", {})).toEqual(["101", "dwd_order_101", "t_101"]);
  });

  it("applies the mode to comments as well as names", () => {
    const children: TreeNode[] = [
      { id: "conn:db:101", label: "101", type: "table", connectionId: "conn", database: "db", comment: "101 archive" },
      { id: "conn:db:1001", label: "1001", type: "table", connectionId: "conn", database: "db", comment: null },
    ];
    expect(matchedLabels("fuzzy", {}, children)).toEqual(["1001", "101"]);
    // "101 archive" starts with the query, so it survives `edges` through the
    // comment label; "1001" has no edge match at all.
    expect(matchedLabels("edges", {}, children)).toEqual(["101"]);
    expect(matchedLabels("contains", {}, children)).toEqual(["101"]);
  });
});
