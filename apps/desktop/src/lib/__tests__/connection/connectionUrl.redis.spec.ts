import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Redis connection URLs", () => {
  it("parses a numeric database index from the path", () => {
    const parsed = parseConnectionUrl("rediss://coupon@cache.example.com:6379/3?insecure=true");
    expect(parsed.dbType).toBe("redis");
    expect(parsed.host).toBe("cache.example.com");
    expect(parsed.port).toBe(6379);
    expect(parsed.username).toBe("coupon");
    expect(parsed.database).toBe("3");
    expect(parsed.ssl).toBe(true);
    expect(parsed.urlParams).toBe("insecure=true");
  });

  it("collapses a dirty path (redis-cli flags) to the db index the backend uses", () => {
    // Literal spaces: WHATWG URL percent-encodes them into the path, which used
    // to land verbatim in the database field and leak back out as %20 on copy.
    const parsed = parseConnectionUrl("rediss://coupon@cache.example.com:6379/0 --tls --insecure?insecure=true");
    expect(parsed.database).toBe("0");
    expect(parsed.urlParams).toBe("insecure=true");
  });

  it("collapses an already percent-encoded dirty path the same way", () => {
    const parsed = parseConnectionUrl("rediss://coupon@cache.example.com:6379/0%20--tls%20--insecure?insecure=true");
    expect(parsed.database).toBe("0");
  });

  it("leaves the database unset when the URL has no path", () => {
    expect(parseConnectionUrl("redis://cache.example.com:6379").database).toBeUndefined();
    expect(parseConnectionUrl("redis://cache.example.com:6379/").database).toBeUndefined();
  });

  it("maps the #insecure fragment to the insecure url param", () => {
    const parsed = parseConnectionUrl("rediss://cache.example.com:6379/0#insecure");
    expect(parsed.database).toBe("0");
    expect(parsed.urlParams).toBe("insecure=true");
  });
});
