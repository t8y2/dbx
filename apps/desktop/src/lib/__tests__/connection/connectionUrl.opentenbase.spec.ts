import { describe, expect, it } from "vitest";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("OpenTenBase connection URLs", () => {
  it("parses the OpenTenBase alias as a PostgreSQL-compatible profile", () => {
    const parsed = parseConnectionUrl("opentenbase://opentenbase:secret@cn.example.com/postgres");

    expect(parsed).toMatchObject({
      dbType: "postgres",
      driverProfile: "opentenbase",
      driverLabel: "OpenTenBase",
      host: "cn.example.com",
      port: 11000,
      username: "opentenbase",
      password: "secret",
      database: "postgres",
    });
  });

  it("keeps the OpenTenBase profile for standard PostgreSQL URLs", () => {
    const parsed = parseConnectionUrl("postgresql://cn.example.com:15432/postgres", "opentenbase");

    expect(parsed.dbType).toBe("postgres");
    expect(parsed.driverProfile).toBe("opentenbase");
    expect(parsed.driverLabel).toBe("OpenTenBase");
    expect(parsed.port).toBe(15432);
  });

  it("exposes OpenTenBase to connection deep links", () => {
    expect(connectionProfileForScheme("opentenbase")).toEqual({
      type: "postgres",
      profile: "opentenbase",
      label: "OpenTenBase",
      defaultPort: 11000,
    });
  });
});
