import { describe, expect, it } from "vitest";
import { connectionDeepLinkServiceHydrationValue, parseConnectionDeepLink, parseServiceConnectionUrl } from "@/lib/connection/connectionDeepLink";
import { connectionProfileForScheme } from "@/lib/connection/connectionUrl";

describe("service connection deep links", () => {
  it("registers Consul and every Nacos spelling against canonical profiles", () => {
    expect(connectionProfileForScheme("consul")).toMatchObject({ type: "consul", profile: "consul", defaultPort: 8500 });
    for (const type of ["nacos-v2", "nacos-v3", "r-nacos", "nacos", "rnacos"]) {
      expect(connectionProfileForScheme(type)).toMatchObject({ type: "nacos", profile: "nacos", defaultPort: 8848 });
    }
  });

  it("builds a Consul endpoint and keeps the ACL token in the password field", () => {
    const draft = parseConnectionDeepLink("dbx://connection/new?type=consul&host=consul.internal&password=acl-token");
    expect(draft).toMatchObject({
      dbType: "consul",
      driverProfile: "consul",
      host: "consul.internal",
      port: 8500,
      password: "acl-token",
      serviceConfig: { kind: "consul", serverAddr: "http://consul.internal:8500" },
    });
  });

  it("maps Nacos versions and aliases to explicit service profiles", () => {
    const cases = [
      ["nacos", "v2"],
      ["nacos-v2", "v2"],
      ["nacos-v3", "v3"],
      ["rnacos", "rnacos"],
      ["r-nacos", "rnacos"],
    ] as const;
    for (const [type, profile] of cases) {
      const draft = parseConnectionDeepLink(`dbx://connection/new?type=${type}&host=127.0.0.1&user=nacos&password=secret`);
      expect(draft?.dbType).toBe("nacos");
      expect(draft?.driverProfile).toBe("nacos");
      expect(draft?.serviceConfig).toMatchObject({
        kind: "nacos",
        profile,
        serverAddr: "http://127.0.0.1:8848",
        auth: { kind: "usernamePassword", username: "nacos", password: "secret" },
      });
      if (profile === "rnacos") expect(draft?.serviceConfig).toMatchObject({ rnacosHistoryEnabled: false });
    }
  });

  it("preserves URL paths and lets top-level host, port and SSL fields override them", () => {
    const link = new URL("dbx://connection/new");
    link.searchParams.set("type", "nacos-v3");
    link.searchParams.set("url", "https://nacos:secret@old.example:9443/proxy/nacos");
    link.searchParams.set("host", "[2001:db8::8]");
    link.searchParams.set("port", "18848");
    link.searchParams.set("ssl", "false");
    link.searchParams.set("user", "admin");
    link.searchParams.set("password", "override");

    const draft = parseConnectionDeepLink(link.toString());
    expect(draft).toMatchObject({ host: "[2001:db8::8]", port: 18848, ssl: false, username: "admin", password: "override" });
    expect(draft?.serviceConfig).toEqual({
      kind: "nacos",
      profile: "v3",
      serverAddr: "http://[2001:db8::8]:18848/proxy/nacos",
      auth: { kind: "usernamePassword", username: "admin", password: "override" },
    });
  });

  it("accepts service-specific URL schemes and unwrapped IPv6 hosts", () => {
    const link = new URL("dbx://connection/new");
    link.searchParams.set("type", "nacos-v3");
    link.searchParams.set("url", "nacos-v3://nacos:secret@old.example:8848/proxy/nacos");
    link.searchParams.set("host", "2001:db8::9");
    const draft = parseConnectionDeepLink(link.toString());
    expect(draft?.serviceConfig).toMatchObject({
      kind: "nacos",
      profile: "v3",
      serverAddr: "http://[2001:db8::9]:8848/proxy/nacos",
    });

    const inferred = new URL("dbx://connection/new");
    inferred.searchParams.set("url", "consul://127.0.0.1:8500/proxy");
    expect(parseConnectionDeepLink(inferred.toString())?.serviceConfig).toEqual({
      kind: "consul",
      serverAddr: "http://127.0.0.1:8500/proxy",
    });
  });

  it("converts raw service URLs into drafts with specialized configuration", () => {
    expect(parseServiceConnectionUrl("consul://remote.example:18500/prefix")).toMatchObject({
      dbType: "consul",
      host: "remote.example",
      port: 18500,
      serviceConfig: { kind: "consul", serverAddr: "http://remote.example:18500/prefix" },
    });
    expect(parseServiceConnectionUrl("nacos-v3://nacos:secret@remote.example:18848/nacos")).toMatchObject({
      dbType: "nacos",
      username: "nacos",
      password: "secret",
      serviceConfig: {
        kind: "nacos",
        profile: "v3",
        serverAddr: "http://remote.example:18848/nacos",
        auth: { kind: "usernamePassword", username: "nacos", password: "secret" },
      },
    });
    expect(parseServiceConnectionUrl("mysql://root:secret@127.0.0.1:3306/app")).toBeNull();
  });

  it("accepts missing v and v=1, but rejects unsupported versions", () => {
    expect(parseConnectionDeepLink("dbx://connection/new?type=consul&host=127.0.0.1")).not.toBeNull();
    expect(parseConnectionDeepLink("dbx://connection/new?v=1&type=consul&host=127.0.0.1")).not.toBeNull();
    expect(() => parseConnectionDeepLink("dbx://connection/new?v=2&type=consul&host=127.0.0.1")).toThrow(/Unsupported connection deep-link version/);
  });

  it("parses explicit false values and rejects invalid booleans", () => {
    expect(parseConnectionDeepLink("dbx://connection/new?type=consul&ssl=false&one_time=false")).toMatchObject({
      ssl: false,
      oneTime: false,
      serviceConfig: { kind: "consul", serverAddr: "http://127.0.0.1:8500" },
    });
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=consul&ssl=maybe")).toThrow(/Invalid boolean value/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=consul&one_time=2")).toThrow(/Invalid boolean value/);
  });

  it("maps service drafts to the exact specialized form hydration values", () => {
    expect(connectionDeepLinkServiceHydrationValue({ kind: "consul", serverAddr: "https://consul.example/prefix" })).toEqual({
      serverAddr: "https://consul.example/prefix",
    });
    expect(
      connectionDeepLinkServiceHydrationValue({
        kind: "nacos",
        profile: "v3",
        serverAddr: "https://nacos.example/prefix",
        auth: { kind: "usernamePassword", username: "nacos", password: "secret" },
      }),
    ).toEqual({
      implementation: "nacos",
      versionMode: "v3",
      serverAddr: "https://nacos.example/prefix",
      auth: { kind: "usernamePassword", username: "nacos", password: "secret" },
    });
    expect(
      connectionDeepLinkServiceHydrationValue({
        kind: "nacos",
        profile: "rnacos",
        serverAddr: "http://rnacos.example/nacos",
        auth: { kind: "none" },
        rnacosHistoryEnabled: false,
      }),
    ).toEqual({
      implementation: "rnacos",
      serverAddr: "http://rnacos.example/nacos",
      rnacosHistoryEnabled: false,
      auth: { kind: "none" },
    });
  });

  it("rejects invalid ports, targets and incomplete Nacos credentials", () => {
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=consul&port=0")).toThrow(/Invalid connection port/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=consul&port=70000")).toThrow(/Invalid connection port/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=nacos-v2&password=secret")).toThrow(/username is required/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=consul&host=bad%2Fhost")).toThrow(/Invalid service connection host/);
    expect(parseConnectionDeepLink("dbx://connection/edit?type=consul")).toBeNull();
  });
});
