import { describe, expect, it } from "vitest";
import { redisKeyPassesNoExpiryFilter } from "@/lib/redis/redisKeyTree";

describe("Redis no-expiry filter membership", () => {
  it("keeps a key whose expiry is still unknown", () => {
    // The server leaves the TTL out of the payload when it did not answer
    // for the key, so an unknown expiry arrives as undefined. The -2 sentinel
    // is the same answer in its numeric form.
    expect(redisKeyPassesNoExpiryFilter({ ttl: undefined })).toBe(true);
    expect(redisKeyPassesNoExpiryFilter({ ttl: -2 })).toBe(true);
  });

  it("keeps a key that never expires", () => {
    expect(redisKeyPassesNoExpiryFilter({ ttl: -1 })).toBe(true);
  });

  it("drops a key with a real expiry", () => {
    expect(redisKeyPassesNoExpiryFilter({ ttl: 3600 })).toBe(false);
    expect(redisKeyPassesNoExpiryFilter({ ttl: 0 })).toBe(false);
  });
});
