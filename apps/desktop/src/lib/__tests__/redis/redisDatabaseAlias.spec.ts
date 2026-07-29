import { describe, expect, it } from "vitest";
import { normalizeRedisDatabaseAliases, redisDatabaseAlias, redisDatabaseLabel } from "@/lib/redis/redisDatabaseAlias";

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
});
