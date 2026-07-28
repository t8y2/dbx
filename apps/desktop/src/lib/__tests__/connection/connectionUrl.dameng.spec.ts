import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Dameng connection URLs", () => {
  it("parses JDBC SSL parameters and enables the TLS form", () => {
    const parsed = parseConnectionUrl("jdbc:dm://dm.example.com:5236/MAIN?sslFilesPath=/Users/test/dmcert&sslkeystorePass=secret");

    expect(parsed).toMatchObject({
      dbType: "dameng",
      driverProfile: "dm",
      host: "dm.example.com",
      port: 5236,
      database: "MAIN",
      urlParams: "sslFilesPath=/Users/test/dmcert&sslkeystorePass=secret",
      ssl: true,
    });
  });
});
