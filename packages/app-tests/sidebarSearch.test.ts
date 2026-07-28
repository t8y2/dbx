import { strict as assert } from "node:assert";
import { test } from "vitest";
import { matchSidebarLabel } from "../../apps/desktop/src/lib/sidebar/sidebarSearch.ts";

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

test("matches separator-blind prefix when user omits the underscore between prefix and name", () => {
  // "delo" → "del_order": stripped "delorder" starts with "delo"
  assert.equal(matchSidebarLabel("del_order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del_order", "delo")?.score, 65);
  // "usrp" → "usr_profile": stripped "usrprofile" starts with "usrp"
  assert.equal(matchSidebarLabel("usr_profile", "usrp")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("usr_profile", "usrp")?.score, 65);
});

test("matches separator-blind substring across underscore boundaries", () => {
  // "delord" → "del_order": stripped "delorder" starts with "delord"
  // → separator-blind prefix, not substring
  assert.equal(matchSidebarLabel("del_order", "delord")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del_order", "delord")?.score, 65);
  // "elo" → "del_order": stripped "delorder" includes "elo" as a substring
  // (not at the start, so falls to separator-blind substring)
  assert.equal(matchSidebarLabel("del_order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del_order", "elo")?.score, 55);
  // "userpro" → "user_profile": stripped "userprofile" starts with "userpro"
  assert.equal(matchSidebarLabel("user_profile", "userpro")?.kind, "word-prefix");
});

test("does not match loose subsequences that object search would exclude", () => {
  // "roles" does NOT match "sys_role_data_scope" — the separator-blind
  // check strips to "sysroledatascope" which does not include "roles" as
  // a contiguous substring, and we intentionally exclude fuzzy/subsequence
  // matching on the stripped form to avoid false positives.
  assert.equal(matchSidebarLabel("sys_role_data_scope", "roles"), null);
  assert.equal(matchSidebarLabel("sys_role_data_scope", "role")?.kind, "word-prefix");
});

test("keeps fuzzy subsequence matching inside a single identifier word", () => {
  assert.equal(matchSidebarLabel("orders", "odr")?.kind, "fuzzy");
  assert.equal(matchSidebarLabel("user_profile", "up")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("user_profile", "urf"), null);
});

// ── Separator-blind extended coverage ──

test("separator-blind prefix works with hyphen, dot, space, and backslash separators", () => {
  // Hyphen separator
  assert.equal(matchSidebarLabel("del-order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del-order", "delo")?.score, 65);
  // Dot separator (common in schema-qualified names)
  assert.equal(matchSidebarLabel("del.order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del.order", "delo")?.score, 65);
  // Space separator
  assert.equal(matchSidebarLabel("del order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del order", "delo")?.score, 65);
  // Backslash separator (Windows / MSSQL linked-server paths)
  assert.equal(matchSidebarLabel("del\\order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del\\order", "delo")?.score, 65);
});

test("separator-blind substring works with hyphen, dot, space, and backslash separators", () => {
  // "elo" sits after the separator in all four forms → stripped includes it
  assert.equal(matchSidebarLabel("del-order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del-order", "elo")?.score, 55);
  assert.equal(matchSidebarLabel("del.order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del.order", "elo")?.score, 55);
  assert.equal(matchSidebarLabel("del order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del order", "elo")?.score, 55);
  assert.equal(matchSidebarLabel("del\\order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del\\order", "elo")?.score, 55);
});

test("separator-blind prefix works across three segments", () => {
  // "del_order_history" → stripped "delorderhistory"
  // "delorderhis" covers "del" + "order" + "his" → prefix
  assert.equal(matchSidebarLabel("del_order_history", "delorderhis")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del_order_history", "delorderhis")?.score, 65);
  // "sys_user_log" → stripped "sysuserlog", starts with "sysuser"
  assert.equal(matchSidebarLabel("sys_user_log", "sysuser")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("sys_user_log", "sysuser")?.score, 65);
});

test("separator-blind substring works across three segments", () => {
  // "del_order_history" → stripped "delorderhistory", includes "erhi" (from "order_history")
  const r1 = matchSidebarLabel("del_order_history", "erhi");
  assert.equal(r1?.kind, "substring");
  assert.equal(r1?.score, 55);
  // "sys_user_log" → stripped "sysuserlog", includes "userlo" (crosses "user" + "log")
  const r2 = matchSidebarLabel("sys_user_log", "userlo");
  assert.equal(r2?.kind, "substring");
  assert.equal(r2?.score, 55);
});

test("separator-blind works with consecutive separators", () => {
  // Double underscores
  assert.equal(matchSidebarLabel("del__order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del__order", "delo")?.score, 65);
  // Double hyphens
  assert.equal(matchSidebarLabel("del--order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del--order", "delo")?.score, 65);
  // Double dots
  assert.equal(matchSidebarLabel("del..order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del..order", "delo")?.score, 65);
});

test("separator-blind works with forward-slash separators", () => {
  // / is in both isWordBoundary and stripSeparators
  // prefix across /
  assert.equal(matchSidebarLabel("del/order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del/order", "delo")?.score, 65);
  // substring across /
  assert.equal(matchSidebarLabel("del/order", "elo")?.kind, "substring");
  assert.equal(matchSidebarLabel("del/order", "elo")?.score, 55);
  // abbreviation: d(0 boundary) o(4 boundary after /) → 60
  assert.equal(matchSidebarLabel("del/order", "do")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("del/order", "do")?.score, 60);
  // three-segment with /
  assert.equal(matchSidebarLabel("user/role/permission", "urp")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("user/role/permission", "urp")?.score, 60);
  // word-prefix at boundary: "role" starts after /
  assert.equal(matchSidebarLabel("user/role/permission", "role")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("user/role/permission", "role")?.score, 80);
  // separator-blind prefix across multiple /
  assert.equal(matchSidebarLabel("user/role/permission", "userrole")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("user/role/permission", "userrole")?.score, 65);
});

test("separator-blind works with mixed separators in the same label", () => {
  // Underscore then dot (common in MySQL schema.table notation)
  // "del_order.sub" → stripped "delordersub", "delord" starts at 0
  const r1 = matchSidebarLabel("del_order.sub", "delord");
  assert.equal(r1?.kind, "word-prefix");
  assert.equal(r1?.score, 65);
  // Dot then underscore
  // "schema.user_log" → stripped "schemauserlog", "schemau" starts at 0
  const r2 = matchSidebarLabel("schema.user_log", "schemau");
  assert.equal(r2?.kind, "word-prefix");
  assert.equal(r2?.score, 65);
  // All three: underscore, hyphen, dot
  // "del_order-hist.log" → stripped "delorderhistlog", "delorderh" starts at 0
  const r3 = matchSidebarLabel("del_order-hist.log", "delorderh");
  assert.equal(r3?.kind, "word-prefix");
  assert.equal(r3?.score, 65);
});

test("separator-blind substring in the middle of compound names", () => {
  // "rpro" from "user_profile" — direct includes("rpro") → false (r at 3, _ at 4)
  // Separator-blind: stripped "userprofile" → includes "rpro" → substring (55)
  assert.equal(matchSidebarLabel("user_profile", "rpro")?.kind, "substring");
  assert.equal(matchSidebarLabel("user_profile", "rpro")?.score, 55);
  // "rpr" from "user_profile" — direct includes false, stripped true
  assert.equal(matchSidebarLabel("user_profile", "rpr")?.kind, "substring");
  assert.equal(matchSidebarLabel("user_profile", "rpr")?.score, 55);
});

test("separator-blind works with dotted namespace patterns", () => {
  // "public.user_orders" → stripped "publicuserorders"
  // "publicu" crosses the first dot → separator-blind prefix
  assert.equal(matchSidebarLabel("public.user_orders", "publicu")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("public.user_orders", "publicu")?.score, 65);
  // "userord" crosses a dot + underscore → separator-blind substring
  assert.equal(matchSidebarLabel("public.user_orders", "userord")?.kind, "substring");
  assert.equal(matchSidebarLabel("public.user_orders", "userord")?.score, 55);
  // "cuser" from the middle (stripped form)
  assert.equal(matchSidebarLabel("public.user_orders", "cuser")?.kind, "substring");
  assert.equal(matchSidebarLabel("public.user_orders", "cuser")?.score, 55);
});

test("separator-blind is a no-op for labels without any separators", () => {
  // "orders" has no separators → stripped === label, separator-blind branch skipped
  assert.equal(matchSidebarLabel("orders", "elo"), null);
  assert.equal(matchSidebarLabel("customers", "cust")?.kind, "prefix");
  // Same behavior as before the change — direct matching applies
  assert.equal(matchSidebarLabel("orders", "odr")?.kind, "fuzzy");
  // A query that doesn't match via direct or separator-blind on a no-separator label
  assert.equal(matchSidebarLabel("products", "pdt")?.kind, "fuzzy");
});

test("separator-blind handles leading and trailing separators", () => {
  // Leading underscore: stripped "_del_order" = "delorder"
  assert.equal(matchSidebarLabel("_del_order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("_del_order", "delo")?.score, 65);
  // Trailing underscore: stripped "del_order_" = "delorder"
  assert.equal(matchSidebarLabel("del_order_", "delord")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del_order_", "delord")?.score, 65);
  // Leading hyphen
  assert.equal(matchSidebarLabel("-del_order", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("-del_order", "delo")?.score, 65);
  // Leading + trailing: stripped "_del_order_" = "delorder"
  assert.equal(matchSidebarLabel("_del_order_", "delo")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("_del_order_", "delo")?.score, 65);
  // Leading separator-only label: "___" → stripped "" → length 0 < query.length → no match
  assert.equal(matchSidebarLabel("___", "x"), null);
});

test("separator-blind with query equal to the fully stripped label", () => {
  // "a_b" search "ab" → abbreviation fires first: a(0 boundary) b(2 boundary) → 60
  assert.equal(matchSidebarLabel("a_b", "ab")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("a_b", "ab")?.score, 60);
  // "del_order" search "delorder" → stripped "delorder".startsWith("delorder") → 65
  // (abbreviation fails: d,e,l at 0/1/2 are NOT boundaries)
  assert.equal(matchSidebarLabel("del_order", "delorder")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("del_order", "delorder")?.score, 65);
  // "sys_user_log" search "sysuserlog" → 65 (abbreviation fails)
  assert.equal(matchSidebarLabel("sys_user_log", "sysuserlog")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("sys_user_log", "sysuserlog")?.score, 65);
  // "t_json" search "tjson" → 65 (abbreviation fails: t(0 ✓) j(2 ✓) but s,o,n not boundaries)
  assert.equal(matchSidebarLabel("t_json", "tjson")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("t_json", "tjson")?.score, 65);
  // "a.b" search "ab" → abbreviation: a(0 ✓) b(2 after . ✓) → 60, beats separator-blind
  assert.equal(matchSidebarLabel("a.b", "ab")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("a.b", "ab")?.score, 60);
});

test("direct matches always beat separator-blind counterparts", () => {
  // "del" is direct prefix (90), not separator-blind prefix (65)
  const r1 = matchSidebarLabel("del_order", "del");
  assert.equal(r1?.kind, "prefix");
  assert.equal(r1?.score, 90);
  // "ord" is direct word-prefix at the underscore boundary (80),
  // not separator-blind substring at 55
  const r2 = matchSidebarLabel("del_order", "ord");
  assert.equal(r2?.kind, "word-prefix");
  assert.equal(r2?.score, 80);
  // "_order" is a direct substring (70) because the label literally contains it
  const r3 = matchSidebarLabel("del_order", "_order");
  assert.equal(r3?.kind, "substring");
  assert.equal(r3?.score, 70);
  // "der" is a direct substring at indices 6-8 (70), not separator-blind (55)
  const r4 = matchSidebarLabel("del_order", "der");
  assert.equal(r4?.kind, "substring");
  assert.equal(r4?.score, 70);
});

test("abbreviation and word-prefix still outrank separator-blind", () => {
  // "do" for "del_order" matches as abbreviation (60) — d at start, o after _
  // separator-blind would NOT match anyway (stripped "delorder" does not contain "do"),
  // but even if it did, 60 > 55
  assert.equal(matchSidebarLabel("del_order", "do")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("del_order", "do")?.score, 60);
  // "up" for "user_profile" → abbreviation (60)
  assert.equal(matchSidebarLabel("user_profile", "up")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("user_profile", "up")?.score, 60);
  // "erp" for "user_profile" → direct fails (underscore breaks "er" + "p"),
  // stripped "userprofile" includes "erp" → separator-blind substring (55)
  assert.equal(matchSidebarLabel("user_profile", "erp")?.kind, "substring");
  assert.equal(matchSidebarLabel("user_profile", "erp")?.score, 55);
});

test("separator-blind handles edge cases correctly", () => {
  // Query longer than stripped label → no match
  assert.equal(matchSidebarLabel("del_order", "delorderextra"), null);
  // Query entirely composed of separator characters → only direct checks apply
  // "_" is a direct substring
  assert.equal(matchSidebarLabel("del_order", "_")?.kind, "substring");
  assert.equal(matchSidebarLabel("del_order", "_")?.score, 70);
  // ".__" → direct substring if present, null otherwise
  assert.equal(matchSidebarLabel("a.__b", ".__")?.kind, "substring");
  assert.equal(matchSidebarLabel("del_order", ".__"), null);
  // Empty query → null (early return in matchSidebarLabelWithRegex)
  assert.equal(matchSidebarLabel("del_order", ""), null);
});

// ── Single-character prefix patterns (e.g. "t_" prefix tables) ──

test("matches common t_xxx prefix tables via abbreviation", () => {
  // "t_json" — the single-letter prefix "t_" is a very common naming
  // convention.  "tj" picks the first char of each underscored segment.
  const r1 = matchSidebarLabel("t_json", "tj");
  assert.equal(r1?.kind, "abbreviation");
  assert.equal(r1?.score, 60);
  // "t_user" → "tu"
  const r2 = matchSidebarLabel("t_user", "tu");
  assert.equal(r2?.kind, "abbreviation");
  assert.equal(r2?.score, 60);
  // "t_order" → "to"
  const r3 = matchSidebarLabel("t_order", "to");
  assert.equal(r3?.kind, "abbreviation");
  assert.equal(r3?.score, 60);
});

test("matches t_xxx prefix tables with separator-blind substring deepening", () => {
  // "tjso" → "t_json": "t_json".startsWith("tjso") → false, includes → false.
  // Abbreviation: t at 0 ✓, j at 2 ✓, s at 3 NOT boundary → fails.
  // Fuzzy: "t_json" subsequence for "tjso" resets at _ → fails.
  // Separator-blind: stripped "tjson" starts with "tjso" → true!  The
  // stripped form is literally "tjson", and "tjso" IS a prefix of that.
  const r0 = matchSidebarLabel("t_json", "tjso");
  assert.equal(r0?.kind, "word-prefix");
  assert.equal(r0?.score, 65);
  // "tson" → "t_json": stripped "tjson".includes("tson")? NO — "tjson"
  // has 'j' between 't' and 's', so "tson" is not a contiguous substring.
  assert.equal(matchSidebarLabel("t_json", "tson"), null);
  // "tjs" → "t_json": stripped "tjson".startsWith("tjs") → true (65)
  const r2 = matchSidebarLabel("t_json", "tjs");
  assert.equal(r2?.kind, "word-prefix");
  assert.equal(r2?.score, 65);
  // "tus" → "t_user": stripped "tuser".startsWith("tus") → true (65)
  const r3 = matchSidebarLabel("t_user", "tus");
  assert.equal(r3?.kind, "word-prefix");
  assert.equal(r3?.score, 65);
});

test("t_xxx prefix tables: direct substring beats abbreviation", () => {
  // "t_j" → "t_json": "t_json" literally starts with "t_j" → prefix (90)
  const r1 = matchSidebarLabel("t_json", "t_j");
  assert.equal(r1?.kind, "prefix");
  assert.equal(r1?.score, 90);
  // "t_" → "t_json": direct prefix (90)
  const r2 = matchSidebarLabel("t_json", "t_");
  assert.equal(r2?.kind, "prefix");
  assert.equal(r2?.score, 90);
  // "json" → "t_json": word-prefix at the underscore boundary (80)
  const r3 = matchSidebarLabel("t_json", "json");
  assert.equal(r3?.kind, "word-prefix");
  assert.equal(r3?.score, 80);
  // "t_jso" — check: "t_json".startsWith("t_jso") → yes (prefix 90)
  // because "t_json" has t, _, j, s, o, n and "t_jso" is t, _, j, s, o
  assert.equal(matchSidebarLabel("t_json", "t_jso")?.kind, "prefix");
  assert.equal(matchSidebarLabel("t_json", "t_jso")?.score, 90);
});

test("matches t_xxx tables with multi-segment abbreviation", () => {
  // "t_my_json" → "tmj" picks t, m, j at boundaries → abbreviation (60)
  const r1 = matchSidebarLabel("t_my_json", "tmj");
  assert.equal(r1?.kind, "abbreviation");
  assert.equal(r1?.score, 60);
  // "t_json_item" → "tji" picks t, j, i at boundaries → abbreviation (60)
  const r2 = matchSidebarLabel("t_json_item", "tji");
  assert.equal(r2?.kind, "abbreviation");
  assert.equal(r2?.score, 60);
  // "tj" also matches "t_my_json" as abbreviation — t at 0, j at 5 (after second _)
  const r3 = matchSidebarLabel("t_my_json", "tj");
  assert.equal(r3?.kind, "abbreviation");
  assert.equal(r3?.score, 60);
});

test("common real-world table prefix patterns", () => {
  // v_ (view prefix): "v_order_detail"
  assert.equal(matchSidebarLabel("v_order_detail", "vod")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("v_order_detail", "vod")?.score, 60);
  // "vod" as separator-blind: stripped "vorderdetail".startsWith("vod") → true (65)
  // but abbreviation fires first (60).  Acceptable — both match.
  //
  // tmp_ prefix: "tmp_export_data"
  assert.equal(matchSidebarLabel("tmp_export_data", "ted")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("tmp_export_data", "ted")?.score, 60);
  // "tmpe" → stripped "tmpexportdata", startsWith "tmpe" → separator-blind prefix (65)
  // (abbreviation fails because 'p' is not at a boundary)
  assert.equal(matchSidebarLabel("tmp_export_data", "tmpe")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("tmp_export_data", "tmpe")?.score, 65);
  //
  // bak_ prefix: "bak_2024_orders"
  assert.equal(matchSidebarLabel("bak_2024_orders", "b2o")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("bak_2024_orders", "b2o")?.score, 60);
  // "bak2" → stripped "bak2024orders", startsWith "bak2" → true (65)
  // (abbreviation fails because 'a', 'k' are not at boundaries)
  assert.equal(matchSidebarLabel("bak_2024_orders", "bak2")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("bak_2024_orders", "bak2")?.score, 65);
});

test("matches slash-delimited regular expression queries case-insensitively by default", () => {
  assert.equal(matchSidebarLabel("SYS_USER_LOG", "/^sys_.*_log$/")?.kind, "regex");
  assert.equal(matchSidebarLabel("sys_user_archive", "/^sys_.*_log$/"), null);
});

test("keeps invalid regular expression queries from matching every label", () => {
  assert.equal(matchSidebarLabel("orders", "/["), null);
});
