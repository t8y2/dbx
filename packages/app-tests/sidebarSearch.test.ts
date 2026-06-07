import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchSidebarLabel } from "../../apps/desktop/src/lib/sidebarSearch.ts";

test("matches exact and prefix labels first", () => {
  assert.equal(matchSidebarLabel("orders", "orders")?.kind, "exact");
  assert.equal(matchSidebarLabel("orders_archive", "ord")?.kind, "prefix");
});

test("matches word prefixes in underscored and dotted identifiers", () => {
  assert.equal(matchSidebarLabel("user_orders", "ord")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("sales.customer_profile", "cust")?.kind, "word-prefix");
});

test("matches DataGrip-style abbreviations by identifier word boundaries", () => {
  assert.equal(matchSidebarLabel("additional_country", "ac")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("sales.customer_profile", "scp")?.kind, "abbreviation");
});

test("keeps one-character fuzzy matches disabled", () => {
  assert.equal(matchSidebarLabel("orders", "r")?.kind, "substring");
  assert.equal(matchSidebarLabel("orders", "x"), null);
});

test("does not match loose subsequences that object search would exclude", () => {
  assert.equal(matchSidebarLabel("sys_role_data_scope", "roles"), null);
  assert.equal(matchSidebarLabel("sys_role_data_scope", "role")?.kind, "word-prefix");
});

test("keeps fuzzy subsequence matching inside a single identifier word", () => {
  assert.equal(matchSidebarLabel("orders", "odr")?.kind, "fuzzy");
  assert.equal(matchSidebarLabel("user_profile", "up")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("user_profile", "urf"), null);
});

test("matches slash-delimited regular expression queries case-insensitively by default", () => {
  assert.equal(matchSidebarLabel("SYS_USER_LOG", "/^sys_.*_log$/")?.kind, "regex");
  assert.equal(matchSidebarLabel("sys_user_archive", "/^sys_.*_log$/"), null);
});

test("keeps invalid regular expression queries from matching every label", () => {
  assert.equal(matchSidebarLabel("orders", "/["), null);
});
