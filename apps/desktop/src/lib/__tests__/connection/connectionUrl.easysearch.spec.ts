import { describe, expect, it } from "vitest";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Easysearch connection URLs", () => {
  it("parses the dedicated Easysearch scheme", () => {
    expect(parseConnectionUrl("easysearch://dbx_test:secret@easysearch.example.com:9200")).toMatchObject({
      dbType: "easysearch",
      driverProfile: "easysearch",
      driverLabel: "Easysearch",
      host: "easysearch.example.com",
      port: 9200,
      username: "dbx_test",
      password: "secret",
      ssl: false,
    });
  });

  it("keeps Easysearch selected for HTTPS URLs", () => {
    expect(parseConnectionUrl("https://easysearch.example.com:9443", "easysearch")).toMatchObject({
      dbType: "easysearch",
      driverProfile: "easysearch",
      port: 9443,
      ssl: true,
    });
  });

  it("exposes the Easysearch scheme profile", () => {
    expect(connectionProfileForScheme("easysearch")).toEqual({
      type: "easysearch",
      profile: "easysearch",
      label: "Easysearch",
      defaultPort: 9200,
    });
  });
});
