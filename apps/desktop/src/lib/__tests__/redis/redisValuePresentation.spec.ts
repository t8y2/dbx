import { describe, expect, it } from "vitest";

import {
  canRenderRedisValueFormat,
  formatRedisMemberDetail,
  formatRedisStringValue,
  getRedisMemberSelectionKey,
  normalizeRedisJsonDraft,
  preferredRedisValueFormat,
  redisClipboardSafeText,
  redisJsonValueText,
  redisMemberCopyText,
  redisValueCopyText,
  redisValuePreview,
  redisValueSize,
  sanitizeRedisDisplayText,
} from "@/lib/redis/redisValuePresentation";

describe("redisValuePresentation", () => {
  it("strips control bytes from display without mutating raw member text", () => {
    const raw = "send_message_to_esb\x06\x16\x06\x16send_message_to_esb";

    const detail = formatRedisMemberDetail(raw);

    expect(detail.text).toBe("send_message_to_esbsend_message_to_esb");
    expect(detail.rawText).toBe(raw);
  });

  it("preserves common whitespace in display text", () => {
    expect(sanitizeRedisDisplayText("line1\nline2\tvalue\r\n")).toBe("line1\nline2\tvalue\r\n");
  });

  it("escapes clipboard-unsafe controls without changing normal UTF-8 whitespace", () => {
    expect(redisClipboardSafeText("普通文本\n下一行\t值\x00\x06\u0085结束")).toBe("普通文本\n下一行\t值\\x00\\x06\\x85结束");
  });

  it("strips utf8 c1 control bytes for display", () => {
    expect(sanitizeRedisDisplayText("before\u0085after")).toBe("beforeafter");
  });

  it("uses raw member text for selection keys", () => {
    const raw = "send_message_to_esb\x06\x16";

    expect(getRedisMemberSelectionKey("member", raw)).toBe(`member\n${raw}`);
  });

  it("copies the complete Redis member when UTF-8 text contains NUL", () => {
    expect(redisMemberCopyText("before\x00after")).toBe("before\\x00after");
  });

  it("can disambiguate duplicate stream fields with an explicit identity", () => {
    expect(getRedisMemberSelectionKey("event", "login", "stream:1:0")).not.toBe(getRedisMemberSelectionKey("event", "login", "stream:1:1"));
  });

  it("formats string values for display without changing plain text", () => {
    expect(formatRedisStringValue("plain-text")).toBe("plain-text");
  });

  it("normalizes valid JSON drafts into compact Redis values", () => {
    expect(
      normalizeRedisJsonDraft(`
        {
          "name": "Ada",
          "items": [1, 2, 3]
        }
      `),
    ).toEqual({ ok: true, compactText: '{"name":"Ada","items":[1,2,3]}' });
  });

  it("returns an invalid result instead of throwing for malformed JSON drafts", () => {
    expect(normalizeRedisJsonDraft('{"name": }')).toEqual({ ok: false, error: "invalid_json" });
  });

  it("keeps lossless large and high-precision numbers when normalizing drafts", () => {
    const compact = '{"id":87712409002717401,"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20}';
    const formatted = `{
      "id": 87712409002717401,
      "fraction": 0.123456789012345678901234,
      "scientific": 1.234567890123456789e20
    }`;

    expect(normalizeRedisJsonDraft(formatted)).toEqual({ ok: true, compactText: compact });
  });

  // Reviewer fixture: Redis string/hash values are raw text, so open+save must
  // only strip insignificant whitespace and must keep both "role" members.
  const DUPLICATE_MEMBER_COMPACT = '{"role":"reader","role":"writer"}';
  const DUPLICATE_MEMBER_PRETTY = `{
  "role": "reader",
  "role": "writer"
}`;

  it("string JSON editor open+save keeps duplicate object members", () => {
    // Open string key JSON view → pretty baseline from raw Redis text.
    const stringDetail = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(stringDetail.json).toBeDefined();
    expect(stringDetail.json?.rawText).toBe(DUPLICATE_MEMBER_COMPACT);
    expect(stringDetail.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Save path compact-writes the editor draft (pretty baseline, no user edit).
    expect(normalizeRedisJsonDraft(stringDetail.json!.formattedText)).toEqual({
      ok: true,
      compactText: DUPLICATE_MEMBER_COMPACT,
    });
    // Re-saving an already-compact draft must also keep both members.
    expect(normalizeRedisJsonDraft(DUPLICATE_MEMBER_COMPACT)).toEqual({
      ok: true,
      compactText: DUPLICATE_MEMBER_COMPACT,
    });
  });

  it("hash field JSON editor open+save keeps duplicate object members", () => {
    // Hash fields reuse the same presentation/normalize helpers as string keys.
    const hashFieldDetail = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(hashFieldDetail.availableFormats).toContain("json");
    expect(hashFieldDetail.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Hash saveMemberEdit compact-writes through normalizeRedisJsonDraft.
    expect(normalizeRedisJsonDraft(hashFieldDetail.json!.formattedText)).toEqual({
      ok: true,
      compactText: DUPLICATE_MEMBER_COMPACT,
    });
    expect(normalizeRedisJsonDraft(DUPLICATE_MEMBER_PRETTY)).toEqual({
      ok: true,
      compactText: DUPLICATE_MEMBER_COMPACT,
    });
  });

  it("keeps native RedisJSON source text lossless for copy, preview, and size", () => {
    const rawText = '{"id":2326645729978441729,"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20}';
    const value = {
      key_display: "json:profile",
      key_raw: "json:profile",
      ttl: -1,
      redis_type: "ReJSON-RL",
      data: { kind: "json" as const, value: rawText },
    };

    expect(redisJsonValueText(value.data)).toBe(rawText);
    expect(redisValuePreview(value)).toBe(rawText);
    expect(redisValueSize(value)).toBe(new TextEncoder().encode(rawText).byteLength);
    expect(redisValueCopyText(value)).toBe(`{
  "id": 2326645729978441729,
  "fraction": 0.123456789012345678901234,
  "scientific": 1.234567890123456789e20
}`);
  });

  it("labels raw text views by encoding instead of generic raw text", () => {
    expect(formatRedisMemberDetail("plain-text").rawLabel).toBe("ASCII");
    expect(
      formatRedisMemberDetail({
        raw_base64: Buffer.from("你好", "utf8").toString("base64"),
        encoding: "utf8",
      }).rawLabel,
    ).toBe("UTF-8");
    expect(
      formatRedisMemberDetail({
        raw_base64: "rO0ABQ==",
        encoding: "binary",
      }).rawLabel,
    ).toBe("Binary");
  });

  it("orders supported formats with the recommended view first", () => {
    expect(
      formatRedisMemberDetail({
        raw_base64: Buffer.from('{"id":1}', "utf8").toString("base64"),
        encoding: "utf8",
      }).availableFormats,
    ).toEqual(["utf8", "ascii", "binary", "hex", "base64"]);
    expect(
      formatRedisMemberDetail({
        raw_base64: "rO0ABQ==",
        encoding: "binary",
      }).availableFormats,
    ).toEqual(["hex", "binary", "base64"]);
  });

  it("keeps a UTF-8 decoding available even for binary blobs", () => {
    const detail = formatRedisMemberDetail({
      raw_base64: "rO0ABQ==",
      encoding: "binary",
    });

    expect(detail.utf8Text).toBe(new TextDecoder("utf-8").decode(Uint8Array.from([0xac, 0xed, 0x00, 0x05])));
  });

  it("only exposes JSON view when payload text explicitly opts in", () => {
    expect(
      formatRedisMemberDetail(
        {
          raw_base64: Buffer.from('{"id":1}', "utf8").toString("base64"),
          encoding: "utf8",
        },
        { allowJsonText: true },
      ).availableFormats,
    ).toEqual(["utf8", "ascii", "binary", "json", "hex", "base64"]);
  });

  it("falls back to utf8 when a binary inspection view was stored for editable text", () => {
    const blob = {
      raw_base64: Buffer.from("Ada", "utf8").toString("base64"),
      encoding: "utf8" as const,
    };

    expect(preferredRedisValueFormat(blob, "hex")).toBe("utf8");
    expect(preferredRedisValueFormat(blob, "base64")).toBe("utf8");
    expect(preferredRedisValueFormat(blob, "binary")).toBe("utf8");
    expect(preferredRedisValueFormat(blob, "json", { allowJsonText: true })).toBe("utf8");
  });

  it("adds a Java serialized format when the blob uses Java object serialization", () => {
    const detail = formatRedisMemberDetail({
      raw_base64: "rO0ABXQACHNvbWV0ZXh0",
      encoding: "binary",
    });

    expect(detail.availableFormats).toEqual(["javaserialize", "binary", "hex", "base64"]);
    expect(detail.defaultFormat).toBe("javaserialize");
    expect(detail.javaSerialized?.formattedText).toBe('"sometext"');
    expect(canRenderRedisValueFormat(detail, "javaserialize")).toBe(true);
    expect(canRenderRedisValueFormat(formatRedisMemberDetail("plain-text"), "javaserialize")).toBe(false);
  });

  it("keeps self-referential Java maps representable via refs", () => {
    const detail = formatRedisMemberDetail({
      raw_base64: "rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcAUH2sHDFmDRAwACRgAKbG9hZEZhY3RvckkACXRocmVzaG9sZHhwP0AAAAAAAAx3CAAAABAAAAABdAAEc2VsZnEAfgABeA==",
      encoding: "binary",
    });

    const normalized = detail.javaSerialized?.value as { map?: { $entries?: Array<{ value?: { $ref?: string } }> } } | undefined;
    const entries = normalized?.map?.$entries;
    expect(entries?.[0]?.value?.$ref).toBe("#1");
  });

  it("keeps editable text round-trippable while exposing separate ascii/binary views", () => {
    const detail = formatRedisMemberDetail({
      raw_base64: Buffer.from("send_message_to_esb\x06\x16", "latin1").toString("base64"),
      encoding: "utf8",
    });

    expect(detail.rawText).toBe("send_message_to_esb\x06\x16");
    expect(detail.asciiText).toBe("send_message_to_esb\\x06\\x16");
    expect(detail.binaryText).toBe("011100110110010101101110011001000101111101101101011001010111001101110011011000010110011101100101010111110111010001101111010111110110010101110011011000100000011000010110");
  });

  it("copies binary blobs as escaped raw bytes", () => {
    expect(
      redisMemberCopyText({
        raw_base64: "rO0ABQ==",
        encoding: "binary",
      }),
    ).toBe("\\xac\\xed\\x00\\x05");
  });
});
