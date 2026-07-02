import { strict as assert } from "node:assert";
import { test } from "vitest";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";
import { defaultPasteTableMode, pasteTableModeCopiesData, supportsWholeRowTableDataCopy, tableClipboardMatchesTarget, tableDataCopyColumnOptions } from "../../apps/desktop/src/lib/tableClipboard.ts";

test("table clipboard entries must match the paste target context", () => {
  const target = { connectionId: "c1", database: "app", schema: "public" };

  assert.equal(tableClipboardMatchesTarget([{ connectionId: "c1", database: "app", schema: "public" }], target), true);
  assert.equal(tableClipboardMatchesTarget([{ connectionId: "c2", database: "app", schema: "public" }], target), false);
  assert.equal(tableClipboardMatchesTarget([{ connectionId: "c1", database: "other", schema: "public" }], target), false);
  assert.equal(tableClipboardMatchesTarget([{ connectionId: "c1", database: "app", schema: "audit" }], target), false);
  assert.equal(tableClipboardMatchesTarget([], target), false);
  assert.equal(tableClipboardMatchesTarget([{ connectionId: "c1", database: "app" }], null), false);
});

test("whole-row table data copy is enabled for known database types", () => {
  assert.equal(supportsWholeRowTableDataCopy("mysql"), true);
  assert.equal(supportsWholeRowTableDataCopy("postgres"), true);
  assert.equal(supportsWholeRowTableDataCopy("sqlserver"), true);
  assert.equal(supportsWholeRowTableDataCopy(undefined), false);
  assert.equal(supportsWholeRowTableDataCopy("sqlite"), true);
  assert.equal(defaultPasteTableMode("mysql"), "structure-and-data");
  assert.equal(defaultPasteTableMode(undefined), "structure-only");
  assert.equal(defaultPasteTableMode("sqlite"), "structure-and-data");
  assert.equal(pasteTableModeCopiesData("structure-and-data"), true);
  assert.equal(pasteTableModeCopiesData("data-only"), true);
  assert.equal(pasteTableModeCopiesData("structure-only"), false);
});

test("table data copy uses only writable columns for first-class databases", () => {
  const column = (name: string, extra: string | null): ColumnInfo => ({
    name,
    data_type: "int",
    is_nullable: true,
    column_default: null,
    is_primary_key: name === "id",
    extra,
    comment: null,
    numeric_precision: null,
    numeric_scale: null,
    character_maximum_length: null,
  });
  const columns = [column("id", "identity(1,1)"), column("name", null), column("full_name", "computed")];

  assert.deepEqual(tableDataCopyColumnOptions("sqlserver", columns), {
    columns: ["id", "name"],
    postgresOverridingSystemValue: false,
    sqlserverIdentityInsert: true,
  });
  assert.deepEqual(tableDataCopyColumnOptions("postgres", [{ ...columns[0], extra: "generated always as identity" }, { ...columns[1] }, { ...columns[2], extra: "generated always as (name) stored" }]), {
    columns: ["id", "name"],
    postgresOverridingSystemValue: true,
    sqlserverIdentityInsert: false,
  });
  assert.deepEqual(tableDataCopyColumnOptions("mysql", [{ ...columns[0], extra: "auto_increment" }, { ...columns[1] }, { ...columns[2], extra: "STORED GENERATED" }]), {
    columns: ["id", "name"],
    postgresOverridingSystemValue: false,
    sqlserverIdentityInsert: false,
  });
});
