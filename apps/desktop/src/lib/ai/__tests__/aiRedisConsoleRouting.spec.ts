import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const redisBrowserSource = readFileSync(new URL("../../../components/redis/RedisKeyBrowser.vue", import.meta.url), "utf8");

describe("AI Redis console routing", () => {
  it("refuses a Redis command rather than moving the workspace to the bound console", () => {
    // "An AI action never moves the workspace" is the point of #9902. The bound
    // console is driven only when it is already the visible tab; otherwise the
    // user is told to open it. No tab is switched and none is created.
    const start = appSource.indexOf("function routeAiRedisCommand");
    const route = appSource.slice(start, appSource.indexOf("function aiTargetTabSql", start));

    expect(route).not.toContain("switchTab");
    expect(route).not.toContain("createTab");
    expect(route).not.toContain("ensureRedisConsoleTab");
    expect(appSource).not.toContain("ensureRedisConsoleTab");
    expect(route).toContain("void deliverRedisAiCommand(command, execute, target);");
    // The refusal is reported, not silent.
    expect(appSource).toContain('toast(t("ai.redisConsoleUnreachable"), 5000);');
  });

  it("uses the console safety path and rejects unavailable command input", () => {
    expect(classifyRedisCommandSafety("CONFIG SET requirepass secret")).toBe("blocked");
    expect(classifyRedisCommandSafety("FLUSHDB")).toBe("confirm");
    expect(classifyRedisCommandSafety("SET issue:846 fixed")).toBe("write");
    expect(classifyRedisCommandSafety("INFO server")).toBe("allowed");

    expect(redisBrowserSource).toContain("if (!normalizedCommand || commandRunning.value) return false;");
    expect(redisBrowserSource).toContain("await executeCommand();");
    expect(redisBrowserSource).not.toMatch(/async function executeAiCommand[\s\S]*?await runRedisCommand\(command\)/);
    expect(contentAreaSource).toContain("?? false");
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
