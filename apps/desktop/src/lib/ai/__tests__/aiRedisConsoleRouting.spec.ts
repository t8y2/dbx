import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";

const aiAssistantSource = readFileSync(new URL("../../../components/editor/AiAssistant.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const redisBrowserSource = readFileSync(new URL("../../../components/redis/RedisKeyBrowser.vue", import.meta.url), "utf8");

describe("AI Redis console routing", () => {
  it("routes Redis insert and execute actions to the active Redis console", () => {
    expect(aiAssistantSource).toContain('emit("insertRedisCommand", code)');
    expect(aiAssistantSource).toContain('emit("executeRedisCommand", code)');
    expect(aiAssistantSource).toContain("seg.isSql || isRedisConnection");
    expect(appSource).toContain("if (routeAiRedisCommand(sql, false)) return;");
    expect(appSource).toContain("if (routeAiRedisCommand(sql, true)) return;");
    expect(contentAreaSource).toContain('props.activeTab.mode !== "redis"');
    expect(contentAreaSource).toContain("redisKeyBrowserRef.value?.executeCommand?.(command)");
  });

  it("keeps the existing SQL editor and execution behavior for non-Redis connections", () => {
    expect(aiAssistantSource).toContain('emit("replaceSql", code)');
    expect(aiAssistantSource).toContain('emit("executeSql", code)');
    expect(aiAssistantSource).toContain('emit("tempRunSql", code)');
    expect(appSource).toContain("const tabId = ensureQueryTab();");
    expect(appSource).toContain('buildAppendedEditorSql(activeTab.value?.sql || "", sql)');
    expect(appSource).toContain("const decision = classifyAiSqlExecution(sql, activeConnection.value);");
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
});
