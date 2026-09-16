import assert from "node:assert/strict";
import { test } from "vitest";

import { CELL_TRANSFORM_MAX_INPUT, CELL_TRANSFORM_MAX_OUTPUT, transformCellValue } from "../../apps/desktop/src/lib/dataGrid/cellValueTransform.ts";

test("timestamp auto-detects 10-digit values as seconds", () => {
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp" }), { ok: true, text: "2023-11-14 22:13:20", unit: "seconds" });
});

test("timestamp auto-detects 13-digit values as milliseconds", () => {
  assert.deepEqual(transformCellValue("1700000000000", { kind: "timestamp" }), { ok: true, text: "2023-11-14 22:13:20", unit: "milliseconds" });
});

test("timestamp honors an explicit unit regardless of digit count", () => {
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp", unit: "milliseconds" }), { ok: true, text: "1970-01-20 16:13:20", unit: "milliseconds" });
  assert.deepEqual(transformCellValue("1700000000000", { kind: "timestamp", unit: "seconds" }), { ok: true, text: "55840-11-08 22:13:20", unit: "seconds" });
});

test("timestamp reports ambiguousUnit when auto mode cannot pick a unit", () => {
  assert.deepEqual(transformCellValue("17000000000", { kind: "timestamp" }), { ok: false, error: "ambiguousUnit" });
  assert.deepEqual(transformCellValue("123", { kind: "timestamp" }), { ok: false, error: "ambiguousUnit" });
});

test("timestamp rejects non-integer input", () => {
  assert.deepEqual(transformCellValue("not-a-timestamp", { kind: "timestamp" }), { ok: false, error: "invalidTimestamp" });
  assert.deepEqual(transformCellValue("1700000000.5", { kind: "timestamp", unit: "seconds" }), { ok: false, error: "invalidTimestamp" });
});

test("timestamp formats in a valid timezone and defaults to UTC", () => {
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp", timezone: "Asia/Shanghai" }), { ok: true, text: "2023-11-15 06:13:20", unit: "seconds" });
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp", timezone: " UTC " }), { ok: true, text: "2023-11-14 22:13:20", unit: "seconds" });
});

test("timestamp rejects an unknown timezone", () => {
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp", timezone: "Mars/Olympus" }), { ok: false, error: "invalid" });
});

test("timestamp rejects patterns outside the supported set", () => {
  assert.deepEqual(transformCellValue("1700000000", { kind: "timestamp", pattern: "DD/MM/YYYY" }), { ok: false, error: "invalidTimestamp" });
});

test("timestamp formats with an allowed pattern", () => {
  assert.deepEqual(transformCellValue("0", { kind: "timestamp", unit: "milliseconds", pattern: "YYYY-MM-DDTHH:mm:ssZ" }), { ok: true, text: "1970-01-01T00:00:00+00:00", unit: "milliseconds" });
});

test("timestamp converts negative epochs before 1970", () => {
  assert.deepEqual(transformCellValue("-86400", { kind: "timestamp", unit: "seconds" }), { ok: true, text: "1969-12-31 00:00:00", unit: "seconds" });
  assert.deepEqual(transformCellValue("-1000000000", { kind: "timestamp" }), { ok: true, text: "1938-04-24 22:13:20", unit: "seconds" });
});

test("timestamp rejects values beyond the supported millisecond range", () => {
  assert.deepEqual(transformCellValue("8640000000000001", { kind: "timestamp", unit: "milliseconds" }), { ok: false, error: "invalidTimestamp" });
  assert.deepEqual(transformCellValue("-8640000000000001", { kind: "timestamp", unit: "milliseconds" }), { ok: false, error: "invalidTimestamp" });
  assert.deepEqual(transformCellValue("100000000000000", { kind: "timestamp", unit: "seconds" }), { ok: false, error: "invalidTimestamp" });
});

test("timestamp accepts the exact millisecond range boundary", () => {
  assert.deepEqual(transformCellValue("8640000000000000", { kind: "timestamp", unit: "milliseconds" }), { ok: true, text: "275760-09-13 00:00:00", unit: "milliseconds" });
});

