import { describe, expect, it } from "vitest";

import { formatRedisMemberDetail, formatRedisStringValue, getRedisMemberSelectionKey, sanitizeRedisDisplayText } from "@/lib/redis/redisValuePresentation";

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

  it("strips utf8 c1 control bytes for display", () => {
    expect(sanitizeRedisDisplayText("before\u0085after")).toBe("beforeafter");
  });

  it("uses raw member text for selection keys", () => {
    const raw = "send_message_to_esb\x06\x16";

    expect(getRedisMemberSelectionKey("member", raw)).toBe(`member\n${raw}`);
  });

  it("formats string values for display without changing plain text", () => {
    expect(formatRedisStringValue("plain-text")).toBe("plain-text");
  });
});
