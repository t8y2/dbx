import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

// A `#` in a connection URL is data: database clients read the query to the end,
// and credentials or database names may legitimately contain it. WHATWG `URL`
// stops at the first `#` instead, which used to import a truncated password and
// drop the remainder of the URL without any warning.
describe("connection URL fragment handling", () => {
  it("keeps a `#` inside JDBC credential properties", () => {
    const parsed = parseConnectionUrl("jdbc:mysql://db.example.com:3306/appdb?user=root&password=Jxc#2026@n1&useSSL=false");

    expect(parsed.dbType).toBe("mysql");
    expect(parsed.host).toBe("db.example.com");
    expect(parsed.username).toBe("root");
    expect(parsed.password).toBe("Jxc#2026@n1");
    expect(parsed.database).toBe("appdb");
    expect(parsed.urlParams).toBe("useSSL=false");
  });

  it("keeps a `#` inside standard URL userinfo credentials", () => {
    expect(parseConnectionUrl("mysql://root:Jxc#2026@n1@db.example.com:3306/appdb")).toMatchObject({
      host: "db.example.com",
      port: 3306,
      username: "root",
      password: "Jxc#2026@n1",
      database: "appdb",
    });
    expect(parseConnectionUrl("postgres://root:Jxc#2026@n1@db.example.com:5432/appdb").password).toBe("Jxc#2026@n1");
  });

  it("keeps a `#` in the database name", () => {
    expect(parseConnectionUrl("postgres://db.example.com:5432/app#db").database).toBe("app#db");
  });

  it("escapes `#` inside forwarded query parameters instead of dropping the tail", () => {
    expect(parseConnectionUrl("mysql://db.example.com:3306/appdb?options=--flag#value").urlParams).toBe("options=--flag%23value");
  });

  it("still maps the Redis #insecure alias to the insecure parameter", () => {
    const parsed = parseConnectionUrl("rediss://cache.example.com:6379/0#insecure");

    expect(parsed.database).toBe("0");
    expect(parsed.urlParams).toBe("insecure=true");
    expect(parsed.ssl).toBe(true);
  });

  it("keeps a `#` inside Redis credentials", () => {
    expect(parseConnectionUrl("redis://:p#ss@cache.example.com:6379/0").password).toBe("p#ss");
  });

  it("keeps standard fragment semantics for web endpoints", () => {
    expect(parseConnectionUrl("https://search.example.com:7700/gateway/meili#section", "meilisearch").basePath).toBe("/gateway/meili");
  });
});