test("json pretty-prints and preserves large integer literals", () => {
  const result = transformCellValue('{"id":123456789012345678901234567890,"tags":[1,2]}', { kind: "json" });
  assert.ok(result.ok);
  assert.equal(result.text, '{\n  "id": 123456789012345678901234567890,\n  "tags": [\n    1,\n    2\n  ]\n}');
  assert.equal(result.text.includes('"123456789012345678901234567890"'), false);
});

test("jsonCompact collapses whitespace while preserving source order", () => {
  assert.deepEqual(transformCellValue('{ "b" : 1, "a" : [ 1, 2 ] }', { kind: "jsonCompact" }), { ok: true, text: '{"b":1,"a":[1,2]}' });
});

test("json rejects malformed documents", () => {
  assert.deepEqual(transformCellValue('{"id":', { kind: "json" }), { ok: false, error: "invalid" });
  assert.deepEqual(transformCellValue('{"a":1} trailing', { kind: "jsonCompact" }), { ok: false, error: "invalid" });
});

test("xml reformats markup without touching text nodes", () => {
  const result = transformCellValue("<a><b>1</b><c><d/></c></a>", { kind: "xml" });
  assert.ok(result.ok);
  assert.equal(result.text, "<a>\n  <b>1</b>\n  <c>\n    <d/>\n  </c>\n</a>");
});

test("xml rejects malformed markup", () => {
  assert.deepEqual(transformCellValue("<a><b>1</b>", { kind: "xml" }), { ok: false, error: "invalid" });
  assert.deepEqual(transformCellValue("<a></b>", { kind: "xml" }), { ok: false, error: "invalid" });
});

test("base64 round-trips CJK text and emoji", () => {
  const encoded = transformCellValue("你好😀", { kind: "base64Encode" });
  assert.deepEqual(encoded, { ok: true, text: "5L2g5aW98J+YgA==" });
  const decoded = transformCellValue("5L2g5aW98J+YgA==", { kind: "base64Decode" });
  assert.deepEqual(decoded, { ok: true, text: "你好😀" });
});

test("base64Encode rejects lone surrogates instead of replacing them", () => {
  assert.deepEqual(transformCellValue("\uD800", { kind: "base64Encode" }), { ok: false, error: "invalid" });
});

test("base64Decode tolerates whitespace inside the alphabet", () => {
  assert.deepEqual(transformCellValue("5L2g\n 5aW9", { kind: "base64Decode" }), { ok: true, text: "你好" });
});

test("base64Decode rejects unpadded, url-safe, and non-UTF-8 input", () => {
  assert.deepEqual(transformCellValue("5L2g5aW", { kind: "base64Decode" }), { ok: false, error: "invalidBase64" });
  assert.deepEqual(transformCellValue("5L2g5aW-", { kind: "base64Decode" }), { ok: false, error: "invalidBase64" });
  assert.deepEqual(transformCellValue("5L2g5a_9", { kind: "base64Decode" }), { ok: false, error: "invalidBase64" });
  // "/w==" decodes to the single byte 0xFF, which is not valid UTF-8.
  assert.deepEqual(transformCellValue("/w==", { kind: "base64Decode" }), { ok: false, error: "invalidBase64" });
});

test("url encode and decode round-trip as URL components", () => {
  const source = "a b/c?x=1&y=中";
  assert.deepEqual(transformCellValue(source, { kind: "urlEncode" }), { ok: true, text: "a%20b%2Fc%3Fx%3D1%26y%3D%E4%B8%AD" });
  assert.deepEqual(transformCellValue("a%20b%2Fc%3Fx%3D1%26y%3D%E4%B8%AD", { kind: "urlDecode" }), { ok: true, text: source });
});

test("urlDecode preserves plus signs instead of mapping them to spaces", () => {
  assert.deepEqual(transformCellValue("1+1=2", { kind: "urlDecode" }), { ok: true, text: "1+1=2" });
  assert.deepEqual(transformCellValue("%2B", { kind: "urlDecode" }), { ok: true, text: "+" });
});

