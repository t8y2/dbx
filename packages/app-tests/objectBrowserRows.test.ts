import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildObjectBrowserRows, filterObjectBrowserRows, formatObjectBrowserBytes, formatObjectBrowserCount, formatObjectBrowserTimestamp, sortObjectBrowserRows, summarizeObjectBrowserSearch } from "../../apps/desktop/src/lib/table/objectBrowserRows.ts";

test("builds unique row ids for overloaded routines with the same visible name", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "list_pipes", object_type: "FUNCTION", schema: "dbms_pipe", signature: "" },
      { name: "list_pipes", object_type: "FUNCTION", schema: "dbms_pipe", signature: "name text" },
      { name: "create_pipe", object_type: "FUNCTION", schema: "dbms_pipe", signature: "" },
    ],
    database: "highgo",
    fallbackSchema: "dbms_pipe",
    needsSchema: true,
  });

  assert.deepEqual(
    rows.map((row) => row.id),
    ["dbms_pipe:list_pipes:FUNCTION::0", "dbms_pipe:list_pipes:FUNCTION:name text:0", "dbms_pipe:create_pipe:FUNCTION::0"],
  );
  assert.deepEqual(
    rows.map((row) => row.displayName),
    ["list_pipes()", "list_pipes(name text)", "create_pipe()"],
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["list_pipes", "list_pipes", "create_pipe"],
  );
});

test("object browser search matches routine signatures", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "refresh_stats", object_type: "PROCEDURE", schema: "public", signature: "target_table text" },
      { name: "refresh_stats", object_type: "PROCEDURE", schema: "public", signature: "" },
      { name: "orders", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    filterObjectBrowserRows(rows, "target_table").map((row) => row.displayName),
    ["refresh_stats(target_table text)"],
  );
});

test("object browser rows normalize Oracle package body objects", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "PAYROLL", object_type: "PACKAGE", schema: "HR" },
      { name: "PAYROLL", object_type: "PACKAGE BODY", schema: "HR" },
    ],
    database: "orcl",
    fallbackSchema: "HR",
    needsSchema: true,
  });

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, type: row.type })),
    [
      { id: "HR:PAYROLL:PACKAGE:0", type: "PACKAGE" },
      { id: "HR:PAYROLL:PACKAGE_BODY:0", type: "PACKAGE_BODY" },
    ],
  );
});

test("object browser rows normalize PostgreSQL sequence objects", () => {
  const rows = buildObjectBrowserRows({
    objects: [{ name: "order_id_seq", object_type: "SEQUENCE", schema: "public" }],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, type: row.type })),
    [{ id: "public:order_id_seq:SEQUENCE:0", type: "SEQUENCE" }],
  );
});

test("object browser rows normalize space separated materialized views", () => {
  const rows = buildObjectBrowserRows({
    objects: [{ name: "user_summary_mv", object_type: "MATERIALIZED VIEW", schema: "APP" }],
    database: "dameng",
    fallbackSchema: "APP",
    needsSchema: true,
  });

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, type: row.type })),
    [{ id: "APP:user_summary_mv:MATERIALIZED_VIEW:0", type: "MATERIALIZED_VIEW" }],
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

test("object browser search supports slash-delimited regular expression queries", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "sys_user_log", object_type: "TABLE", schema: "public" },
      { name: "sys_order_archive", object_type: "TABLE", schema: "public" },
      { name: "app_user_log", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    filterObjectBrowserRows(rows, "/^sys_.*_log$/").map((row) => row.name),
    ["sys_user_log"],
  );
});

test("object browser search summary aligns all and type counts with matches", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "sales_report", object_type: "TABLE", schema: "public" },
      { name: "sales_report_view", object_type: "VIEW", schema: "public" },
      { name: "sales_report_refresh", object_type: "PROCEDURE", schema: "public" },
      { name: "users", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
  });

  const summary = summarizeObjectBrowserSearch(rows, "sales_report");

  assert.equal(summary.counts.all, 3);
  assert.equal(summary.counts.tables, 1);
  assert.equal(summary.counts.views, 1);
  assert.equal(summary.counts.procedures, 1);
  assert.equal(summary.counts.functions, 0);
});

