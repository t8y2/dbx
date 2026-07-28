import { describe, expect, it } from "vitest";
import { normalizeRabbitmqAddresses } from "@/lib/connection/rabbitmqAddresses";

describe("RabbitMQ addresses", () => {
  it("keeps comma-separated addresses", () => {
    expect(normalizeRabbitmqAddresses("node1:5672, node2:5672")).toBe("node1:5672,node2:5672");
  });

  it("appends the default AMQP port when missing", () => {
    expect(normalizeRabbitmqAddresses("127.0.0.1")).toBe("127.0.0.1:5672");
    expect(normalizeRabbitmqAddresses("node1, node2:5673")).toBe("node1:5672,node2:5673");
  });

  it("normalizes common address separators to commas", () => {
    expect(normalizeRabbitmqAddresses("node1:5672；node2:5672，node3:5672\nnode4:5672 node5:5672")).toBe("node1:5672,node2:5672,node3:5672,node4:5672,node5:5672");
  });

  it("keeps IPv6 addresses", () => {
    expect(normalizeRabbitmqAddresses("[::1]:5672;[2001:db8::1]:5672")).toBe("[::1]:5672,[2001:db8::1]:5672");
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
});