test("urlDecode rejects truncated percent escapes", () => {
  assert.deepEqual(transformCellValue("100%", { kind: "urlDecode" }), { ok: false, error: "invalid" });
  assert.deepEqual(transformCellValue("%E4%B8", { kind: "urlDecode" }), { ok: false, error: "invalid" });
});

test("radix converts between supported bases without prefixes in the output", () => {
  assert.deepEqual(transformCellValue("255", { kind: "radix", fromBase: 10, toBase: 16 }), { ok: true, text: "ff" });
  assert.deepEqual(transformCellValue("ff", { kind: "radix", fromBase: 16, toBase: 10 }), { ok: true, text: "255" });
  assert.deepEqual(transformCellValue("10", { kind: "radix", fromBase: 10, toBase: 2 }), { ok: true, text: "1010" });
  assert.deepEqual(transformCellValue("777", { kind: "radix", fromBase: 8, toBase: 10 }), { ok: true, text: "511" });
});

test("radix applies signs and rejects base prefixes in the input", () => {
  assert.deepEqual(transformCellValue("-ff", { kind: "radix", fromBase: 16, toBase: 10 }), { ok: true, text: "-255" });
  assert.deepEqual(transformCellValue("+255", { kind: "radix", fromBase: 10, toBase: 16 }), { ok: true, text: "ff" });
  assert.deepEqual(transformCellValue("0xff", { kind: "radix", fromBase: 16, toBase: 10 }), { ok: false, error: "invalidInteger" });
  assert.deepEqual(transformCellValue("0b101", { kind: "radix", fromBase: 2, toBase: 10 }), { ok: false, error: "invalidInteger" });
  assert.deepEqual(transformCellValue("9", { kind: "radix", fromBase: 8, toBase: 10 }), { ok: false, error: "invalidInteger" });
  assert.deepEqual(transformCellValue("256", { kind: "radix", fromBase: 10, toBase: 3 }), { ok: false, error: "invalidInteger" });
});

test("radix stays exact beyond Number.MAX_SAFE_INTEGER via BigInt", () => {
  const decimal = "123456789012345678901234567890";
  const hex = transformCellValue(decimal, { kind: "radix", fromBase: 10, toBase: 16 });
  assert.deepEqual(hex, { ok: true, text: "18ee90ff6c373e0ee4e3f0ad2" });
  const roundTrip = transformCellValue("18ee90ff6c373e0ee4e3f0ad2", { kind: "radix", fromBase: 16, toBase: 10 });
  assert.deepEqual(roundTrip, { ok: true, text: decimal });
});

test("radix enforces the integer digit cap", () => {
  assert.deepEqual(transformCellValue("0".repeat(4097), { kind: "radix", fromBase: 10, toBase: 16 }), { ok: false, error: "tooLarge" });
  assert.deepEqual(transformCellValue("0".repeat(4096), { kind: "radix", fromBase: 10, toBase: 16 }), { ok: true, text: "0" });
});

test("inputs beyond the input cap fail closed", () => {
  assert.equal(CELL_TRANSFORM_MAX_INPUT, 50_000);
  assert.deepEqual(transformCellValue("a".repeat(CELL_TRANSFORM_MAX_INPUT + 1), { kind: "base64Encode" }), { ok: false, error: "tooLarge" });
  assert.equal(transformCellValue("a".repeat(CELL_TRANSFORM_MAX_INPUT), { kind: "base64Encode" }).ok, true);
});

test("outputs beyond the output cap fail closed", () => {
  assert.equal(CELL_TRANSFORM_MAX_OUTPUT, 200_000);
  // Each CJK character expands to nine percent-escaped output characters.
  const justUnder = "中".repeat(22_222); // 199,998 output characters
  const justOver = "中".repeat(22_223); // 200,007 output characters
  assert.equal(transformCellValue(justUnder, { kind: "urlEncode" }).ok, true);
  assert.deepEqual(transformCellValue(justOver, { kind: "urlEncode" }), { ok: false, error: "tooLarge" });
});
