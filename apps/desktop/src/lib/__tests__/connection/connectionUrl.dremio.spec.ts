import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Dremio JDBC connection URLs", () => {
  it("parses legacy direct JDBC URLs into a Dremio JDBC profile", () => {
    const parsed = parseConnectionUrl("jdbc:dremio:direct=dremio.example.com:31010;schema=analytics;user=admin;password=secret;ssl=true");

    expect(parsed.dbType).toBe("jdbc");
    expect(parsed.driverProfile).toBe("dremio");
    expect(parsed.driverLabel).toBe("Dremio");
    expect(parsed.host).toBe("dremio.example.com");
    expect(parsed.port).toBe(31010);
    expect(parsed.database).toBe("analytics");
    expect(parsed.username).toBe("admin");
    expect(parsed.password).toBe("secret");
    expect(parsed.urlParams).toBe("ssl=true");
    expect(parsed.connectionString).toBe("jdbc:dremio:direct=dremio.example.com:31010;schema=analytics;user=admin;password=secret;ssl=true");
  });

  it("uses the Dremio default port when the JDBC URL omits a port", () => {
    const parsed = parseConnectionUrl("jdbc:dremio:direct=dremio.example.com");

    expect(parsed.port).toBe(31010);
    expect(parsed.database).toBeUndefined();
  });

  it("parses legacy ZooKeeper JDBC URLs into a Dremio JDBC profile", () => {
    const parsed = parseConnectionUrl("jdbc:dremio:zk=zk.example.com;schema=analytics;tag=prod");

    expect(parsed.dbType).toBe("jdbc");
    expect(parsed.driverProfile).toBe("dremio");
    expect(parsed.host).toBe("zk.example.com");
    expect(parsed.port).toBe(2181);
    expect(parsed.database).toBe("analytics");
    expect(parsed.urlParams).toBe("tag=prod");
  });

  it("parses Arrow Flight SQL JDBC URLs into a Dremio JDBC profile", () => {
    const parsed = parseConnectionUrl("jdbc:arrow-flight-sql://admin:secret@dremio.example.com:32010?schema=analytics&useEncryption=true");

    expect(parsed.dbType).toBe("jdbc");
    expect(parsed.driverProfile).toBe("dremio");
    expect(parsed.driverLabel).toBe("Dremio");
    expect(parsed.host).toBe("dremio.example.com");
    expect(parsed.port).toBe(32010);
    expect(parsed.database).toBe("analytics");
    expect(parsed.username).toBe("admin");
    expect(parsed.password).toBe("secret");
    expect(parsed.urlParams).toBe("schema=analytics&useEncryption=true");
    expect(parsed.ssl).toBe(true);
    expect(parsed.connectionString).toBe("jdbc:arrow-flight-sql://admin:secret@dremio.example.com:32010?schema=analytics&useEncryption=true");
  });

  it("uses the Arrow Flight SQL default port when the JDBC URL omits a port", () => {
    const parsed = parseConnectionUrl("jdbc:arrow-flight-sql://dremio.example.com");

    expect(parsed.port).toBe(32010);
    expect(parsed.database).toBeUndefined();
  });

  it("parses unencrypted Arrow Flight SQL JDBC URLs", () => {
    const parsed = parseConnectionUrl("jdbc:arrow-flight-sql://dremio.example.com:32010?useEncryption=false");

    expect(parsed.port).toBe(32010);
    expect(parsed.urlParams).toBe("useEncryption=false");
    expect(parsed.ssl).toBe(false);
  });
});
