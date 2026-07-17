import { describe, expect, it } from "vitest";
import { formatTtl } from "@/lib/common/ttlFormat";

// ---------------------------------------------------------------------------
// Mock `t()` helpers — only the day unit needs localization
// ---------------------------------------------------------------------------

function enT(key: string, options?: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    "redis.ttlDay": "{count}d",
  };
  const msg = messages[key] ?? key;
  const count = (options as { count?: number })?.count;
  if (count != null) return msg.replace("{count}", String(count));
  return msg;
}

function zhT(key: string, options?: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    "redis.ttlDay": "{count}天",
  };
  const msg = messages[key] ?? key;
  const count = (options as { count?: number })?.count;
  if (count != null) return msg.replace("{count}", String(count));
  return msg;
}

function esT(key: string, options?: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    "redis.ttlDay": "{count}d",
  };
  const msg = messages[key] ?? key;
  const count = (options as { count?: number })?.count;
  if (count != null) return msg.replace("{count}", String(count));
  return msg;
}

function itT(key: string, options?: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    "redis.ttlDay": "{count}g",
  };
  const msg = messages[key] ?? key;
  const count = (options as { count?: number })?.count;
  if (count != null) return msg.replace("{count}", String(count));
  return msg;
}

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

describe("formatTtl — sub-day, HH:mm:ss (no i18n)", () => {
  it("formats 45s as 00:00:45", () => {
    expect(formatTtl(45, enT)).toBe("00:00:45");
  });

  it("formats 1m as 00:01:00", () => {
    expect(formatTtl(60, enT)).toBe("00:01:00");
  });

  it("formats 1m 30s as 00:01:30", () => {
    expect(formatTtl(90, enT)).toBe("00:01:30");
  });

  it("formats 2m 5s as 00:02:05", () => {
    expect(formatTtl(125, enT)).toBe("00:02:05");
  });

  it("formats 1h as 01:00:00", () => {
    expect(formatTtl(3600, enT)).toBe("01:00:00");
  });

  it("formats 1h 1m 1s as 01:01:01", () => {
    expect(formatTtl(3661, enT)).toBe("01:01:01");
  });

  it("formats 23h 59m 59s as 23:59:59", () => {
    expect(formatTtl(86399, enT)).toBe("23:59:59");
  });
});

describe("formatTtl — multi-day, {n}d HH:mm:ss (day unit localized)", () => {
  it("formats exactly 1 day as 1d 00:00:00", () => {
    expect(formatTtl(86400, enT)).toBe("1d 00:00:00");
    expect(formatTtl(86400, zhT)).toBe("1天 00:00:00");
  });

  it("formats 7 days as 7d 00:00:00", () => {
    expect(formatTtl(604800, enT)).toBe("7d 00:00:00");
    expect(formatTtl(604800, zhT)).toBe("7天 00:00:00");
  });

  it("formats 365 days as 365d 00:00:00", () => {
    expect(formatTtl(31536000, enT)).toBe("365d 00:00:00");
    expect(formatTtl(31536000, zhT)).toBe("365天 00:00:00");
  });

  it("formats 1d 1h 1m 1s", () => {
    expect(formatTtl(90061, enT)).toBe("1d 01:01:01");
    expect(formatTtl(90061, zhT)).toBe("1天 01:01:01");
  });

  it("formats 2d 3h 4m 5s", () => {
    const ttl = 2 * 86400 + 3 * 3600 + 4 * 60 + 5; // 183845
    expect(formatTtl(ttl, enT)).toBe("2d 03:04:05");
    expect(formatTtl(ttl, zhT)).toBe("2天 03:04:05");
  });
});

describe("formatTtl — Spanish locale", () => {
  it("formats sub-day values with no i18n", () => {
    expect(formatTtl(45, esT)).toBe("00:00:45");
    expect(formatTtl(3661, esT)).toBe("01:01:01");
  });

  it("formats multi-day with localized d", () => {
    expect(formatTtl(86400, esT)).toBe("1d 00:00:00");
    expect(formatTtl(604800, esT)).toBe("7d 00:00:00");
  });

  it("returns null for -1", () => {
    expect(formatTtl(-1, esT)).toBeNull();
  });

  it("returns null for 0", () => {
    expect(formatTtl(0, esT)).toBeNull();
  });
});

describe("formatTtl — Italian locale", () => {
  it("formats sub-day values with no i18n", () => {
    expect(formatTtl(45, itT)).toBe("00:00:45");
    expect(formatTtl(3661, itT)).toBe("01:01:01");
  });

  it("formats multi-day with localized g", () => {
    expect(formatTtl(86400, itT)).toBe("1g 00:00:00");
    expect(formatTtl(604800, itT)).toBe("7g 00:00:00");
  });

  it("returns null for -1", () => {
    expect(formatTtl(-1, itT)).toBeNull();
  });

  it("returns null for 0", () => {
    expect(formatTtl(0, itT)).toBeNull();
  });
});
