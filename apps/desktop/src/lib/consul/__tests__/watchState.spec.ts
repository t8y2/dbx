import { describe, expect, it } from "vitest";
import { isCurrentWatchEvent, nextWatchIndex } from "../watchState";
import type { ConsulWatchEvent } from "@/types/consul";

const event: ConsulWatchEvent = {
  connectionId: "connection-a",
  operationId: "watch-a",
  generation: 7,
  result: null,
  error: null,
};

describe("Consul watch lifecycle", () => {
  it("resets zero and regressed indexes to the minimum blocking index", () => {
    expect(nextWatchIndex("15", "0")).toEqual({ index: "1", reset: true });
    expect(nextWatchIndex("15", "14")).toEqual({ index: "1", reset: true });
    expect(nextWatchIndex("15", "16")).toEqual({ index: "16", reset: false });
  });

  it("rejects events from stale connections, operations, and scope generations", () => {
    expect(isCurrentWatchEvent({ connectionId: "connection-a", operationId: "watch-a", generation: 7 }, event)).toBe(true);
    expect(isCurrentWatchEvent({ connectionId: "connection-b", operationId: "watch-a", generation: 7 }, event)).toBe(false);
    expect(isCurrentWatchEvent({ connectionId: "connection-a", operationId: "watch-b", generation: 7 }, event)).toBe(false);
    expect(isCurrentWatchEvent({ connectionId: "connection-a", operationId: "watch-a", generation: 8 }, event)).toBe(false);
  });
});
