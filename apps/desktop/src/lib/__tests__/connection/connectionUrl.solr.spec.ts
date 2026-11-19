import { describe, expect, it } from "vitest";
import { applyParsedConnectionUrl, connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import type { ConnectionConfig } from "@/types/database";

describe("Solr connection URLs", () => {
  it("rejects an empty host URL", () => {
    expect(() => parseConnectionUrl("", "solr")).toThrow("Connection URL is empty");
  });

  it("parses the dedicated scheme with the default port and credentials", () => {
    expect(parseConnectionUrl("solr://solr:SolrRocks@search.example.com")).toMatchObject({
      dbType: "solr",
      driverProfile: "solr",
      driverLabel: "Apache Solr",
      host: "search.example.com",
      port: 8983,
      username: "solr",
      password: "SolrRocks",
      database: undefined,
      ssl: false,
    });
  });

  it("keeps Solr selected for HTTP/HTTPS URLs", () => {
    expect(parseConnectionUrl("http://search.example.com:8984", "solr")).toMatchObject({
      dbType: "solr",
      host: "search.example.com",
      port: 8984,
      ssl: false,
    });
    expect(parseConnectionUrl("https://search.example.com?insecure=true", "solr")).toMatchObject({
      dbType: "solr",
      host: "search.example.com",
      port: 8983,
      urlParams: "insecure=true",
      ssl: true,
    });
  });

  it("does not treat the /solr context path as a database", () => {
    // The driver appends /solr itself; storing it as the database would make the
    // parsed value look like a selectable namespace that does not exist.
    for (const url of ["solr://search.example.com/solr", "http://search.example.com:8983/solr", "https://search.example.com/solr/"]) {
      expect(parseConnectionUrl(url, "solr")).toMatchObject({
        dbType: "solr",
        database: undefined,
      });
    }
  });

  it("does not resurrect a database through applyParsedConnectionUrl", () => {
    const parsed = parseConnectionUrl("solr://search.example.com/solr", "solr");
    const config = applyParsedConnectionUrl(
      {
        db_type: "solr",
        driver_profile: "solr",
        driver_label: "Apache Solr",
        host: "localhost",
        port: 8983,
        username: "",
        password: "",
        database: "stale-core",
        url_params: "",
        ssl: false,
      } as Omit<ConnectionConfig, "id">,
      parsed,
    );

    expect(config.database).toBeUndefined();
  });

  it("exposes the Solr scheme profile", () => {
    expect(connectionProfileForScheme("solr")).toEqual({
      type: "solr",
      profile: "solr",
      label: "Apache Solr",
      defaultPort: 8983,
    });
  });
});
