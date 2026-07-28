import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isLosslessJsonNumber } from "../../apps/desktop/src/lib/common/safeJsonFormat.ts";
import {
  canRenderRedisValueFormat,
  canEditRedisMemberDetail,
  clampRedisMemberDetailSheetWidth,
  formatRedisCommandResult,
  formatRedisMemberDetail,
  formatRedisStringValue,
  getRedisMemberSelectionKey,
  highlightRedisJsonDetail,
  parseRedisJsonDetail,
  preferredRedisValueFormat,
  redisClipboardSafeText,
  redisMemberCopyText,
  redisValueCopyText,
} from "../../apps/desktop/src/lib/redis/redisValuePresentation.ts";

function blobFromText(value: string) {
  return {
    raw_base64: Buffer.from(value, "utf8").toString("base64"),
    encoding: "utf8" as const,
  };
}

test("keeps JSON-like strings as raw text in Redis member details", () => {
  const detail = formatRedisMemberDetail('{"id":1,"name":"Ada","tags":["dbx","redis"]}');

  assert.equal(detail.format, "text");
  assert.equal(detail.rawText, '{"id":1,"name":"Ada","tags":["dbx","redis"]}');
  assert.equal(detail.text, '{"id":1,"name":"Ada","tags":["dbx","redis"]}');
});

test("keeps plain Redis member strings unchanged", () => {
  const detail = formatRedisMemberDetail("plain long member value");

  assert.equal(detail.format, "text");
  assert.equal(detail.rawLabel, "ASCII");
  assert.equal(detail.text, "plain long member value");
  assert.deepEqual(detail.availableFormats, ["utf8", "ascii", "binary", "hex", "base64"]);
});

test("keeps normal text whitespace and unicode unchanged for Redis clipboard output", () => {
  assert.equal(redisClipboardSafeText("line 1\nline 2\t中文"), "line 1\nline 2\t中文");
});

test("escapes clipboard-unsafe controls in Redis member copies without truncating the suffix", () => {
  const serialized = 'o:\\28:"JobMessage":1:{s:7:"payload";s:11:"before\x00after";}';

  assert.equal(redisMemberCopyText(blobFromText(serialized)), 'o:\\28:"JobMessage":1:{s:7:"payload";s:11:"before\\x00after";}');
});

test("formats JSON string values without changing plain strings", () => {
  assert.equal(formatRedisStringValue('{"id":1,"name":"Ada"}'), '{\n  "id": 1,\n  "name": "Ada"\n}');
  assert.equal(formatRedisStringValue("plain redis value"), "plain redis value");
});

test("parses Redis JSON details for any valid JSON payload", () => {
  const objectDetail = parseRedisJsonDetail('{"id":1,"name":"Ada"}');
  assert.equal(objectDetail?.rawText, '{"id":1,"name":"Ada"}');
  assert.equal(objectDetail?.formattedText, '{\n  "id": 1,\n  "name": "Ada"\n}');
  assert.deepEqual(objectDetail?.value, { id: 1, name: "Ada" });

  assert.equal(parseRedisJsonDetail("[1,2]")?.formattedText, "[\n  1,\n  2\n]");
  assert.equal(parseRedisJsonDetail('"plain json string"')?.formattedText, '"plain json string"');
  assert.equal(parseRedisJsonDetail("123")?.formattedText, "123");
  assert.equal(parseRedisJsonDetail("plain redis value"), null);
});

test("preserves large Redis JSON integers in formatted and tree values", () => {
  const detail = parseRedisJsonDetail('{"companyId":518400931654815740,"nested":[-9007199254740992]}');

  assert.equal(detail?.formattedText, '{\n  "companyId": 518400931654815740,\n  "nested": [\n    -9007199254740992\n  ]\n}');
  const value = detail?.value as { companyId?: unknown; nested?: unknown[] };
  assert.equal(isLosslessJsonNumber(value.companyId) ? value.companyId.raw : null, "518400931654815740");
  assert.equal(isLosslessJsonNumber(value.nested?.[0]) ? value.nested[0].raw : null, "-9007199254740992");
});

