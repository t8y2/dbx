import { strict as assert } from "node:assert";
import test from "node:test";
import { analyzeFieldLineage, identifierInSql, summarizeLineageCounts } from "../src/lib/fieldLineage.ts";

test("detects outgoing and incoming foreign key lineage as certain", () => {
  const result = analyzeFieldLineage({
    target: { schema: "public", table: "orders", column: "user_id" },
    tables: [
      {
        schema: "public",
        name: "orders",
        columns: ["id", "user_id"],
        foreignKeys: [{ name: "orders_user_id_fkey", column: "user_id", ref_table: "users", ref_column: "id" }],
      },
      {
        schema: "public",
        name: "order_events",
        columns: ["id", "order_user_id"],
        foreignKeys: [{ name: "events_user_fkey", column: "order_user_id", ref_table: "orders", ref_column: "user_id" }],
      },
    ],
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.confidence, item.direction, item.table, item.column]),
    [
      ["foreignKey", "certain", "outgoing", "users", "id"],
      ["foreignKey", "certain", "incoming", "order_events", "order_user_id"],
    ],
  );
});

test("finds view, query history, and same-name column references without scanning table data", () => {
  const result = analyzeFieldLineage({
    target: { schema: "public", table: "users", column: "email" },
    tables: [
      { schema: "public", name: "users", columns: ["id", "email"], foreignKeys: [] },
      { schema: "public", name: "newsletter_subscribers", columns: ["id", "email"], foreignKeys: [] },
    ],
    views: [
      {
        schema: "public",
        name: "active_user_emails",
        ddl: "CREATE VIEW active_user_emails AS SELECT u.email FROM public.users u WHERE u.active = true",
      },
    ],
    histories: [
      {
        id: "h1",
        sql: "select email from users where email like '%@example.com'",
        executed_at: "2026-05-02T00:00:00Z",
      },
    ],
  });

  assert.deepEqual(
    result.items.map((item) => [item.kind, item.confidence, item.table, item.column]),
    [
      ["viewReference", "likely", "active_user_emails", undefined],
      ["historyReference", "likely", undefined, undefined],
      ["sameName", "possible", "newsletter_subscribers", "email"],
    ],
  );
  assert.deepEqual(summarizeLineageCounts(result.items), {
    certain: 0,
    likely: 2,
    possible: 1,
  });
});

test("matches quoted and bare identifiers safely", () => {
  assert.equal(identifierInSql('select "User Email" from users', "User Email"), true);
  assert.equal(identifierInSql("select `email` from users", "email"), true);
  assert.equal(identifierInSql("select user_email from users", "email"), false);
});
