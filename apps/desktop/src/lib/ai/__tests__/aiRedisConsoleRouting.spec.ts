import { describe, expect, it } from "vitest";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";

describe("AI Redis console routing", () => {
  it("uses the console safety path", () => {
    expect(classifyRedisCommandSafety("CONFIG SET requirepass secret")).toBe("blocked");
    expect(classifyRedisCommandSafety("FLUSHDB")).toBe("blocked");
    expect(classifyRedisCommandSafety("SET issue:846 fixed")).toBe("write");
    expect(classifyRedisCommandSafety("INFO server")).toBe("allowed");
  });

  // Regression for review feedback: an unknown command inside a multi-line
  // batch must still fail the batch as blocked, regardless of its position,
  // so "DEL victim\nFCALL wipe 0" cannot sneak the destructive line past the
  // confirmation scan.
  it("blocks a batch whenever any line is an unknown command", () => {
    for (const batch of [
      // destructive first, unknown second
      ["DEL victim", "FCALL wipe 0"],
      // unknown first, destructive second
      ["FCALL wipe 0", "DEL victim"],
    ]) {
      const anyBlocked = batch.some((cmd) => classifyRedisCommandSafety(cmd) === "blocked");
      expect(anyBlocked).toBe(true);
    }
  });
});
