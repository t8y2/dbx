import { describe, expect, it } from "vitest";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Cloudberry connection URLs", () => {
  it("parses the Cloudberry alias as a PostgreSQL-compatible profile", () => {
    const parsed = parseConnectionUrl("cloudberry://analyst:secret@cb.example.com/warehouse");

    expect(parsed).toMatchObject({
      dbType: "postgres",
      driverProfile: "cloudberry",
      driverLabel: "Apache Cloudberry",
      host: "cb.example.com",
      port: 5432,
      username: "analyst",
      password: "secret",
      database: "warehouse",
    });
  });

  it("keeps the Cloudberry profile for standard PostgreSQL URLs", () => {
    const parsed = parseConnectionUrl("postgresql://cb.example.com:6432/warehouse", "cloudberry");

    expect(parsed.dbType).toBe("postgres");
    expect(parsed.driverProfile).toBe("cloudberry");
    expect(parsed.driverLabel).toBe("Apache Cloudberry");
    expect(parsed.port).toBe(6432);
  });

  it("exposes Cloudberry to connection deep links", () => {
    expect(connectionProfileForScheme("cloudberry")).toEqual({
      type: "postgres",
      profile: "cloudberry",
      label: "Apache Cloudberry",
      defaultPort: 5432,
    });
  });
});