test("string/blob formats stay text-oriented and binary-first where needed", () => {
  const jsonLikeTextDetail = formatRedisMemberDetail(blobFromText('{"name":"Ada"}'));
  assert.equal(jsonLikeTextDetail.rawLabel, "ASCII");
  assert.deepEqual(jsonLikeTextDetail.availableFormats, ["utf8", "ascii", "binary", "hex", "base64"]);
  assert.equal(jsonLikeTextDetail.defaultFormat, "utf8");
  assert.equal(jsonLikeTextDetail.utf8Text, '{"name":"Ada"}');
  assert.equal(jsonLikeTextDetail.asciiText, '{"name":"Ada"}');
  assert.equal(jsonLikeTextDetail.binaryText, "0111101100100010011011100110000101101101011001010010001000111010001000100100000101100100011000010010001001111101");
  assert.equal(jsonLikeTextDetail.rawText, '{"name":"Ada"}');

  const utf8Detail = formatRedisMemberDetail({
    raw_base64: Buffer.from("你好", "utf8").toString("base64"),
    encoding: "utf8" as const,
  });
  assert.equal(utf8Detail.rawLabel, "UTF-8");
  assert.deepEqual(utf8Detail.availableFormats, ["utf8", "ascii", "binary", "hex", "base64"]);
  assert.equal(utf8Detail.defaultFormat, "utf8");
  assert.equal(utf8Detail.utf8Text, "你好");
  assert.equal(utf8Detail.asciiText, "\\xe4\\xbd\\xa0\\xe5\\xa5\\xbd");
  assert.equal(utf8Detail.binaryText, "111001001011110110100000111001011010010110111101");
  assert.equal(utf8Detail.rawText, "你好");

  const binaryDetail = formatRedisMemberDetail({
    raw_base64: Buffer.from([0xac, 0xed, 0x00, 0x05]).toString("base64"),
    encoding: "binary" as const,
  });
  assert.equal(binaryDetail.rawLabel, "Binary");
  assert.deepEqual(binaryDetail.availableFormats, ["hex", "binary", "base64"]);
  assert.equal(binaryDetail.defaultFormat, "hex");
  assert.equal(binaryDetail.utf8Text, new TextDecoder("utf-8").decode(Uint8Array.from([0xac, 0xed, 0x00, 0x05])));
  assert.equal(binaryDetail.binaryText, "10101100111011010000000000000101");
});

test("detects Java-serialized payloads as a dedicated view", () => {
  const javaSerializedString = formatRedisMemberDetail({
    raw_base64: "rO0ABXQACHNvbWV0ZXh0",
    encoding: "binary" as const,
  });
  assert.deepEqual(javaSerializedString.availableFormats, ["javaserialize", "binary", "hex", "base64"]);
  assert.equal(javaSerializedString.defaultFormat, "javaserialize");
  assert.equal(javaSerializedString.javaSerialized?.formattedText, '"sometext"');

  const javaSerializedMap = formatRedisMemberDetail({
    raw_base64:
      "rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcAUHsMEzFmDRAwACRgAKbG9hZEZhY3RvckkACXRocmVzaG9sZHhwP0AAAAAAAAx3CAAAABAAAAACdAADYmFydAADYmF6dAADZm9vc3IAEWphdmEubGFuZy5JbnRlZ2VyEuKgpPeBhzgCAAFJAAV2YWx1ZXhyABBqYXZhLmxhbmcuTnVtYmVyhqyVHQuU4IsCAAB4cAAAAHt4",
    encoding: "binary" as const,
  });
  assert.equal((javaSerializedMap.javaSerialized?.value as { $class?: string }).$class, "java.util.HashMap");
  assert.equal(
    ((javaSerializedMap.javaSerialized?.value as { obj?: { bar?: string } }).obj ?? {}).bar,
    "baz",
  );

  const plainText = formatRedisMemberDetail(blobFromText("Ada"));
  assert.equal(canRenderRedisValueFormat(plainText, "json"), false);
  assert.equal(canRenderRedisValueFormat(plainText, "javaserialize"), false);
  assert.equal(canRenderRedisValueFormat(plainText, "utf8"), true);

  assert.equal(canRenderRedisValueFormat(javaSerializedMap, "javaserialize"), true);
});

test("normalizes self-referential Java maps without recursing forever", () => {
  const detail = formatRedisMemberDetail({
    raw_base64: "rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcAUH2sHDFmDRAwACRgAKbG9hZEZhY3RvckkACXRocmVzaG9sZHhwP0AAAAAAAAx3CAAAABAAAAABdAAEc2VsZnEAfgABeA==",
    encoding: "binary" as const,
  });

  const normalized = detail.javaSerialized?.value as {
    $id?: string;
    map?: { $entries?: Array<{ key?: string; value?: { $ref?: string } }> };
    obj?: { self?: { $ref?: string } };
  };

  assert.equal(normalized.$id, "#1");
  assert.equal(normalized.map?.$entries?.[0]?.key, "self");
  assert.equal(normalized.map?.$entries?.[0]?.value?.$ref, "#1");
  assert.equal(normalized.obj?.self?.$ref, "#1");
});

