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

  it("treats the rediss scheme as TLS", () => {
    expect(parseConnectionUrl("rediss://cache.example.com:6379/0").ssl).toBe(true);
    expect(parseConnectionUrl("redis://cache.example.com:6379/0").ssl).toBe(false);
  });

  it("salvages pasted redis-cli --tls and --insecure flags from the path", () => {
    const parsed = parseConnectionUrl("redis://coupon:secret@qas-cnapacdd-invisclub-cnn2.redis.rds.aliyuncs.com:6379/0 --tls --insecure");
    expect(parsed.dbType).toBe("redis");
    expect(parsed.host).toBe("qas-cnapacdd-invisclub-cnn2.redis.rds.aliyuncs.com");
    expect(parsed.username).toBe("coupon");
    expect(parsed.password).toBe("secret");
    expect(parsed.database).toBe("0");
    expect(parsed.ssl).toBe(true);
    expect(parsed.urlParams).toBe("insecure=true");
  });

  it("salvages flags from an already percent-encoded dirty path", () => {
    const parsed = parseConnectionUrl("rediss://coupon@cache.example.com:6379/0%20--tls%20--insecure?insecure=true");
    expect(parsed.database).toBe("0");
    expect(parsed.ssl).toBe(true);
    // The explicit query param already carries insecure; it must not be duplicated.
    expect(parsed.urlParams).toBe("insecure=true");
  });

  it("salvages --tls without --insecure", () => {
    const parsed = parseConnectionUrl("redis://cache.example.com:6379/2 --tls");
    expect(parsed.database).toBe("2");
    expect(parsed.ssl).toBe(true);
    expect(parsed.urlParams).toBe("");
  });

  it("salvages flags when the path carries no db index", () => {
    const parsed = parseConnectionUrl("redis://cache.example.com:6379/--tls --insecure");
    expect(parsed.database).toBeUndefined();
    expect(parsed.ssl).toBe(true);
    expect(parsed.urlParams).toBe("insecure=true");
  });

  it("collapses a non-numeric path with no flags to the db index the backend uses", () => {
    expect(parseConnectionUrl("redis://cache.example.com:6379/mydb").database).toBe("0");
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
