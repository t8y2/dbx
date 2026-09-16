import { describe, it, expect } from "vitest";
import { decodeJsonUnicodeEscapes, formatJsonSource, isLosslessJsonNumber, mapDisplayToRaw, parseJsonPreservingLargeNumbers, safeJsonFormat, stringifyJsonPreservingLargeNumbers } from "../safeJsonFormat";

describe("safeJsonFormat", () => {
  it("preserves large integers exceeding MAX_SAFE_INTEGER", () => {
    const input = '{"id":87712409002717401}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": 87712409002717401\n}');
  });

  it("preserves negative large integers exceeding MIN_SAFE_INTEGER", () => {
    const input = '{"value":-87712409002717401}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "value": -87712409002717401\n}');
  });

  it("preserves multiple large integers in the same JSON", () => {
    const input = '{"a":87712409002717401,"b":9007199254740992}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "a": 87712409002717401,\n  "b": 9007199254740992\n}');
  });

  it("does not modify integers within MAX_SAFE_INTEGER", () => {
    const input = '{"id":12345}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": 12345\n}');
  });

  it("does not modify integers exactly at MAX_SAFE_INTEGER", () => {
    const input = `{"id":${Number.MAX_SAFE_INTEGER}}`;
    const result = safeJsonFormat(input, 2);
    expect(result).toBe(`{\n  "id": ${Number.MAX_SAFE_INTEGER}\n}`);
  });

  it("preserves floating point numbers with large integer parts", () => {
    const input = '{"value":87712409002717401.5}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "value": 87712409002717401.5\n}');
  });

  it("compacts JSON without indent", () => {
    const input = '{\n  "id":  87712409002717401\n}';
    const result = safeJsonFormat(input);
    expect(result).toBe('{"id":87712409002717401}');
  });

  it("preserves large integers in nested JSON", () => {
    const input = '{"data":{"id":87712409002717401}}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "data": {\n    "id": 87712409002717401\n  }\n}');
  });

  it("preserves large integers in arrays", () => {
    const input = '{"ids":[87712409002717401,87712409002717402]}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "ids": [\n    87712409002717401,\n    87712409002717402\n  ]\n}');
  });

  it("handles string values that look like numbers", () => {
    const input = '{"id":"87712409002717401"}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": "87712409002717401"\n}');
  });

  it("does not replace large digit sequences inside strings", () => {
    const input = '{"text":"value 87712409002717401, unchanged"}';
    expect(safeJsonFormat(input, 2)).toBe('{\n  "text": "value 87712409002717401, unchanged"\n}');
  });

  it("parses large integers as lossless numeric values", () => {
    const parsed = parseJsonPreservingLargeNumbers('{"companyId":518400931654815740,"safe":42}') as Record<string, unknown>;
    expect(isLosslessJsonNumber(parsed.companyId)).toBe(true);
    expect(isLosslessJsonNumber(parsed.companyId) ? parsed.companyId.raw : null).toBe("518400931654815740");
    expect(parsed.safe).toBe(42);
  });

  it("preserves fractional and exponent literals that Number would round or overflow", () => {
    const input = '{"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20,"overflow":1e999}';
    const parsed = parseJsonPreservingLargeNumbers(input) as Record<string, unknown>;

    expect(isLosslessJsonNumber(parsed.fraction) ? parsed.fraction.raw : null).toBe("0.123456789012345678901234");
    expect(isLosslessJsonNumber(parsed.scientific) ? parsed.scientific.raw : null).toBe("1.234567890123456789e20");
    expect(isLosslessJsonNumber(parsed.overflow) ? parsed.overflow.raw : null).toBe("1e999");
    expect(safeJsonFormat(input, 2)).toContain("0.123456789012345678901234");
    expect(safeJsonFormat(input, 2)).toContain("1.234567890123456789e20");
    expect(safeJsonFormat(input, 2)).toContain("1e999");
  });

  it("stringifies parsed lossless numbers back to numeric JSON tokens", () => {
    const parsed = parseJsonPreservingLargeNumbers('{"id":2018551659033767937,"stringId":"2018551659033767937"}');
    expect(stringifyJsonPreservingLargeNumbers(parsed)).toBe('{"id":2018551659033767937,"stringId":"2018551659033767937"}');
  });
});

