import { afterEach, describe, expect, it, vi } from "vitest";
import { applyStatusEvent, createGenerationStatus, createStatusTicker, liveAnnouncementText, markCancelling, nextStatusTickDelay, shouldShowLongRunningHint, statusText, toolLabel, STATUS_IDLE_THRESHOLD_MS, STATUS_LONG_RUNNING_THRESHOLD_MS, type AiStatusTranslate } from "@/lib/ai/aiGenerationStatus";

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

    it("keeps the newest running tool visible when an earlier parallel tool completes", () => {
      // `agent_loop` emits every ToolCallStart before executing read-only tools
      // in parallel. Results can complete in a different order, so ending c1
      // must not erase the still-running c2 status.
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "list_tables", args: {} }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c2", tool_name: "get_columns", args: {} }, T0 + 2_000);
      status = applyStatusEvent(status, { type: "tool_call_end", tool_call_id: "c1", tool_name: "list_tables", result: {}, is_error: false }, T0 + 3_000);

      expect(status.phase).toBe("running_tool");
      expect(status.activeTool).toEqual({ name: "get_columns", startedAt: T0 + 2_000 });

      status = applyStatusEvent(status, { type: "tool_call_end", tool_call_id: "c2", tool_name: "get_columns", result: {}, is_error: false }, T0 + 4_000);
      expect(status.phase).toBe("generating");
      expect(status.activeTool).toBeUndefined();
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

    it("agent_end is terminal: enters finished, preserves startedAt/turn, clears activeTool", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 1 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 2_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 3_000);
      expect(status.phase).toBe("finished");
      expect(status.activeTool).toBeUndefined();
      // lastEventAt is refreshed to the terminal event time; startedAt/turn survive
      // so the elapsed counter never resets to 0 on completion.
      expect(status.lastEventAt).toBe(T0 + 3_000);
      expect(status.startedAt).toBe(T0);
      expect(status.turn).toBe(1);
    });

    it("error is terminal: enters finished without resetting startedAt", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "text_delta", delta: "hi" }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "error", message: "boom" }, T0 + 2_000);
      expect(status.phase).toBe("finished");
      expect(status.lastEventAt).toBe(T0 + 2_000);
      expect(status.startedAt).toBe(T0);
    });

    it("once finished, later agent events do not overwrite the finished phase", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "text_delta", delta: "hi" }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 2_000);
      status = applyStatusEvent(status, { type: "text_delta", delta: "late" }, T0 + 3_000);
      expect(status.phase).toBe("finished");
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c2", tool_name: "execute_sql", args: {} }, T0 + 4_000);
      expect(status.phase).toBe("finished");
      expect(status.activeTool).toBeUndefined();
    });

    it("response_complete enters finalizing: clears activeTool, preserves startedAt/turn, refreshes lastEventAt", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 2 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c1", tool_name: "execute_sql", args: {} }, T0 + 2_000);
      status = applyStatusEvent(status, { type: "response_complete" }, T0 + 3_000);
      expect(status.phase).toBe("finalizing");
      expect(status.activeTool).toBeUndefined();
      expect(status.lastEventAt).toBe(T0 + 3_000);
      expect(status.startedAt).toBe(T0);
      expect(status.turn).toBe(2);
    });

    it("once finalizing, non-terminal events (text_delta / tool_call_start) do not flip the phase back", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "text_delta", delta: "hi" }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "response_complete" }, T0 + 2_000);
      status = applyStatusEvent(status, { type: "text_delta", delta: "late" }, T0 + 3_000);
      expect(status.phase).toBe("finalizing");
      status = applyStatusEvent(status, { type: "tool_call_start", tool_call_id: "c2", tool_name: "execute_sql", args: {} }, T0 + 4_000);
      expect(status.phase).toBe("finalizing");
      expect(status.activeTool).toBeUndefined();
      status = applyStatusEvent(status, { type: "response_complete" }, T0 + 5_000);
      expect(status.phase).toBe("finalizing");
    });

    it("agent_end / error advance from finalizing to the terminal finished phase", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "response_complete" }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 2_000);
      expect(status.phase).toBe("finished");
      expect(status.startedAt).toBe(T0);

      let failed = applyStatusEvent(createGenerationStatus(T0), { type: "response_complete" }, T0 + 1_000);
      failed = applyStatusEvent(failed, { type: "error", message: "exit 1" }, T0 + 2_000);
      expect(failed.phase).toBe("finished");
    });

    it("markCancelling on a finalizing status is a no-op", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "response_complete" }, T0 + 2_000);
      expect(markCancelling(status, T0 + 3_000).phase).toBe("finalizing");
    });

    it("statusText / liveAnnouncementText return an empty string for finalizing", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "response_complete" }, T0 + 1_000);
      expect(statusText(status, T0 + 42_000, t)).toBe("");
      expect(liveAnnouncementText(status, T0 + 42_000, t)).toBe("");
    });

    it("shouldShowLongRunningHint is false for finalizing", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "response_complete" }, T0 + 1_000);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS + 1)).toBe(false);
    });

    it("markCancelling on a finished status is a no-op", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "agent_end" }, T0 + 2_000);
      expect(markCancelling(status, T0 + 3_000).phase).toBe("finished");
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

    it("returns an empty string for a finished status (line is hidden), never the 0s residue copy", () => {
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "text_delta", delta: "hi" }, T0 + 41_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 42_000);
      expect(statusText(status, T0 + 42_000, t)).toBe("");
    });

    it("a finished status never leaks the idle copy, even with a very old lastEventAt", () => {
      // Regression for the "thinking…0s" residue: the finished guard must win over
      // the idle branch (and the waitingModel fallthrough), or a completed reply
      // could re-render "等待此步骤完成 · 最后活动 Ns 前".
      let status = createGenerationStatus(T0);
      status = applyStatusEvent(status, { type: "turn_start", turn: 0 }, T0 + 1_000);
      status = applyStatusEvent(status, { type: "agent_end" }, T0 + 42_000);
      const now = T0 + 42_000 + STATUS_IDLE_THRESHOLD_MS + 1;
      expect(statusText(status, now, t)).toBe("");
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

    it("announces nothing for a finished status (line is hidden)", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "agent_end" }, T0 + 42_000);
      const announced = liveAnnouncementText(status, T0 + 42_000, t);
      expect(announced).toBe("");
      expectNoTickingSeconds(announced);
    });
  });

  describe("shouldShowLongRunningHint (60s threshold)", () => {
    it("is hidden up to and at 60s, shown past 60s", () => {
      const status = createGenerationStatus(T0);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS)).toBe(false);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS + 1)).toBe(true);
    });

    it("is never shown for a finished status, even past 60s", () => {
      let status = applyStatusEvent(createGenerationStatus(T0), { type: "agent_end" }, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS + 1);
      expect(shouldShowLongRunningHint(status, T0 + STATUS_LONG_RUNNING_THRESHOLD_MS + 1)).toBe(false);
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

  describe("status ticker (createStatusTicker / nextStatusTickDelay)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("nextStatusTickDelay aligns to the next wall-clock second", () => {
      expect(nextStatusTickDelay(1_000_000_000)).toBe(1000); // exactly on a boundary -> next second
      expect(nextStatusTickDelay(1_000_000_123)).toBe(877); // 123ms in -> 877ms to the boundary
      expect(nextStatusTickDelay(1_000_000_999)).toBe(1); // 1ms before the boundary
    });

    it("start() seeds immediately then ticks once per whole second (not once per frame)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_123);
      const seen: number[] = [];
      const ticker = createStatusTicker((now) => seen.push(now));

      ticker.start(Date.now());
      expect(seen).toEqual([1_000_000_123]); // fresh timestamp seed at start

      // 876ms of elapsed time sits strictly before the next boundary -> no tick.
      vi.advanceTimersByTime(876);
      expect(seen).toHaveLength(1);

      // Crossing 1_000_001_000 fires exactly one boundary tick (not 60 frames).
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([1_000_000_123, 1_000_001_000]);

      // A whole second later -> exactly one more tick, re-aligned to the boundary.
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual([1_000_000_123, 1_000_001_000, 1_000_002_000]);
    });

    it("stop() cancels the pending tick and the ticker stays stopped", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_123);
      const seen: number[] = [];
      const ticker = createStatusTicker((now) => seen.push(now));

      ticker.start(Date.now());
      vi.advanceTimersByTime(1000);
      const countAfterBoundary = seen.length;
      expect(countAfterBoundary).toBe(2);

      ticker.stop();
      vi.advanceTimersByTime(10_000);
      expect(seen.length).toBe(countAfterBoundary);
    });

    it("start() after stop() re-seeds from the new time and keeps ticking", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_123);
      const seen: number[] = [];
      const ticker = createStatusTicker((now) => seen.push(now));

      ticker.start(Date.now());
      vi.advanceTimersByTime(877); // boundary tick at 1_000_001_000
      ticker.stop();
      ticker.start(Date.now()); // re-seed at 1_000_001_000
      expect(seen).toEqual([1_000_000_123, 1_000_001_000, 1_000_001_000]);

      vi.advanceTimersByTime(1000); // next boundary at 1_000_002_000
      expect(seen).toEqual([1_000_000_123, 1_000_001_000, 1_000_001_000, 1_000_002_000]);
    });
  });
});