test("object browser search summary preserves empty, case-insensitive, and regex searches", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "Sales_Report", object_type: "TABLE", schema: "public" },
      { name: "sales_archive", object_type: "VIEW", schema: "public" },
      { name: "users", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
  });

  assert.equal(summarizeObjectBrowserSearch(rows, "   ").counts.all, 3);
  assert.deepEqual(
    summarizeObjectBrowserSearch(rows, "SALES_REPORT").matchingRows.map((row) => row.name),
    ["Sales_Report"],
  );
  assert.deepEqual(
    summarizeObjectBrowserSearch(rows, "/^sales_(report|archive)$/i").matchingRows.map((row) => row.name),
    ["Sales_Report", "sales_archive"],
  );
});

test("object browser search summary scans large collections only once for every filter count", () => {
  const rowCount = 2_000;
  let nameReads = 0;
  const rows = buildObjectBrowserRows({
    objects: Array.from({ length: rowCount }, (_, index) => ({
      name: index % 2 === 0 ? `target_${index}` : `other_${index}`,
      object_type: index % 3 === 0 ? "VIEW" : "TABLE",
      schema: "public",
    })),
    database: "app",
    fallbackSchema: "public",
  });
  for (const row of rows) {
    const name = row.name;
    Object.defineProperty(row, "name", {
      configurable: true,
      get() {
        nameReads++;
        return name;
      },
    });
  }

  const summary = summarizeObjectBrowserSearch(rows, "target_");

  assert.equal(summary.counts.all, rowCount / 2);
  assert.equal(summary.counts.tables + summary.counts.views, rowCount / 2);
  assert.equal(nameReads, rowCount);
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

test("object browser rows sort estimated rows and table size with empty values last", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "empty_stats", object_type: "TABLE", schema: "public" },
      { name: "small_table", object_type: "TABLE", schema: "public" },
      { name: "large_table", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });
  rows.find((row) => row.name === "small_table")!.estimatedRows = 12;
  rows.find((row) => row.name === "large_table")!.estimatedRows = 1200;
  rows.find((row) => row.name === "small_table")!.totalBytes = 4096;
  rows.find((row) => row.name === "large_table")!.totalBytes = 8192;

  assert.deepEqual(
    sortObjectBrowserRows(rows, "estimatedRows", "desc").map((row) => row.name),
    ["large_table", "small_table", "empty_stats"],
  );
  assert.deepEqual(
    sortObjectBrowserRows(rows, "totalBytes", "asc").map((row) => row.name),
    ["small_table", "large_table", "empty_stats"],
  );
});

test("object browser formats statistics for compact table cells", () => {
  assert.equal(formatObjectBrowserCount(1234567), "1,234,567");
  assert.equal(formatObjectBrowserBytes(1536), "1.50 KB");
  assert.equal(formatObjectBrowserBytes(null), "");
});

test("object browser name sort keeps natural name order like the sidebar tree", () => {
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "chat_staff", object_type: "TABLE", schema: "public" },
      { name: "chat_staff_his", object_type: "TABLE", schema: "public" },
      { name: "staff", object_type: "TABLE", schema: "public" },
      { name: "staff_his", object_type: "TABLE", schema: "public" },
    ],
    database: "app",
    fallbackSchema: "public",
    needsSchema: true,
  });

  assert.deepEqual(
    sortObjectBrowserRows(rows, "name", "asc").map((row) => row.name),
    ["chat_staff", "chat_staff_his", "staff", "staff_his"],
  );
});

test("object browser name sort does not relocate prefixed business tables by suffix", () => {
  // Mirrors the sidebar regression test from "keep tables sorted by visible
  // name" — both sides must list tables identically (issue #3604).
  const rows = buildObjectBrowserRows({
    objects: [
      { name: "YonSuite_CurrentStock", object_type: "TABLE", schema: "dbo" },
      { name: "CurrentStock", object_type: "TABLE", schema: "dbo" },
      { name: "YonSuite_LocationStock", object_type: "TABLE", schema: "dbo" },
    ],
    database: "app",
    fallbackSchema: "dbo",
    needsSchema: true,
  });

  assert.deepEqual(
    sortObjectBrowserRows(rows, "name", "asc").map((row) => row.name),
    ["CurrentStock", "YonSuite_CurrentStock", "YonSuite_LocationStock"],
  );
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

  const partitionSummary = summarizeObjectBrowserSearch(rows, "p20220803");
  assert.deepEqual(
    partitionSummary.matchingRows.map((row) => row.name),
    ["order_data_p20220803"],
  );
  assert.equal(partitionSummary.counts.all, 1);
  assert.equal(partitionSummary.matchingRows[0].partitionParentId, parent?.id);
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