test("only payload views opt into JSON text formatting", () => {
  const identityDetail = formatRedisMemberDetail(blobFromText('{"name":"Ada"}'));
  assert.deepEqual(identityDetail.availableFormats, ["utf8", "ascii", "binary", "hex", "base64"]);
  assert.equal(identityDetail.json, undefined);

  const payloadDetail = formatRedisMemberDetail(blobFromText('{"name":"Ada"}'), { allowJsonText: true });
  assert.equal(payloadDetail.rawLabel, "ASCII");
  assert.deepEqual(payloadDetail.availableFormats, ["utf8", "ascii", "binary", "json", "hex", "base64"]);
  assert.equal(payloadDetail.defaultFormat, "utf8");
  assert.equal(payloadDetail.json?.formattedText, '{\n  "name": "Ada"\n}');
});

test("reuses only safe default formats for editable text values", () => {
  const textBlob = blobFromText("Ada");
  assert.equal(preferredRedisValueFormat(textBlob, "hex"), "utf8");
  assert.equal(preferredRedisValueFormat(textBlob, "base64"), "utf8");
  assert.equal(preferredRedisValueFormat(textBlob, "binary"), "utf8");

  const jsonTextBlob = blobFromText('{"name":"Ada"}');
  assert.equal(preferredRedisValueFormat(jsonTextBlob, "json", { allowJsonText: true }), "json");

  const binaryBlob = {
    raw_base64: Buffer.from([0xac, 0xed, 0x00, 0x05]).toString("base64"),
    encoding: "binary" as const,
  };
  assert.equal(preferredRedisValueFormat(binaryBlob, "base64"), "base64");
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

test("builds stable Redis member selection keys from title and raw value identity", () => {
  const key = getRedisMemberSelectionKey("#2", '{"id":240,"kind":"json"}');

  assert.equal(key, '#2\n{"id":240,"kind":"json"}');
});

test("lets selection keys disambiguate duplicate stream fields", () => {
  const first = getRedisMemberSelectionKey("event", "login", "stream:1714470000000-0:0");
  const second = getRedisMemberSelectionKey("event", "login", "stream:1714470000000-0:1");

  assert.notEqual(first, second);
});

test("copies binary members as escaped raw bytes instead of bitstrings", () => {
  const binaryBlob = {
    raw_base64: Buffer.from([0xac, 0xed, 0x00, 0x05]).toString("base64"),
    encoding: "binary" as const,
  };

  assert.equal(redisMemberCopyText(binaryBlob), "\\xac\\xed\\x00\\x05");
});

test("copies collection values as readable content instead of blob transport objects", () => {
  const value = {
    key_display: "users",
    key_raw: "users",
    ttl: -1,
    redis_type: "hash",
    data: {
      kind: "hash" as const,
      items: [{ field: blobFromText("name"), value: blobFromText("Ada") }],
      total: 1,
    },
  };

  assert.equal(redisValueCopyText(value), '[\n  {\n    "field": "name",\n    "value": "Ada"\n  }\n]');
});

test("keeps whole-key JSON copies JSON-escaped when members contain NUL", () => {
  const value = {
    key_display: "users",
    key_raw: "users",
    ttl: -1,
    redis_type: "list",
    data: {
      kind: "list" as const,
      items: [{ value: blobFromText("before\x00after") }],
      total: 1,
    },
  };

  assert.equal(redisValueCopyText(value), '[\n  "before\\u0000after"\n]');
});

test("copies stream entries without collapsing repeated field names", () => {
  const value = {
    key_display: "events",
    key_raw: "events",
    ttl: -1,
    redis_type: "stream",
    data: {
      kind: "stream" as const,
      entries: [
        {
          id: "1728123456789-0",
          fields: [
            { field: "event", value: "login" },
            { field: "event", value: "logout" },
            { field: "user_id", value: "42" },
          ],
        },
      ],
    },
  };

  assert.equal(
    redisValueCopyText(value),
    '[\n  {\n    "id": "1728123456789-0",\n    "fields": [\n      {\n        "field": "event",\n        "value": "login"\n      },\n      {\n        "field": "event",\n        "value": "logout"\n      },\n      {\n        "field": "user_id",\n        "value": "42"\n      }\n    ]\n  }\n]',
  );
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
