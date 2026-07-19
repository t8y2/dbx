import { describe, expect, it } from "vitest";
import { normalizeRocketmqNamesrvAddr } from "@/lib/connection/rocketmqNamesrv";

describe("normalizeRocketmqNamesrvAddr", () => {
  it("normalizes a single host:port address", () => {
    expect(normalizeRocketmqNamesrvAddr("127.0.0.1:9876")).toBe("127.0.0.1:9876");
  });

  it("joins multiple addresses separated by commas", () => {
    expect(normalizeRocketmqNamesrvAddr("127.0.0.1:9876, 192.168.1.2:9876")).toBe("127.0.0.1:9876;192.168.1.2:9876");
  });

  it("rejects empty input", () => {
    expect(() => normalizeRocketmqNamesrvAddr("   ")).toThrow(/required/i);
  });

  it("rejects URL schemes", () => {
    expect(() => normalizeRocketmqNamesrvAddr("http://127.0.0.1:9876")).toThrow(/without a URL scheme/i);
  });
});
