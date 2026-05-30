import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildObjectBrowserRows,
  filterObjectBrowserRows,
  formatObjectBrowserTimestamp,
  sortObjectBrowserRows,
} from "../../apps/desktop/src/lib/objectBrowserRows.ts";

test("builds unique row ids for overloaded routines with the same visible name", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "list_pipes", object_type: "FUNCTION", schema: "dbms_pipe" },
      { name: "list_pipes", object_type: "FUNCTION", schema: "dbms_pipe" },
      { name: "create_pipe", object_type: "FUNCTION", schema: "dbms_pipe" },
    ],
    database: "highgo",
    fallbackSchema: "dbms_pipe",
    needsSchema: true,
  });

  assert.deepEqual(
    rows.map((row) => row.id),
    ["dbms_pipe:list_pipes:FUNCTION:0", "dbms_pipe:list_pipes:FUNCTION:1", "dbms_pipe:create_pipe:FUNCTION:0"],
  );
});

test("object browser search matches names, types, and comments but not schema names", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "users", object_type: "TABLE", schema: "exam_hub", comment: "account records" },
      { name: "orders", object_type: "TABLE", schema: "sales", comment: "exam invoices" },
      { name: "refresh_exam_stats", object_type: "PROCEDURE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    filterObjectBrowserRows(rows, "exam").map((row) => row.name),
    ["orders", "refresh_exam_stats"],
  );
});

test("object browser rows preserve table timestamps and sort recent updates first", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      {
        name: "users",
        object_type: "TABLE",
        schema: "public",
        created_at: "2026-05-20 09:30:00",
        updated_at: "2026-05-21 10:15:00",
      },
      {
        name: "orders",
        object_type: "TABLE",
        schema: "public",
        created_at: "2026-05-22 08:00:00",
        updated_at: "2026-05-22 08:20:00",
      },
      { name: "active_users", object_type: "VIEW", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    sortObjectBrowserRows(rows, "updated_at", "desc").map((row) => row.name),
    ["orders", "users", "active_users"],
  );
  assert.equal(formatObjectBrowserTimestamp(rows[0].created_at), "2026-05-20 09:30:00");
});

test("object browser rows mark partition-like tables when their parent table exists", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "order_data", object_type: "TABLE", schema: "public" },
      { name: "order_data_p20220802", object_type: "TABLE", schema: "public" },
      { name: "order_data_p20220803", object_type: "TABLE", schema: "public" },
      { name: "audit_p20220802", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  const parent = rows.find((row) => row.name === "order_data");
  assert.equal(parent?.partitionCount, 2);
  assert.deepEqual(
    rows.filter((row) => row.partitionParentId === parent?.id).map((row) => row.name),
    ["order_data_p20220802", "order_data_p20220803"],
  );
  assert.equal(rows.find((row) => row.name === "audit_p20220802")?.partitionParentId, undefined);
});

test("object browser rows use explicit partition metadata before name heuristics", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "events", object_type: "TABLE", schema: "public" },
      { name: "events_may", object_type: "TABLE", schema: "public", parent_schema: "public", parent_name: "events" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  const parent = rows.find((row) => row.name === "events");
  assert.equal(parent?.partitionCount, 1);
  assert.equal(rows.find((row) => row.name === "events_may")?.partitionParentId, parent?.id);
});

test("object browser timestamp display strips timezone suffixes", () => {
  assert.equal(formatObjectBrowserTimestamp("2026-05-22 10:18:24+08"), "2026-05-22 10:18:24");
  assert.equal(formatObjectBrowserTimestamp("2026-05-22 10:18:24.123456+08:00"), "2026-05-22 10:18:24");
});
