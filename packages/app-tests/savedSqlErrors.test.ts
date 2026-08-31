import assert from "node:assert/strict";
import { test } from "vitest";
import { savedSqlErrorMessage } from "../../apps/desktop/src/lib/savedSql/savedSqlErrors.ts";

test("saved SQL name conflicts use the localized message", () => {
  const message = savedSqlErrorMessage({ code: "SAVED_SQL_NAME_CONFLICT", fileName: "report.sql" }, (key, params) => `${key}:${params?.name}`);

  assert.equal(message, "savedSql.nameConflict:report.sql");
});

test("other saved SQL errors keep their original message", () => {
  assert.equal(
    savedSqlErrorMessage(new Error("disk full"), () => "translated"),
    "disk full",
  );
});
