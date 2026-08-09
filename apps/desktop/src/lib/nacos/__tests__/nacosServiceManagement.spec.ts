import { describe, expect, it } from "vitest";

import { nacosInstanceMatchesPatch, nacosInstanceRefIdentity, nacosIpAddressIsValid, nacosJsonObjectMatches, nacosServiceDetailMatches } from "../nacosServiceManagement";

describe("Nacos service management state reconciliation", () => {
  it("keeps unknown, persistent and ephemeral instances as separate identities", () => {
    const base = { serviceName: "api", ip: "127.0.0.1", port: 8080, clusterName: "blue" };
    expect(new Set([nacosInstanceRefIdentity(base), nacosInstanceRefIdentity({ ...base, ephemeral: false }), nacosInstanceRefIdentity({ ...base, ephemeral: true })]).size).toBe(3);
  });

  it("validates IPv4 and IPv6 instance addresses without accepting host names", () => {
    expect(nacosIpAddressIsValid("127.0.0.1")).toBe(true);
    expect(nacosIpAddressIsValid("2001:db8::1")).toBe(true);
    expect(nacosIpAddressIsValid("999.0.0.1")).toBe(false);
    expect(nacosIpAddressIsValid("localhost")).toBe(false);
  });

  it("compares metadata independently of object key order", () => {
    expect(nacosJsonObjectMatches({ owner: "dbx", nested: { b: 2, a: 1 } }, { nested: { a: 1, b: 2 }, owner: "dbx" })).toBe(true);
  });

  it("verifies only fields present in an instance patch", () => {
    const instance = { ip: "127.0.0.1", port: 8080, weight: 0.3, enabled: false, healthy: true, metadata: { role: "api" } };
    expect(nacosInstanceMatchesPatch(instance, { weight: 0.3000000001, metadata: { role: "api" } })).toBe(true);
    expect(nacosInstanceMatchesPatch(instance, { metadata: { role: "worker" } })).toBe(false);
    expect(nacosInstanceMatchesPatch({ ip: "127.0.0.1", port: 8080 }, { weight: 1 })).toBe(false);
  });

  it("treats Nacos none selectors as the UI's unconfigured selector", () => {
    const expected = { serviceName: "api", metadata: { owner: "dbx" }, protectThreshold: 0.5 };
    expect(nacosServiceDetailMatches({ serviceName: "api", metadata: { owner: "dbx" }, protectThreshold: 0.5, selector: { type: "NoneSelector", contextType: "NONE" } }, expected)).toBe(true);
    expect(nacosServiceDetailMatches({ serviceName: "api", metadata: { owner: "dbx" } }, expected)).toBe(false);
  });
});
