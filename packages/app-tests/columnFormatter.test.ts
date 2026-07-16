import { strict as assert } from "node:assert";
import { test } from "vitest";
import { applyColumnFormatter, buildColumnFormatterKey, getSupportedTimeZoneOptions, resolveColumnFormatter, normalizeColumnFormatter, type ColumnFormatterConfig } from "../../apps/desktop/src/lib/dataGrid/columnFormatter.ts";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import dayjs from "dayjs";

test("builds timezone options when Intl.supportedValuesOf is available", () => {
  assert.deepEqual(
    getSupportedTimeZoneOptions(
      {
        supportedValuesOf: (key) => {
          assert.equal(key, "timeZone");
          return ["Asia/Shanghai", "Europe/London"];
        },
      },
      "UTC",
    ),
    ["Asia/Shanghai", "Europe/London"],
  );
});

test("falls back when Intl.supportedValuesOf is missing", () => {
  assert.deepEqual(getSupportedTimeZoneOptions({}, "Asia/Shanghai"), ["Asia/Shanghai"]);
});

test("falls back when Intl.supportedValuesOf throws", () => {
  assert.deepEqual(
    getSupportedTimeZoneOptions(
      {
        supportedValuesOf: () => {
          throw new Error("unsupported");
        },
      },
      "Asia/Shanghai",
    ),
    ["Asia/Shanghai"],
  );
});

test("falls back when Intl.supportedValuesOf returns no timezones", () => {
  assert.deepEqual(getSupportedTimeZoneOptions({ supportedValuesOf: () => [] }, "Asia/Shanghai"), ["Asia/Shanghai"]);
});

test("uses UTC when no fallback timezone can be detected", () => {
  assert.deepEqual(getSupportedTimeZoneOptions({}, ""), ["UTC"]);
});

