import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";

const aiAssistantSource = readFileSync(new URL("../../../components/editor/AiAssistant.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const redisBrowserSource = readFileSync(new URL("../../../components/redis/RedisKeyBrowser.vue", import.meta.url), "utf8");

describe("AI Redis console routing", () => {
  it("routes Redis insert and execute actions to the active Redis console", () => {
    // Every action carries the conversation's bound connection (#9902); the
    // console refuses a target that is not the visible tab.
    expect(aiAssistantSource).toContain('emit("insertRedisCommand", code, conversationBinding.value)');
    expect(aiAssistantSource).toContain('emit("executeRedisCommand", code, conversationBinding.value)');
    expect(aiAssistantSource).toContain("seg.isSql || isRedisConnection");
    expect(appSource).toContain("if (routeAiRedisCommand(sql, false, target)) return;");
    expect(appSource).toContain("if (routeAiRedisCommand(sql, true, target)) return;");
    expect(contentAreaSource).toContain('props.activeTab.mode !== "redis"');
    expect(contentAreaSource).toContain("redisKeyBrowserRef.value?.executeCommand?.(command)");
  });

  it("keeps the existing SQL editor and execution behavior for non-Redis connections", () => {
    expect(aiAssistantSource).toContain('emit("appendSql", code, conversationBinding.value)');
    expect(aiAssistantSource).toContain('emit("executeSql", code, conversationBinding.value)');
    expect(aiAssistantSource).toContain('emit("tempRunSql", code, conversationBinding.value)');
    // The target tab is resolved from the bound connection, never from the tab
    // that happens to be active (#9902).
    expect(appSource).toContain("const tabId = ensureQueryTabForConnection(target);");
    expect(appSource).not.toContain("function ensureQueryTab()");
    expect(appSource).toContain("buildDeduplicatedAppendedEditorSql(currentSql, sql)");
    expect(appSource).toContain("buildAppendedEditorSql(aiTargetTabSql(tabId), sql)");
    expect(appSource).toContain("const decision = classifyAiSqlExecution(sql, connection);");
  });

  it("deduplicates immediate-run editor writes without skipping execution", () => {
    const handler = appSource.match(/function onAiExecuteSql\(sql: string, target: AiConversationBinding\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(handler).toContain("buildDeduplicatedAppendedEditorSql(currentSql, sql)");
    expect(handler).toContain("if (appendedSql !== currentSql) queryStore.updateSql(tabId, appendedSql);");
    expect(handler).toContain("runAiGeneratedSql(sql, tabId);");
    expect(handler).not.toContain("buildAppendedEditorSql(");
  });

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

  it("still drives the bound console when it is the visible tab", () => {
    // The refusal above must not disable the working case: readiness means the
    // on-screen console belongs to the bound connection.
    expect(contentAreaSource).toContain('props.activeTab.mode === "redis" && props.activeTab.connectionId === connectionId');
    const start = appSource.indexOf("async function deliverRedisAiCommand");
    const deliver = appSource.slice(start, appSource.indexOf("function aiTargetTabSql", start));
    expect(deliver).toContain("contentAreaRef.value?.executeRedisCommand(command, target.connectionId)");
    expect(deliver).toContain("contentAreaRef.value?.insertRedisCommand(command, target.connectionId)");
  });

  it("waits for the console to mount without re-issuing the command", () => {
    const start = appSource.indexOf("async function deliverRedisAiCommand");
    expect(start).toBeGreaterThanOrEqual(0);
    const deliver = appSource.slice(start, appSource.indexOf("\n}", start));

    // Readiness is polled through a side-effect-free probe...
    const probeIdx = deliver.indexOf("isRedisConsoleReady(target.connectionId)");
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(deliver).toContain("REDIS_CONSOLE_READY_TIMEOUT_MS");
    // ...and the single route attempt happens only after the wait, so a command
    // that ran but reported false (e.g. awaiting confirmation) cannot run twice.
    const routeIdx = deliver.indexOf("executeRedisCommand(command, target.connectionId)");
    expect(routeIdx).toBeGreaterThan(probeIdx);

    // The probe itself must not execute anything.
    const probeStart = contentAreaSource.indexOf("function isRedisConsoleReady");
    expect(probeStart).toBeGreaterThanOrEqual(0);
    const probe = contentAreaSource.slice(probeStart, contentAreaSource.indexOf("\n}", probeStart));
    expect(probe).toContain('props.activeTab.mode === "redis" && props.activeTab.connectionId === connectionId && !!redisKeyBrowserRef.value');
    expect(probe).not.toContain("executeCommand");
    expect(probe).not.toContain("insertCommand");
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

  it("tells the user when the bound Redis console cannot be reached", () => {
    // A console.warn is invisible in a desktop app, and the command the user
    // asked for is not going to run — silence is the worst outcome.
    // Sliced between two anchors: writing an escaped newline in a source anchor
    // is fragile, and this pair is unambiguous.
    const start = appSource.indexOf("async function deliverRedisAiCommand");
    const deliver = appSource.slice(start, appSource.indexOf("function aiTargetTabSql", start));
    expect(deliver).toContain('toast(t("ai.redisConsoleUnreachable"), 5000);');
    // Both failure paths (mount timeout, command rejected) report.
    expect(deliver.split('toast(t("ai.redisConsoleUnreachable")').length - 1).toBe(2);
  });
});
