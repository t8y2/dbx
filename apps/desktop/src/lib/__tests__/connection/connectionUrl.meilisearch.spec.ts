import { describe, expect, it } from "vitest";
import { applyParsedConnectionUrl, connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import { parseConnectionDeepLink } from "@/lib/connection/connectionDeepLink";
import type { ConnectionConfig } from "@/types/database";

describe("Meilisearch connection URLs", () => {
  it("rejects an empty host URL", () => {
    expect(() => parseConnectionUrl("", "meilisearch")).toThrow("Connection URL is empty");
  });

  it("parses the dedicated scheme with the default port, API key, and proxy path", () => {
    expect(parseConnectionUrl("meilisearch://:secret@search.example.com/gateway/meili")).toMatchObject({
      dbType: "meilisearch",
      driverProfile: "meilisearch",
      driverLabel: "Meilisearch",
      host: "search.example.com",
      port: 7700,
      username: "",
      password: "secret",
      ssl: false,
      basePath: "/gateway/meili",
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

  it.each([
    ["http://search.example.com/gateway/meili/", 80, false],
    ["https://search.example.com/gateway/meili", 443, true],
    ["https://search.example.com:8443/gateway/meili", 8443, true],
  ])("parses proxy URL %s", (url, port, ssl) => {
    expect(parseConnectionUrl(url, "meilisearch")).toMatchObject({
      dbType: "meilisearch",
      host: "search.example.com",
      port,
      ssl,
      database: undefined,
      basePath: "/gateway/meili",
    });
  });

  it("stores the proxy path in canonical external config without dropping other fields", () => {
    const parsed = parseConnectionUrl("http://search.example.com/gateway/meili", "meilisearch");
    const config = applyParsedConnectionUrl(
      {
        db_type: "meilisearch",
        driver_profile: "meilisearch",
        driver_label: "Meilisearch",
        host: "localhost",
        port: 7700,
        username: "",
        password: "",
        url_params: "",
        ssl: false,
        external_config: { base_path: "/legacy", custom: true },
      } as Omit<ConnectionConfig, "id">,
      parsed,
    );

    expect(config.external_config).toEqual({ basePath: "/gateway/meili", custom: true });
  });

  it("clears stale proxy paths when the parsed URL uses the root path", () => {
    const parsed = parseConnectionUrl("http://search.example.com/", "meilisearch");
    const config = applyParsedConnectionUrl(
      {
        db_type: "meilisearch",
        driver_profile: "meilisearch",
        driver_label: "Meilisearch",
        host: "localhost",
        port: 7700,
        username: "",
        password: "",
        url_params: "",
        ssl: false,
        external_config: { basePath: "/old", base_path: "/legacy", custom: true },
      } as Omit<ConnectionConfig, "id">,
      parsed,
    );

    expect(parsed.basePath).toBe("");
    expect(config.external_config).toEqual({ custom: true });
  });

  it("preserves the proxy path when a Meilisearch URL arrives through a deep link", () => {
    const link = new URL("dbx://connection/new");
    link.searchParams.set("type", "meilisearch");
    link.searchParams.set("url", "https://search.example.com/gateway/meili?insecure=true");

    expect(parseConnectionDeepLink(link.toString())).toMatchObject({
      dbType: "meilisearch",
      basePath: "/gateway/meili",
      urlParams: "insecure=true",
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
