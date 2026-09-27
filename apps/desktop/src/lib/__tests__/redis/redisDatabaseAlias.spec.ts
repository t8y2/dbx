import { describe, expect, it } from "vitest";
import { limitRedisDatabaseList, normalizeRedisDatabaseAliases, redisDatabaseAlias, redisDatabaseLabel, REDIS_DATABASE_DISPLAY_LIMIT_DEFAULT } from "@/lib/redis/redisDatabaseAlias";

describe("redisDatabaseAlias", () => {
  it("normalizes numeric database keys and trims aliases", () => {
    expect(
      normalizeRedisDatabaseAliases({
        "0": "  default  ",
        "03": " orders ",
        invalid: "ignored",
        "4": "",
      }),
    ).toEqual({
      "0": "default",
      "3": "orders",
    });
  });

  it("returns undefined for empty alias maps", () => {
    expect(normalizeRedisDatabaseAliases({ "0": " " })).toBeUndefined();
    expect(normalizeRedisDatabaseAliases(null)).toBeUndefined();
  });

  it("looks up aliases without changing the Redis database index", () => {
    const aliases = { "3": "orders" };
    expect(redisDatabaseAlias(aliases, "03")).toBe("orders");
    expect(redisDatabaseAlias(aliases, "invalid")).toBeUndefined();
  });

  it("formats labels with aliases and key counts", () => {
    expect(redisDatabaseLabel(3, { "3": "orders" }, 128)).toBe("db3 · orders (128)");
    expect(redisDatabaseLabel(0, undefined, 0)).toBe("db0 (0)");
    expect(redisDatabaseLabel(2, { "2": "cache" })).toBe("db2 · cache");
  });

  it("leaves the list untouched when it fits within the limit", () => {
    const items = [1, 2, 3];
    expect(limitRedisDatabaseList(items, 10)).toEqual({ visible: items, hasMore: false });
  });

  it("truncates and reports more items are available", () => {
    const items = [1, 2, 3, 4, 5];
    expect(limitRedisDatabaseList(items, 2)).toEqual({ visible: [1, 2], hasMore: true });
  });

  it("falls back to the default limit for missing or invalid values (#1236)", () => {
    const items = Array.from({ length: REDIS_DATABASE_DISPLAY_LIMIT_DEFAULT + 1 }, (_, i) => i);
    expect(limitRedisDatabaseList(items, undefined).hasMore).toBe(true);
    expect(limitRedisDatabaseList(items, 0).hasMore).toBe(true);
    expect(limitRedisDatabaseList(items, -5).hasMore).toBe(true);
    expect(limitRedisDatabaseList(items.slice(0, REDIS_DATABASE_DISPLAY_LIMIT_DEFAULT), undefined).hasMore).toBe(false);
  });
});