describe("formatJsonSource", () => {
  it("minifies by removing only insignificant whitespace", () => {
    const input = `{
      "name": "Ada",
      "items": [1, 2, 3]
    }`;
    expect(formatJsonSource(input)).toBe('{"name":"Ada","items":[1,2,3]}');
  });

  it("pretty-prints with the requested indent while keeping source tokens", () => {
    expect(formatJsonSource('{"role":"reader","role":"writer"}', 2)).toBe(`{
  "role": "reader",
  "role": "writer"
}`);
  });

  it("preserves duplicate object members when minifying", () => {
    const pretty = `{
  "role": "reader",
  "role": "writer"
}`;
    expect(formatJsonSource(pretty)).toBe('{"role":"reader","role":"writer"}');
  });

  it("preserves key order when duplicate members are mixed with other keys", () => {
    const input = '{"a":1,"role":"reader","b":2,"role":"writer","c":3}';
    expect(formatJsonSource(input)).toBe(input);
    expect(formatJsonSource(input, 2)).toBe(`{
  "a": 1,
  "role": "reader",
  "b": 2,
  "role": "writer",
  "c": 3
}`);
  });

  it("preserves large and high-precision number literals", () => {
    const compact = '{"id":87712409002717401,"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20}';
    const pretty = `{
  "id": 87712409002717401,
  "fraction": 0.123456789012345678901234,
  "scientific": 1.234567890123456789e20
}`;

    expect(formatJsonSource(pretty)).toBe(compact);
    expect(formatJsonSource(compact, 2)).toBe(pretty);
  });

  it("preserves string escape sequences and does not rewrite them", () => {
    const input = '{"path":"C:\\\\Users\\\\path","quote":"say \\"hi\\"","unicode":"\\u4e2d"}';
    expect(formatJsonSource(input)).toBe(input);
  });

  it("rejects invalid JSON", () => {
    expect(() => formatJsonSource('{"name": }')).toThrow(SyntaxError);
    expect(() => formatJsonSource('{"a":1,}')).toThrow(SyntaxError);
    expect(() => formatJsonSource('{"a":1} trailing')).toThrow(SyntaxError);
  });
});

describe("decodeJsonUnicodeEscapes", () => {
  it("decodes non-ASCII escapes in both keys and values", () => {
    const input = '{"\\u59d3\\u540d":"\\u5f20\\u4e09"}';
    expect(decodeJsonUnicodeEscapes(input)).toBe('{"姓名":"张三"}');
  });

  it("combines surrogate pairs into a single code point", () => {
    expect(decodeJsonUnicodeEscapes('{"e":"\\ud83d\\ude00"}')).toBe('{"e":"😀"}');
  });

  it("keeps ASCII control escapes verbatim so the output stays valid JSON", () => {
    const input = '{"a":"\\u0000\\u000a\\u005f"}';
    expect(decodeJsonUnicodeEscapes(input)).toBe(input);
  });

  it("keeps an escaped-backslash literal \\uXXXX un-decoded", () => {
    // JSON source `"\\u5f20"` has content `张` (backslash + "u5f20"), not 张.
    const input = '{"text":"\\\\u5f20"}';
    expect(decodeJsonUnicodeEscapes(input)).toBe(input);
  });

  it("decodes a real escape that follows an escaped backslash", () => {
    // JSON source `"\\张"` has content `\` + 张; the backslash stays escaped.
    const input = '{"a":"\\\\\\u5f20"}';
    expect(decodeJsonUnicodeEscapes(input)).toBe('{"a":"\\\\张"}');
  });

  it("keeps unpaired surrogate escapes verbatim", () => {
    expect(decodeJsonUnicodeEscapes('{"a":"\\ud83d"}')).toBe('{"a":"\\ud83d"}');
    expect(decodeJsonUnicodeEscapes('{"a":"\\ude00"}')).toBe('{"a":"\\ude00"}');
  });

  it("is a no-op on literal UTF-8 and preserves structure byte-for-byte", () => {
    const input = '{\n  "name": "张三",\n  "n": 9007199254740992,\n  "b": [true, null]\n}';
    expect(decodeJsonUnicodeEscapes(input)).toBe(input);
  });

  it("leaves the source-preserving formatter contract untouched", () => {
    // formatJsonSource still preserves escapes by default; decode is opt-in.
    const escaped = '{"name":"\\u5f20\\u4e09"}';
    expect(formatJsonSource(escaped)).toBe(escaped);
    expect(decodeJsonUnicodeEscapes(escaped)).toBe('{"name":"张三"}');
  });

  it("escaped quote then unicode escape inside a string", () => {
    const raw = '{"v":"say \\"\\u5f20"}';
    expect(decodeJsonUnicodeEscapes(raw)).toBe('{"v":"say \\"张"}');
  });

  it("escaped backslash then unicode escape inside a string", () => {
    const raw = '{"v":"say \\\\\\u5f20"}';
    expect(decodeJsonUnicodeEscapes(raw)).toBe('{"v":"say \\\\张"}');
  });

  it("escaped quote inside a string token does not terminate the token", () => {
    const raw = '{"a":"x\\"y\\u4e2d","b":1}';
    expect(decodeJsonUnicodeEscapes(raw)).toBe('{"a":"x\\"y中","b":1}');
  });

  it("reviewer scenario: escaped backslash + escaped quote before a unicode escape", () => {
    const raw = '{"v":"say \\\\\\"\\u5f20"}';
    expect(decodeJsonUnicodeEscapes(raw)).toBe('{"v":"say \\\\\\"张"}');
  });
});

