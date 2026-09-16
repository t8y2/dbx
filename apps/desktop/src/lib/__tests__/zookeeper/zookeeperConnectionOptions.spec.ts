import { describe, expect, it } from "vitest";
import { setZooKeeperAuthScheme, zooKeeperAuthScheme } from "@/lib/zookeeper/zookeeperConnectionOptions";

describe("ZooKeeper connection options", () => {
  it("defaults to digest when auth_scheme is absent", () => {
    expect(zooKeeperAuthScheme("connect_timeout=10")).toBe("digest");
  });

  it("reads the supported SASL DIGEST-MD5 scheme", () => {
    expect(zooKeeperAuthScheme("connect_timeout=10&auth_scheme=sasl_digest")).toBe("sasl_digest");
  });

  it("writes sasl_digest without losing unrelated URL parameters", () => {
    expect(setZooKeeperAuthScheme("connect_timeout=10&session_timeout=20", "sasl_digest")).toBe("connect_timeout=10&session_timeout=20&auth_scheme=sasl_digest");
  });

  it("switches back to digest by removing only auth_scheme", () => {
    expect(setZooKeeperAuthScheme("connect_timeout=10&auth_scheme=sasl_digest&session_timeout=20", "digest")).toBe("connect_timeout=10&session_timeout=20");
  });

  it("reads legacy semicolon-separated parameters and case-insensitive keys", () => {
    expect(zooKeeperAuthScheme("connect_timeout=10;AUTH_SCHEME=sasl_digest;session_timeout=20")).toBe("sasl_digest");
  });

  it("removes every auth_scheme alias while preserving unrelated legacy parameters", () => {
    expect(setZooKeeperAuthScheme("connect_timeout=10;AUTH_SCHEME=digest&auth_scheme=sasl_digest;session_timeout=20", "digest")).toBe("connect_timeout=10&session_timeout=20");
  });
});
