import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatAiTableMention, parseAiTableMentions } from "../../apps/desktop/src/lib/aiTableMentions.ts";

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
