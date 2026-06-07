import { strict as assert } from "node:assert";
import test from "node:test";
import { qualifiedTableName, quoteTableIdentifier } from "../../apps/desktop/src/lib/tableSelectSql.ts";

test("JDBC table identifiers avoid double quotes for Kyuubi-compatible names", () => {
  assert.equal(quoteTableIdentifier("jdbc", "cbsdw_dwd"), "cbsdw_dwd");
  assert.equal(quoteTableIdentifier("jdbc", "dwd_test_df"), "dwd_test_df");
  assert.equal(
    qualifiedTableName({ databaseType: "jdbc", schema: "cbsdw_dwd", tableName: "dwd_test_df" }),
    "dwd_test_df",
  );
});

test("JDBC table identifiers use backticks only when quoting is needed", () => {
  assert.equal(quoteTableIdentifier("jdbc", "daily orders"), "`daily orders`");
  assert.equal(quoteTableIdentifier("jdbc", "daily`orders"), "`daily``orders`");
});
