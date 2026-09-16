import { describe, expect, it } from "vitest";
import { formatTtl } from "@/lib/common/ttlFormat";

// ---------------------------------------------------------------------------
// Mock `t()` helpers — day/hour/minute/second units are all localized
// ---------------------------------------------------------------------------

function makeT(messages: Record<string, string>): (key: string, options?: Record<string, unknown>) => string {
  return (key, options) => {
    const msg = messages[key] ?? key;
    const count = (options as { count?: number })?.count;
    if (count != null) return msg.replace("{count}", String(count));
    return msg;
  };
}

const enT = makeT({
  "redis.ttlDay": "{count}d",
  "redis.ttlHour": "{count}h",
  "redis.ttlMinute": "{count}m",
  "redis.ttlSecond": "{count}s",
});

const zhT = makeT({
  "redis.ttlDay": "{count}天",
  "redis.ttlHour": "{count}小时",
  "redis.ttlMinute": "{count}分钟",
  "redis.ttlSecond": "{count}秒",
});

const itT = makeT({
  "redis.ttlDay": "{count}g",
  "redis.ttlHour": "{count}h",
  "redis.ttlMinute": "{count}m",
  "redis.ttlSecond": "{count}s",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatTtl — special values", () => {
  it("returns null for -1 (no expiry)", () => {
    expect(formatTtl(-1, enT)).toBeNull();
  });

  it("returns null for 0", () => {
    expect(formatTtl(0, enT)).toBeNull();
    expect(formatTtl(0, zhT)).toBeNull();
  });

  it("returns null for negative values other than -1", () => {
    expect(formatTtl(-2, enT)).toBeNull();
  });
});

describe("formatTtl — sub-hour, single unit or minute+second", () => {
  it("formats 45s with only the seconds unit", () => {
    expect(formatTtl(45, enT)).toBe("45s");
    expect(formatTtl(45, zhT)).toBe("45秒");
  });

  it("formats 1m with only the minutes unit", () => {
    expect(formatTtl(60, enT)).toBe("1m");
    expect(formatTtl(60, zhT)).toBe("1分钟");
  });

  it("formats 1m 30s as two units", () => {
    expect(formatTtl(90, enT)).toBe("1m 30s");
    expect(formatTtl(90, zhT)).toBe("1分钟 30秒");
  });

  it("formats 2m 5s as two units", () => {
    expect(formatTtl(125, enT)).toBe("2m 5s");
    expect(formatTtl(125, zhT)).toBe("2分钟 5秒");
  });
});

describe("formatTtl — sub-day, keeps only the two largest non-zero units", () => {
  it("formats 1h with only the hours unit", () => {
    expect(formatTtl(3600, enT)).toBe("1h");
    expect(formatTtl(3600, zhT)).toBe("1小时");
  });

  it("formats 1h 1m 1s by dropping the seconds unit", () => {
    expect(formatTtl(3661, enT)).toBe("1h 1m");
    expect(formatTtl(3661, zhT)).toBe("1小时 1分钟");
  });

  it("formats 23h 59m 59s by dropping the seconds unit", () => {
    expect(formatTtl(86399, enT)).toBe("23h 59m");
    expect(formatTtl(86399, zhT)).toBe("23小时 59分钟");
  });
});

describe("formatTtl — multi-day, day unit plus hours when present", () => {
  it("formats exactly 1 day with only the day unit", () => {
    expect(formatTtl(86400, enT)).toBe("1d");
    expect(formatTtl(86400, zhT)).toBe("1天");
  });

  it("formats 7 days with only the day unit", () => {
    expect(formatTtl(604800, enT)).toBe("7d");
    expect(formatTtl(604800, zhT)).toBe("7天");
  });

  it("formats 365 days with only the day unit", () => {
    expect(formatTtl(31536000, enT)).toBe("365d");
    expect(formatTtl(31536000, zhT)).toBe("365天");
  });

  it("formats 1d 1h 1m 1s by keeping only day and hour", () => {
    expect(formatTtl(90061, enT)).toBe("1d 1h");
    expect(formatTtl(90061, zhT)).toBe("1天 1小时");
  });

  it("formats 2d 3h 4m 5s by keeping only day and hour", () => {
    const ttl = 2 * 86400 + 3 * 3600 + 4 * 60 + 5; // 183845
    expect(formatTtl(ttl, enT)).toBe("2d 3h");
    expect(formatTtl(ttl, zhT)).toBe("2天 3小时");
  });
});

describe("formatTtl — Italian locale", () => {
  it("formats multi-day with localized g", () => {
    expect(formatTtl(86400, itT)).toBe("1g");
    expect(formatTtl(604800, itT)).toBe("7g");
  });

  it("formats sub-day with localized units", () => {
    expect(formatTtl(3661, itT)).toBe("1h 1m");
    expect(formatTtl(45, itT)).toBe("45s");
  });

  it("returns null for -1", () => {
    expect(formatTtl(-1, itT)).toBeNull();
  });

  it("returns null for 0", () => {
    expect(formatTtl(0, itT)).toBeNull();
  });
});
