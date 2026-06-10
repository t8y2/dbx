import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canEditRedisMemberDetail, clampRedisMemberDetailSheetWidth, formatRedisCommandResult, formatRedisMemberDetail, formatRedisStringValue, getRedisMemberSelectionKey, highlightRedisJsonDetail, parseRedisJsonDetail } from "../../apps/desktop/src/lib/redisValuePresentation.ts";

test("formats JSON object strings for Redis member details", () => {
  const detail = formatRedisMemberDetail('{"id":1,"name":"Ada","tags":["dbx","redis"]}');

  assert.equal(detail.format, "json");
  assert.equal(detail.rawText, '{"id":1,"name":"Ada","tags":["dbx","redis"]}');
  assert.equal(detail.text, '{\n  "id": 1,\n  "name": "Ada",\n  "tags": [\n    "dbx",\n    "redis"\n  ]\n}');
});

test("keeps plain Redis member strings unchanged", () => {
  const detail = formatRedisMemberDetail("plain long member value");

  assert.equal(detail.format, "text");
  assert.equal(detail.text, "plain long member value");
});

test("formats JSON string values without changing plain strings", () => {
  assert.equal(formatRedisStringValue('{"id":1,"name":"Ada"}'), '{\n  "id": 1,\n  "name": "Ada"\n}');
  assert.equal(formatRedisStringValue("plain redis value"), "plain redis value");
});

test("parses Redis JSON details only for object and array containers", () => {
  const objectDetail = parseRedisJsonDetail('{"id":1,"name":"Ada"}');
  assert.equal(objectDetail?.rawText, '{"id":1,"name":"Ada"}');
  assert.equal(objectDetail?.formattedText, '{\n  "id": 1,\n  "name": "Ada"\n}');
  assert.deepEqual(objectDetail?.value, { id: 1, name: "Ada" });

  assert.equal(parseRedisJsonDetail("[1,2]")?.formattedText, "[\n  1,\n  2\n]");
  assert.equal(parseRedisJsonDetail('"plain json string"'), null);
  assert.equal(parseRedisJsonDetail("123"), null);
  assert.equal(parseRedisJsonDetail("plain redis value"), null);
});

test("formats Redis command results with JSON strings expanded", () => {
  assert.equal(formatRedisCommandResult('{"balance":42,"unit":"USD"}'), '{\n  "balance": 42,\n  "unit": "USD"\n}');
  assert.equal(formatRedisCommandResult(["a", 2]), '[\n  "a",\n  2\n]');
});

test("formats non-string Redis member values as JSON", () => {
  const detail = formatRedisMemberDetail({ field: "name", value: '{"nested":true}' });

  assert.equal(detail.format, "json");
  assert.equal(detail.text, '{\n  "field": "name",\n  "value": "{\\"nested\\":true}"\n}');
});

test("builds stable Redis member selection keys from title and formatted value", () => {
  const key = getRedisMemberSelectionKey("#2", '{"id":240,"kind":"json"}');

  assert.equal(key, '#2\n{\n  "id": 240,\n  "kind": "json"\n}');
});

test("highlights formatted Redis JSON detail safely", () => {
  const html = highlightRedisJsonDetail('{"id":240,"name":"<script>","active":true,"meta":null}');

  assert.match(html, /<span class="json-key">"id":<\/span>/);
  assert.match(html, /<span class="json-number">240<\/span>/);
  assert.match(html, /<span class="json-string">"&lt;script&gt;"<\/span>/);
  assert.match(html, /<span class="json-boolean">true<\/span>/);
  assert.match(html, /<span class="json-null">null<\/span>/);
  assert.doesNotMatch(html, /<script>/);
});

test("allows editing Redis collection members except stream fields", () => {
  assert.equal(canEditRedisMemberDetail("list"), true);
  assert.equal(canEditRedisMemberDetail("hash"), true);
  assert.equal(canEditRedisMemberDetail("set"), true);
  assert.equal(canEditRedisMemberDetail("zset"), true);
  assert.equal(canEditRedisMemberDetail("stream"), false);
});

test("clamps Redis member detail sheet width to viewport and usable bounds", () => {
  assert.equal(clampRedisMemberDetailSheetWidth(200, 1200), 360);
  assert.equal(clampRedisMemberDetailSheetWidth(640, 1200), 640);
  assert.equal(clampRedisMemberDetailSheetWidth(1200, 1400), 900);
  assert.equal(clampRedisMemberDetailSheetWidth(900, 500), 468);
});
