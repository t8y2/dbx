import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatAiTableMention, normalizeAiTableMentionQuery, parseAiTableMentions, withoutAiTableMentionsOfDatabases } from "../../apps/desktop/src/lib/ai/aiTableMentions.ts";

test("parses simple and schema-qualified AI table mentions", () => {
  assert.deepEqual(parseAiTableMentions("show @users and join @public.orders"), [
    { raw: "@users", schema: undefined, table: "users" },
    { raw: "@public.orders", schema: "public", table: "orders" },
  ]);
});

test("parses quoted AI table mentions with spaces and dots", () => {
  assert.deepEqual(parseAiTableMentions('compare @"sales schema"."order.items" with @"audit log"'), [
    { raw: '@"sales schema"."order.items"', schema: "sales schema", table: "order.items" },
    { raw: '@"audit log"', schema: undefined, table: "audit log" },
  ]);
});

test("deduplicates AI table mentions case-insensitively", () => {
  assert.deepEqual(parseAiTableMentions("check @public.Users then @PUBLIC.users"), [{ raw: "@public.Users", schema: "public", table: "Users" }]);
});

test("formats AI table mentions with quotes only when needed", () => {
  assert.equal(formatAiTableMention("public", "users"), "@public.users");
  assert.equal(formatAiTableMention("sales schema", "order items"), '@"sales schema"."order items"');
});

// #11660: with several databases selected a mention has to name its own
// database, and the same table name in two databases must stay two mentions.
test("parses database-qualified AI table mentions", () => {
  assert.deepEqual(parseAiTableMentions("compare @db_first.public.logs with @db_second.public.logs", ["db_first", "db_second"]), [
    { raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" },
    { raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" },
  ]);
});

test("reads the leading segment as a database only when it is selected", () => {
  // MySQL-style names carry no schema: the selected database is the qualifier.
  assert.deepEqual(parseAiTableMentions("@analytics.users", ["analytics"]), [{ raw: "@analytics.users", database: "analytics", schema: undefined, table: "users" }]);
  // A schema that happens not to be a selected database keeps the legacy reading.
  assert.deepEqual(parseAiTableMentions("@public.users", ["analytics"]), [{ raw: "@public.users", schema: "public", table: "users" }]);
  assert.deepEqual(parseAiTableMentions("@public.users"), [{ raw: "@public.users", schema: "public", table: "users" }]);
});

// A three-part name typed by hand used to mean `schema.table` with the leading
// segment ignored; turning every one of them into a database reference (#11660)
// would drop names whose first segment is not a database this run can read.
test("keeps the legacy reading for a three-part name that is not a selected database", () => {
  assert.deepEqual(parseAiTableMentions("@catalog.public.users", ["analytics"]), [{ raw: "@catalog.public.users", schema: "public", table: "users" }]);
  assert.deepEqual(parseAiTableMentions("@catalog.public.users"), [{ raw: "@catalog.public.users", schema: "public", table: "users" }]);
  assert.deepEqual(parseAiTableMentions("@catalog.public.users", ["catalog"]), [{ raw: "@catalog.public.users", database: "catalog", schema: "public", table: "users" }]);
});

test("formats AI table mentions with the owning database", () => {
  assert.equal(formatAiTableMention("public", "users", "db_second"), "@db_second.public.users");
  assert.equal(formatAiTableMention(undefined, "users", "db_second"), "@db_second.users");
});

test("normalizes a mention query against the selected databases", () => {
  assert.deepEqual(normalizeAiTableMentionQuery("db_second.public.ord", ["db_first", "db_second"]), { databasePrefix: "db_second", schemaPrefix: "public", tableFilter: "ord" });
  assert.deepEqual(normalizeAiTableMentionQuery("public.ord", ["db_first"]), { schemaPrefix: "public", tableFilter: "ord" });
  assert.deepEqual(normalizeAiTableMentionQuery("orders", []), { schemaPrefix: "", tableFilter: "orders" });
});

test("drops the mentions of databases that are no longer selected", () => {
  const mentions = [
    { raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" },
    { raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" },
    { raw: "@public.users", schema: "public", table: "users" },
  ];
  assert.deepEqual(withoutAiTableMentionsOfDatabases(mentions, ["db_first"]), [mentions[1], mentions[2]]);
  // An unqualified (single-database) mention is never dropped.
  assert.deepEqual(withoutAiTableMentionsOfDatabases(mentions, []), mentions);
  // Nothing to drop also means nothing to allocate: the ref identity the caller
  // assigns back stays the same.
  assert.equal(withoutAiTableMentionsOfDatabases(mentions, []), mentions);
});
