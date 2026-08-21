import { describe, expect, it } from "vitest";
import { applyStatusEvent, createGenerationStatus, liveAnnouncementText, markCancelling, shouldShowLongRunningHint, statusText, toolLabel, STATUS_IDLE_THRESHOLD_MS, STATUS_LONG_RUNNING_THRESHOLD_MS, type AiStatusTranslate } from "@/lib/ai/aiGenerationStatus";

// Mock vue-i18n `t` mirroring the zh-CN copy matrix (Issue #6743 feature 1).
const t: AiStatusTranslate = (key: string, named?: Record<string, unknown>) => {
  switch (key) {
    case "ai.status.waitingModel":
      return `等待模型响应 · 已运行 ${named?.elapsed}s`;
    case "ai.status.waitingModelLive":
      return "等待模型响应";
    case "ai.status.generating":
      return `正在生成回复 · 已运行 ${named?.elapsed}s`;
    case "ai.status.generatingLive":
      return "正在生成回复";
    case "ai.status.runningTool":
      return `第 ${named?.turn} 轮 · 正在执行 ${named?.tool} · 已运行 ${named?.elapsed}s`;
    case "ai.status.runningToolAction":
      return "· 正在执行";
    case "ai.status.turnBadge":
      return `第 ${named?.turn} 轮`;
    case "ai.status.idle":
      return `等待此步骤完成 · 最后活动 ${named?.idle}s 前`;
    case "ai.status.idleLive":
      return "等待此步骤完成";
    case "ai.status.idleWithTool":
      return `等待此步骤完成 · 最后活动 ${named?.idle}s 前 · 正在执行 ${named?.tool}`;
    case "ai.status.cancelling":
      return "正在取消…";
    case "ai.status.toolLabels.executeSql":
      return "执行 SQL";
    case "ai.status.toolLabels.listTables":
      return "列出数据表";
    default:
      return key;
  }
};

const T0 = 1_000_000_000;

