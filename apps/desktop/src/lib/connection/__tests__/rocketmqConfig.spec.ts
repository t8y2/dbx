import { describe, expect, it } from "vitest";
import { hydrateRocketMqConfig, buildRocketMqConfig, rocketMqConnectionTarget } from "../rocketmqConfig";

describe("RocketMQ connection configuration", () => {
  it("hydrates legacy aliases as remoting and keeps Basic credentials", () => {
    expect(hydrateRocketMqConfig({ extra: { namesrv_addr: "host:9876", cluster_name: "old" }, auth: { kind: "basic", username: "ak", password: "sk" } })).toMatchObject({ connectionMode: "remoting", namesrvAddr: "host:9876", clusterName: "old", proxyTls: true, managementEnabled: false });
  });
  it("builds proxy-only without a NameServer or extra credential copies", () => {
    const config = buildRocketMqConfig({ connectionMode: "proxy", proxyEndpoint: " proxy:8081 ", proxyTls: true, managementEnabled: false, namesrvAddr: "", clusterName: "" }, { kind: "basic", username: "ak", password: "sk" });
    expect(config).toMatchObject({ systemKind: "rocketmq", auth: { kind: "basic", username: "ak", password: "sk" }, extra: { connectionMode: "proxy", proxyEndpoint: "proxy:8081", proxyTls: true, managementEnabled: false } });
    expect(config.extra).not.toHaveProperty("secretKey");
    expect(config.extra).not.toHaveProperty("accessKey");
    expect(rocketMqConnectionTarget(config)).toEqual({ host: "proxy", port: 8081, ssl: true });
  });
  it("requires a NameServer for remoting and optional administration", () => {
    for (const connectionMode of ["remoting", "proxy"] as const) {
      expect(() => buildRocketMqConfig({ connectionMode, proxyEndpoint: "proxy:8081", proxyTls: true, managementEnabled: true, namesrvAddr: "", clusterName: "" })).toThrow(/NameServer/);
    }
  });
  it.each(["", "http://proxy:8081", "proxy", "proxy:0", "proxy:99999", "proxy:8081/path", "user:password@proxy:8081", "proxy:8081,other:8081"])("rejects invalid proxy endpoint %s", (proxyEndpoint) => {
    expect(() => buildRocketMqConfig({ connectionMode: "proxy", proxyEndpoint, proxyTls: true, managementEnabled: false, namesrvAddr: "", clusterName: "" })).toThrow(/Proxy/);
  });
  it("preserves explicit plaintext and enabled management on hydration", () => {
    expect(hydrateRocketMqConfig({ extra: { connectionMode: "proxy", proxyTls: false, managementEnabled: true, namesrvAddr: "n:9876", proxyEndpoint: "[::1]:8081" } })).toMatchObject({ proxyTls: false, managementEnabled: true });
  });
});