test("formats unix timestamps in seconds, milliseconds, and auto mode", () => {
  dayjs.extend(utc);
  dayjs.extend(timezone);
  assert.equal(dayjs.tz.guess(), "Asia/Shanghai");
  assert.equal(applyColumnFormatter(1715758200, { kind: "datetime", unit: "seconds", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: "Asia/Shanghai" }), "2024-05-15 15:30:00+08:00");
  assert.equal(applyColumnFormatter(1763103348, { kind: "datetime", unit: "seconds", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: "Asia/Shanghai" }), "2025-11-14 14:55:48+08:00");
  // British Summer Time
  assert.equal(applyColumnFormatter(1715758200, { kind: "datetime", unit: "seconds", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: "Europe/London" }), "2024-05-15 08:30:00+01:00");
  // British Standard Time
  assert.equal(applyColumnFormatter(1763103348, { kind: "datetime", unit: "seconds", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: "Europe/London" }), "2025-11-14 06:55:48+00:00");

  assert.equal(applyColumnFormatter(1715758200001, { kind: "datetime", unit: "milliseconds", pattern: "YYYY-MM-DD HH:mm:ss.SSSZ", timezone: undefined }), "2024-05-15 15:30:00.001+08:00");
  assert.equal(applyColumnFormatter(1715758200001, { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss.SSSZ", timezone: undefined }), "2024-05-15 15:30:00.001+08:00");
  assert.equal(applyColumnFormatter("1715758200001", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss.SSSZ", timezone: undefined }), "2024-05-15 15:30:00.001+08:00");
  assert.equal(applyColumnFormatter(1715758200, { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: undefined }), "2024-05-15 15:30:00+08:00");
  assert.equal(applyColumnFormatter("1715758200", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ssZ", timezone: undefined }), "2024-05-15 15:30:00+08:00");
});

test("uses the global datetime formatter only for temporal columns without a column override", () => {
  const global = { pattern: "YYYY/MM/DD HH:mm:ss", columnType: "TIMESTAMP(6)" };

  assert.deepEqual(resolveColumnFormatter(undefined, {}, global), { kind: "datetime", unit: "auto", pattern: "YYYY/MM/DD HH:mm:ss", timezone: undefined });
  assert.equal(resolveColumnFormatter(undefined, {}, { ...global, columnType: "VARCHAR2(100)" }), undefined);
  assert.deepEqual(resolveColumnFormatter({ kind: "mask", prefix: 2, suffix: 2 }, {}, global), { kind: "mask", prefix: 2, suffix: 2 });
  assert.deepEqual(resolveColumnFormatter(undefined, {}, { ...global, columnType: "DateTime64(3)" }), { kind: "datetime", unit: "auto", pattern: global.pattern, timezone: undefined });
  assert.deepEqual(resolveColumnFormatter(undefined, {}, { ...global, columnType: "datetimeoffsetn" }), { kind: "datetime", unit: "auto", pattern: global.pattern, timezone: undefined });
});

test("formats only typed temporal cells for export", async () => {
  const { formatTemporalRowsForExport } = await import("../../apps/desktop/src/lib/dataGrid/columnFormatter.ts");
  const rows = formatTemporalRowsForExport([[1, "2024-02-25T05:02:15Z", "2024-02-25T05:02:15Z", "2024-02-25T05:02:15.123456+08:00", "2024-02-25 13:02:15.987654"]], ["NUMBER", "TIMESTAMP", "VARCHAR2", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP(6)"], "YYYY/MM/DD HH:mm:ss.SSSZ");

  assert.deepEqual(rows, [[1, "2024/02/25 05:02:15.000+00:00", "2024-02-25T05:02:15Z", "2024/02/25 05:02:15.123+08:00", "2024/02/25 13:02:15.987+08:00"]]);
});

test("formats Oracle timestamp fractional precision in the data grid", () => {
  assert.equal(applyColumnFormatter("2024-02-25 13:02:15.123456", { kind: "datetime", unit: "auto", pattern: "YYYY/MM/DD HH:mm:ss.SSS", timezone: undefined }), "2024/02/25 13:02:15.123");
});

test("does not treat compact date strings as unix timestamps", () => {
  dayjs.extend(utc);
  dayjs.extend(timezone);
  assert.equal(dayjs.tz.guess(), "Asia/Shanghai");
  assert.equal(applyColumnFormatter("20260514", { kind: "datetime", unit: "auto", pattern: "YYYYMMDD", timezone: undefined }), "20260514");
  assert.equal(applyColumnFormatter("20260514", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss", timezone: undefined }), "20260514");
  assert.equal(applyColumnFormatter(20260514, { kind: "datetime", unit: "auto", pattern: "YYYYMMDD", timezone: undefined }), "20260514");
  assert.equal(applyColumnFormatter("2026-05-14T16:00:00Z", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DDTHH:mm:ssZ", timezone: undefined }), "2026-05-15T00:00:00+08:00");
  assert.equal(applyColumnFormatter("2026-05-14", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD", timezone: undefined }), "2026-05-14");
});

test("extracts simple JSON paths from object and array strings", () => {
  const payload = JSON.stringify({ user: { name: "Ada" }, items: [{ id: 7 }] });

  assert.equal(applyColumnFormatter(payload, { kind: "json-path", path: "$.user.name" }), "Ada");
  assert.equal(applyColumnFormatter(payload, { kind: "json-path", path: "$.items[0].id" }), "7");
  assert.equal(applyColumnFormatter(payload, { kind: "json-path", path: "$.missing" }), "");
});

test("masks strings while preserving prefix and suffix", () => {
  assert.equal(applyColumnFormatter("abcdef123456", { kind: "mask", prefix: 3, suffix: 2 }), "abc*******56");
  assert.equal(applyColumnFormatter("short", { kind: "mask", prefix: 3, suffix: 3 }), "*****");
});

test("falls back to normal display for nulls and invalid formatter input", () => {
  assert.equal(applyColumnFormatter(null, { kind: "datetime", unit: "auto", pattern: "YYYYMMDD", timezone: undefined }), "NULL");
  assert.equal(applyColumnFormatter("abc", { kind: "datetime", unit: "auto", pattern: "YYYYMMDD", timezone: undefined }), "abc");
  assert.equal(applyColumnFormatter("2022-01-33", { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD", timezone: undefined }), "2022-01-33");
  assert.equal(applyColumnFormatter("not json", { kind: "json-path", path: "$.a" }), "not json");
  assert.deepEqual(normalizeColumnFormatter({ kind: "datetime", unit: "invalid" }), undefined);
  assert.deepEqual(normalizeColumnFormatter({ kind: "datetime", unit: "auto", pattern: 123 }), { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss", timezone: undefined });
});

test("normalizes only supported formatter configs", () => {
  const config: ColumnFormatterConfig = { kind: "mask", prefix: 2, suffix: 4 };

  assert.deepEqual(normalizeColumnFormatter(config), config);
  assert.deepEqual(normalizeColumnFormatter({ kind: "json-path", path: "$.a[0]" }), {
    kind: "json-path",
    path: "$.a[0]",
  });
  assert.equal(normalizeColumnFormatter({ kind: "json-path", path: "a.b" }), undefined);
  assert.deepEqual(normalizeColumnFormatter({ kind: "custom-template", template: "ID-${value}" }), {
    kind: "custom-template",
    template: "ID-${value}",
  });
  assert.deepEqual(normalizeColumnFormatter({ kind: "custom-ref", formatterId: "fmt_1" }), {
    kind: "custom-ref",
    formatterId: "fmt_1",
  });
});

test("builds stable formatter keys for table columns", () => {
  assert.equal(
    buildColumnFormatterKey({
      connectionId: "conn",
      database: "db",
      schema: "public",
      tableName: "users",
      column: "created_at",
    }),
    "conn::db::public::users::created_at",
  );
});

test("applies safe custom formatter templates", () => {
  assert.equal(applyColumnFormatter("ada", { kind: "custom-template", template: "user:${value}" }), "user:ada");
  assert.equal(applyColumnFormatter("Ada", { kind: "custom-template", template: "${upper}" }), "ADA");
  assert.equal(applyColumnFormatter("Ada", { kind: "custom-template", template: "${lower}" }), "ada");
  assert.equal(applyColumnFormatter("Ada", { kind: "custom-template", template: "${length}" }), "3");
  assert.equal(applyColumnFormatter(null, { kind: "custom-template", template: "value=${value}" }), "value=NULL");
});

test("resolves saved custom formatter references", () => {
  assert.deepEqual(resolveColumnFormatter({ kind: "custom-ref", formatterId: "fmt_1" }, { fmt_1: { id: "fmt_1", name: "User label", template: "user:${value}" } }), { kind: "custom-template", template: "user:${value}" });
  assert.equal(resolveColumnFormatter({ kind: "custom-ref", formatterId: "missing" }, {}), undefined);
});
