import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRabbitmqAddresses, parseRabbitmqAddress } from "@/lib/connection/rabbitmqAddresses";

describe("RabbitMQ addresses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps comma-separated addresses", () => {
    expect(normalizeRabbitmqAddresses("node1:5672, node2:5672")).toBe("node1:5672,node2:5672");
  });

  it("appends the default AMQP port when missing", () => {
    expect(normalizeRabbitmqAddresses("127.0.0.1")).toBe("127.0.0.1:5672");
    expect(normalizeRabbitmqAddresses("node1, node2:5673")).toBe("node1:5672,node2:5673");
  });

  it("keeps IPv4 addresses with custom ports", () => {
    expect(normalizeRabbitmqAddresses("192.0.2.176:51016")).toBe("192.0.2.176:51016");
    expect(parseRabbitmqAddress("192.0.2.176:51016")).toEqual({ host: "192.0.2.176", port: 51016 });
  });

  it("parses IPv4 addresses without the browser URL implementation", () => {
    vi.stubGlobal(
      "URL",
      class {
        constructor() {
          throw new Error("custom schemes are unsupported");
        }
      },
    );
    expect(normalizeRabbitmqAddresses("192.0.2.176:51016")).toBe("192.0.2.176:51016");
    expect(parseRabbitmqAddress("192.0.2.176:51016")).toEqual({ host: "192.0.2.176", port: 51016 });
  });

  it("normalizes common address separators to commas", () => {
    expect(normalizeRabbitmqAddresses("node1:5672；node2:5672，node3:5672\nnode4:5672 node5:5672")).toBe("node1:5672,node2:5672,node3:5672,node4:5672,node5:5672");
  });

  it("keeps IPv6 addresses", () => {
    expect(normalizeRabbitmqAddresses("[::1]:5672;[2001:db8::1]:5672")).toBe("[::1]:5672,[2001:db8::1]:5672");
    expect(parseRabbitmqAddress("[::1]:5672")).toEqual({ host: "::1", port: 5672 });
  });

  it("appends the default port to IPv6 addresses without a port", () => {
    expect(normalizeRabbitmqAddresses("[::1]")).toBe("[::1]:5672");
    expect(parseRabbitmqAddress("[::1]")).toEqual({ host: "::1", port: 5672 });
  });

  it("rejects empty addresses", () => {
    expect(() => normalizeRabbitmqAddresses("   ")).toThrow("RabbitMQ addresses are required");
  });

  it("rejects addresses with URL schemes", () => {
    expect(() => normalizeRabbitmqAddresses("amqp://node1:5672,node2:5672")).toThrow("RabbitMQ addresses must be host:port values without a URL scheme");
  });

  it("rejects invalid address values", () => {
    expect(() => normalizeRabbitmqAddresses("node1:5672/path,node2:5672")).toThrow("RabbitMQ addresses are invalid");
  });

  it("rejects invalid ports", () => {
    expect(() => normalizeRabbitmqAddresses("node1:")).toThrow("RabbitMQ addresses are invalid");
    expect(() => normalizeRabbitmqAddresses("node1:0")).toThrow("RabbitMQ addresses are invalid");
    expect(() => normalizeRabbitmqAddresses("node1:65536")).toThrow("RabbitMQ addresses are invalid");
  });
});
