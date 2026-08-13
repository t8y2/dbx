import { describe, expect, it } from "vitest";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Meilisearch connection URLs", () => {
  it("parses the dedicated scheme with the default port and API key", () => {
    expect(parseConnectionUrl("meilisearch://:secret@search.example.com")).toMatchObject({
      dbType: "meilisearch",
      driverProfile: "meilisearch",
      driverLabel: "Meilisearch",
      host: "search.example.com",
      port: 7700,
      username: "",
      password: "secret",
      ssl: false,
    });
  });

  it("keeps Meilisearch selected for HTTPS URLs", () => {
    expect(parseConnectionUrl("https://search.example.com:8443?insecure=true", "meilisearch")).toMatchObject({
      dbType: "meilisearch",
      driverProfile: "meilisearch",
      port: 8443,
      urlParams: "insecure=true",
      ssl: true,
    });
  });

  it("exposes the Meilisearch scheme profile", () => {
    expect(connectionProfileForScheme("meilisearch")).toEqual({
      type: "meilisearch",
      profile: "meilisearch",
      label: "Meilisearch",
      defaultPort: 7700,
    });
  });
});
