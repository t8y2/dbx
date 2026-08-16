import { describe, expect, it } from "vitest";
import { NATS_DEFAULT_SERVER_URL, natsConnectionTarget, natsServerUrlIsValid } from "@/lib/connection/natsConnection";

describe("natsConnectionTarget", () => {
  it("uses the standard local NATS endpoint by default", () => {
    expect(NATS_DEFAULT_SERVER_URL).toBe("nats://127.0.0.1:4222");
    expect(natsConnectionTarget(NATS_DEFAULT_SERVER_URL)).toEqual({
      serverUrl: NATS_DEFAULT_SERVER_URL,
      host: "127.0.0.1",
      port: 4222,
      tls: false,
    });
  });

  it("accepts tls URLs and applies the default NATS port", () => {
    expect(natsConnectionTarget("tls://nats.example.test")).toEqual({
      serverUrl: "tls://nats.example.test",
      host: "nats.example.test",
      port: 4222,
      tls: true,
    });
  });

  it("rejects unsupported schemes and credential-bearing URLs", () => {
    expect(natsServerUrlIsValid("https://nats.example.test:4222")).toBe(false);
    expect(natsServerUrlIsValid("nats://token@nats.example.test:4222")).toBe(false);
    expect(natsServerUrlIsValid("nats://nats.example.test:4222/stream")).toBe(false);
  });
});