describe("mapDisplayToRaw", () => {
  it("returns the raw source unchanged when the draft equals the decoded baseline", () => {
    const raw = '{"name":"\\u5f20\\u4e09"}';
    expect(mapDisplayToRaw(raw, decodeJsonUnicodeEscapes(raw))).toBe(raw);
  });

  it("preserves untouched escapes when editing a sibling field (save-path core case)", () => {
    const raw = '{"name":"\\u5f20","age":30}';
    // decoded baseline: {"name":"张","age":30}; user edits age 30 -> 31
    const current = '{"name":"张","age":31}';
    const mapped = mapDisplayToRaw(raw, current);
    expect(mapped).toBe('{"name":"\\u5f20","age":31}');
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(current);
  });

  it("preserves untouched escapes in a multi-region edit (change only b)", () => {
    const raw = '{"a":"\\u5f20","b":"\\u4e2d"}';
    const edited = '{"a":"张","b":"文"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"a":"\\u5f20","b":"文"}');
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });

  it("keeps a structural insert (new key) verbatim", () => {
    const raw = '{"a":"\\u5f20"}';
    const edited = '{"a":"张","b":1}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"a":"\\u5f20","b":1}');
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });

  it("keeps JSON escape sequences typed in decoded mode verbatim so value semantics survive", () => {
    // Decoded mode only inlines unicode escapes; an inserted `\\` is already the
    // JSON source the user wants (value h\i, one literal backslash) and must not
    // be re-escaped into h\\i (two literal backslashes) on the way to raw.
    const raw = '{"v":"hi"}';
    const edited = '{"v":"h\\\\i"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"v":"h\\\\i"}');
    expect(JSON.parse(mapped)).toEqual({ v: "h\\i" });
    expect(formatJsonSource(mapped)).toBe(mapped);
  });

  it("keeps an escaped quote typed in decoded mode verbatim", () => {
    const raw = '{"v":"a"}';
    const edited = '{"v":"a \\"b"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"v":"a \\"b"}');
    expect(JSON.parse(mapped)).toEqual({ v: 'a "b' });
  });

  it("keeps a control escape typed in decoded mode verbatim", () => {
    const raw = '{"v":"a"}';
    const edited = '{"v":"a\\nb"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"v":"a\\nb"}');
    expect(JSON.parse(mapped)).toEqual({ v: "a\nb" });
  });

  it('save-path regression: decoded edit with \\\\, \\" and \\n keeps identical JSON semantics', () => {
    // Open {"name":"张","v":"a"} in decoded mode, then edit v to a value that
    // contains an escaped backslash, an escaped quote, and an escaped newline.
    const raw = '{"name":"\\u5f20","v":"a"}';
    const edited = '{"name":"张","v":"a\\\\b \\"c\\nd"}';
    const mapped = mapDisplayToRaw(raw, edited);
    // The untouched name escape survives; the v value keeps the user's exact JSON source.
    expect(mapped).toBe('{"name":"\\u5f20","v":"a\\\\b \\"c\\nd"}');
    // Identical value semantics between the decoded draft and the bytes that save.
    expect(JSON.parse(mapped)).toEqual(JSON.parse(edited));
    // And decoding the stored bytes reproduces the decoded draft exactly.
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });

  it("round-trips surrogate pairs and preserves their escapes", () => {
    const raw = '{"e":"\\ud83d\\ude00"}';
    const baseline = decodeJsonUnicodeEscapes(raw); // {"e":"😀"}
    expect(mapDisplayToRaw(raw, baseline)).toBe(raw);
    const edited = '{"e":"x😀y"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"e":"x\\ud83d\\ude00y"}');
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });

  it("keeps surrogate pairs intact when replacing an escaped emoji", () => {
    const raw = '{"e":"\\ud83d\\ude00"}';
    const edited = '{"e":"😁"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe(edited);
    expect(JSON.parse(mapped)).toEqual({ e: "😁" });
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });

  it("open+save without edits keeps the exact stored text (bytes preserved)", () => {
    const raw = '{"name":"\\u5f20","nested":{"list":[1,2],"note":"\\u4e2d"}}';
    expect(formatJsonSource(mapDisplayToRaw(raw, decodeJsonUnicodeEscapes(raw)))).toBe(formatJsonSource(raw));
  });

  it("handles a full value replacement in decoded mode", () => {
    const raw = '{"name":"\\u5f20"}';
    const edited = '{"name":"李四"}';
    const mapped = mapDisplayToRaw(raw, edited);
    expect(mapped).toBe('{"name":"李四"}');
    expect(decodeJsonUnicodeEscapes(mapped)).toBe(edited);
  });
});