describe("aiGenerationStatus", () => {
  describe("createGenerationStatus", () => {
    it("starts in preparing with startedAt = now and no event state", () => {
      const status = createGenerationStatus(T0);
      expect(status).toEqual({ startedAt: T0, phase: "preparing" });
      expect(status.lastEventAt).toBeUndefined();
      expect(status.turn).toBeUndefined();
      expect(status.activeTool).toBeUndefined();
    });
  });

  describe("applyStatusEvent (event-driven phase transitions)", () => {
    it("any event refreshes lastEventAt", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 5_000);
      expect(status.lastEventAt).toBe(T0 + 5_000);
      status = applyStatusEvent(status, { type: "context_compacted", summary: "…", summary_tokens: 0, compacted_messages: 1, estimated_before: 10, estimated_after: 5 }, T0 + 9_000);
      expect(status.lastEventAt).toBe(T0 + 9_000);
    });

    it("turn_start records the 0-based turn", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 1 }, T0 + 1_000);
      expect(status.turn).toBe(1);
    });

    it("tool_call_start enters running_tool and sets activeTool", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      expect(status.phase).toBe("running_tool");
      expect(status.activeTool).toEqual({ name: "execute_sql", startedAt: T0 + 1_000 });
    });

    it("tool_call_end clears activeTool and falls back to generating (regression: activeTool must be cleared)", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_end", tool_call_id: "c1", tool_name: "execute_sql", result: {}, is_error: false }, T0 + 3_000);
      expect(status.activeTool).toBeUndefined();
      expect(status.phase).toBe("generating");
    });

    it("a second tool_call_start while one is active replaces activeTool (no stuck stale tool)", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c2", tool_name: "list_tables", args: {} }, T0 + 2_000);
      expect(status.phase).toBe("running_tool");
      expect(status.activeTool).toEqual({ name: "list_tables", startedAt: T0 + 2_000 });
    });

    it("reasoning_delta without an active tool enters generating", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "reasoning_delta", delta: "think" }, T0 + 1_000);
      expect(status.phase).toBe("generating");
    });

    it("text_delta while a tool is active does not overwrite running_tool", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "text_delta", delta: "partial" }, T0 + 2_000);
      expect(status.phase).toBe("running_tool");
      expect(status.activeTool).toBeDefined();
    });

    it("write_sql_confirmation_required / production_write_blocked / context_compacted only refresh lastEventAt, never the phase", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "write_sql_confirmation_required", sql: "UPDATE t SET x=1" }, T0 + 2_000);
      expect(status.phase).toBe("preparing");
      expect(status.lastEventAt).toBe(T0 + 2_000);
      status = applyStatusEvent(status, { type: "production_write_blocked", sql: "DELETE FROM t" }, T0 + 3_000);
      expect(status.phase).toBe("preparing");
      status = applyStatusEvent(status, { type: "context_compacted", summary: "…", summary_tokens: 0, compacted_messages: 1, estimated_before: 10, estimated_after: 5 }, T0 + 4_000);
      expect(status.phase).toBe("preparing");
      expect(status.lastEventAt).toBe(T0 + 4_000);
    });

    it("agent_end / error are terminal and clear the status", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 2_000);
      expect(status.phase).toBe("preparing");
      expect(status.activeTool).toBeUndefined();
      expect(status.lastEventAt).toBeUndefined();

      status = applyStatusEvent(createGenerationStatus(T0), { type: "text_delta", delta: "hi" }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "error", message: "boom" }, T0 + 2_000);
      expect(status.phase).toBe("preparing");
      expect(status.lastEventAt).toBeUndefined();
    });

    it("once cancelling, later agent events do not overwrite the cancelling phase", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "text_delta", delta: "hi" }, T0 + 1_000);
      status = markCancelling(status, T0 + 2_000);
      status = applyStatusEvent(status, { type: "text_delta", delta: "late" }, T0 + 3_000);
      expect(status.phase).toBe("cancelling");
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c2", tool_name: "execute_sql", args: {} }, T0 + 4_000);
      expect(status.phase).toBe("cancelling");
      expect(status.activeTool).toBeUndefined();
    });
  });

  describe("statusText copy priority", () => {
    it("shows 等待模型响应 with elapsed when no event has arrived yet", () => {
      const status = createGenerationStatus(T0);
      expect(statusText(status, T0 + 42_000, t)).toBe("等待模型响应 · 已运行 42s");
    });

    it("shows 正在生成回复 after a delta", () => {
      // Delta 1s before `now` so the idle branch (20s) must NOT win.
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "text_delta", delta: "hi" }, T0 + 41_000);
      expect(statusText(status, T0 + 42_000, t)).toBe("正在生成回复 · 已运行 42s");
    });

    it("shows 第 N 轮 · 正在执行 {tool} for a running tool with turn + 1", () => {
      // Tool started 1s before `now` so the idle branch (20s) must NOT win.
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 1 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 41_000);
      expect(statusText(status, T0 + 42_000, t)).toBe("第 2 轮 · 正在执行 执行 SQL · 已运行 42s");
    });

    it("defaults the turn to 1 when a tool runs before any turn_start", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 41_000);
      expect(statusText(status, T0 + 42_000, t)).toBe("第 1 轮 · 正在执行 执行 SQL · 已运行 42s");
    });

    it("switches to the idle copy when the last event is older than 20s", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 1_000);
      const now = T0 + 1_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      expect(statusText(status, now, t)).toBe("等待此步骤完成 · 最后活动 21s 前");
    });

    it("idle copy appends the active tool when a tool is running", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      const now = T0 + 1_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      expect(statusText(status, now, t)).toBe("等待此步骤完成 · 最后活动 21s 前 · 正在执行 执行 SQL");
    });

    it("MUST NOT hit the idle branch when lastEventAt is undefined, even past 20s of elapsed time", () => {
      const status = createGenerationStatus(T0);
      expect(statusText(status, T0 + 42_000, t)).toBe("等待模型响应 · 已运行 42s");
    });

    it("shows the cancelling copy once the user requested stop", () => {
      let status = createGenerationStatus(T0);
      status = markCancelling(status, T0 + 5_000);
      expect(statusText(status, T0 + 5_000, t)).toBe("正在取消…");
    });

    it("rounds elapsed up to whole seconds", () => {
      const status = createGenerationStatus(T0);
      expect(statusText(status, T0 + 1, t)).toBe("等待模型响应 · 已运行 1s");
      expect(statusText(status, T0 + 1_000, t)).toBe("等待模型响应 · 已运行 1s");
      expect(statusText(status, T0 + 1_001, t)).toBe("等待模型响应 · 已运行 2s");
    });

    it("idle seconds are rounded up as well", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 1_000);
      const now = T0 + 1_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      expect(statusText(status, now, t)).toContain("最后活动 21s 前");
    });
  });

  describe("liveAnnouncementText (screen-reader live region)", () => {
    // The live region MUST NOT contain the ticking elapsed/idle numerals — a
    // per-second re-announcement would spam screen-reader users. Assert the
    // announced string never embeds a "\d+s" countdown.
    const expectNoTickingSeconds = (announced: string) => {
      expect(announced).not.toMatch(/\d+s/);
    };

    it("announces stable state without elapsed numerals (waiting model)", () => {
      const status = createGenerationStatus(T0);
      const announced = liveAnnouncementText(status, T0 + 42_000, t);
      expect(announced).toBe("等待模型响应");
      expectNoTickingSeconds(announced);
    });

    it("announces generating without elapsed numerals", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "text_delta", delta: "hi" }, T0 + 41_000);
      const announced = liveAnnouncementText(status, T0 + 42_000, t);
      expect(announced).toBe("正在生成回复");
      expectNoTickingSeconds(announced);
    });

    it("announces the running tool with turn + 1, no elapsed numerals", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 1 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 41_000);
      const announced = liveAnnouncementText(status, T0 + 42_000, t);
      expect(announced).toBe("第 2 轮 · 正在执行 执行 SQL");
      expectNoTickingSeconds(announced);
    });

    it("announces the idle cross once (waiting for step), still no idle seconds", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 1_000);
      const now = T0 + 1_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      const announced = liveAnnouncementText(status, now, t);
      expect(announced).toBe("等待此步骤完成");
      expectNoTickingSeconds(announced);
    });

    it("idle-with-tool announces the tool, no idle seconds", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 1_000);
      const now = T0 + 1_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      const announced = liveAnnouncementText(status, now, t);
      expect(announced).toBe("等待此步骤完成 · 正在执行 执行 SQL");
      expectNoTickingSeconds(announced);
    });

    it("announces cancelling when the user requested stop", () => {
      let status = markCancelling(createGenerationStatus(T0), T0 + 5_000);
      const announced = liveAnnouncementText(status, T0 + 5_000, t);
      expect(announced).toBe("正在取消…");
      expectNoTickingSeconds(announced);
    });
  });

  describe("shouldShowLongRunningHint (60s threshold)", () => {
    it("is hidden up to and at 60s, shown past 60s", () => {
      const status = createGenerationStatus(T0);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS)).toBe(false);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS + 1)).toBe(true);
    });
  });

  describe("toolLabel", () => {
    it("resolves known tools through the i18n map", () => {
      expect(toolLabel("execute_sql", t)).toBe("执行 SQL");
      expect(toolLabel("list_tables", t)).toBe("列出数据表");
    });

    it("falls back to the raw snake_case name for unknown tools", () => {
      expect(toolLabel("mystery_tool", t)).toBe("mystery_tool");
    });
  });
});
