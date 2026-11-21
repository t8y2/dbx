import { describe, expect, it, vi } from "vitest";
import { createAiConversationPickerController } from "@/lib/ai/aiConversationPickerState";
import type { AiPickerAmbient } from "@/lib/ai/aiConversationPicker";
import type { AiAssistantMode } from "@/types/ai";

/**
 * AC15 — the wiring order, not the rule table.
 *
 * A text assertion cannot show that restoring a conversation's mode leaves its
 * action alone; the pre-#12075 panel had two refs and a `watch(mode)` that reset
 * the action, which is exactly how "restore" silently turned into "the mode
 * default". These cases drive the real controller with a reactive ambient.
 */

function ambient(overrides: Partial<AiPickerAmbient> = {}): AiPickerAmbient {
  return { defaultMode: "ask", defaultAutoRouting: false, ...overrides };
}

function controller(overrides: Partial<AiPickerAmbient> = {}) {
  const onUserSelection = vi.fn();
  const state = { ...ambient(overrides) };
  const picker = createAiConversationPickerController({ ambient: () => state, onUserSelection });
  return { picker, onUserSelection, state };
}

describe("createAiConversationPickerController", () => {
  it("restores a conversation's own pair without resetting the action through the mode watcher", async () => {
    const { picker, onUserSelection } = controller();
    picker.restore({ mode: "agent", action: "exploreSchema" });

    // Mode first, action second is the historical restore order — and it used to
    // be undone by the mode watcher on the next flush.
    expect(picker.mode.value).toBe("agent");
    expect(picker.action.value).toBe("exploreSchema");
    await Promise.resolve();
    expect(picker.mode.value).toBe("agent");
    expect(picker.action.value).toBe("exploreSchema");
    // A restore is not a user operation, so nothing is written back.
    expect(onUserSelection).not.toHaveBeenCalled();
  });

  it("keeps a later mode change resetting the action (pre-existing behavior, #9118)", () => {
    const { picker } = controller();
    picker.restore({ mode: "agent", action: "exploreSchema" });
    picker.selectMode("ask");
    // The mode's own default, not the Agent action it was standing on.
    expect(picker.action.value).toBe("general");
  });

  it("lets a mode change land on the Auto entry only when the settings toggle says so", () => {
    const { picker } = controller({ defaultAutoRouting: true });
    picker.selectMode("agent");
    expect(picker.action.value).toBe("auto");
    picker.selectMode("ask");
    expect(picker.action.value).toBe("auto");
  });

  it("does not let an earlier pair write poison the next user mode change", () => {
    // The ownership handshake is consumed synchronously by the assignment that
    // changes the mode; a leftover flag would swallow the next reset.
    for (const sameMode of [false, true]) {
      const { picker } = controller();
      // A pair write that moves the mode (false) and one that does not (true).
      picker.restore({ mode: sameMode ? "ask" : "agent", action: "query" });
      picker.restore({ mode: "agent", action: "exploreSchema" });
      picker.selectMode("agent");
      expect(picker.action.value).toBe("general");
      picker.selectMode("ask");
      expect(picker.action.value).toBe("general");
    }
  });

  it("records a user picker operation with the chosen entry, not the routed action", () => {
    const { picker, onUserSelection } = controller();
    picker.selectAction("auto");
    expect(onUserSelection).toHaveBeenLastCalledWith({ mode: "ask", action: "auto" });
    picker.selectMode("agent");
    expect(onUserSelection).toHaveBeenLastCalledWith({ mode: "agent", action: "general" });
  });

  it("records the user's own value even when a capability limits what is shown (R9)", () => {
    const { picker, onUserSelection, state } = controller();
    picker.selectMode("agent");
    picker.selectAction("query");
    expect(picker.action.value).toBe("query");

    // The connection turns into a vector DB mid-session: the picker is hidden and
    // forced onto `generate`, but the recorded value stays `query`.
    state.vectorDb = true;
    picker.restore({ mode: "agent", action: "query" });
    expect(picker.action.value).toBe("generate");
    expect(onUserSelection).toHaveBeenLastCalledWith({ mode: "agent", action: "query" });
    expect(onUserSelection).toHaveBeenCalledTimes(2);

    // Back on a relational connection, the original pick returns.
    state.vectorDb = false;
    picker.restore({ mode: "agent", action: "query" });
    expect(picker.action.value).toBe("query");
  });

  it("degrades a plugin conversation without a connection but restores it with one", () => {
    const { picker, state } = controller();
    state.pluginSession = true;
    state.pluginWithoutConnection = true;
    picker.restore({ mode: "agent", action: "query" });
    expect(picker.mode.value).toBe("ask");
    expect(picker.action.value).toBe("general");

    state.pluginWithoutConnection = false;
    picker.restore({ mode: "agent", action: "query" });
    expect(picker.mode.value).toBe("agent");
    expect(picker.action.value).toBe("general");
  });

  it("starts a new chat from the settings default in every toggle state (R3)", () => {
    const cases: Array<{ mode: AiAssistantMode; auto: boolean; expected: { mode: AiAssistantMode; action: string } }> = [
      { mode: "ask", auto: false, expected: { mode: "ask", action: "general" } },
      { mode: "agent", auto: false, expected: { mode: "agent", action: "general" } },
      { mode: "agent", auto: true, expected: { mode: "agent", action: "auto" } },
    ];
    for (const item of cases) {
      const { picker } = controller({ defaultMode: item.mode, defaultAutoRouting: item.auto });
      // Start from a different pair: a new chat must not inherit it.
      picker.restore({ mode: "agent", action: "exploreSchema" });
      picker.restoreDefault();
      expect(picker.mode.value).toBe(item.expected.mode);
      expect(picker.action.value).toBe(item.expected.action);
    }
  });

  it("forces vector DBs onto `generate` even for a new chat, where Auto is never offered", () => {
    const { picker } = controller({ defaultMode: "agent", defaultAutoRouting: true, vectorDb: true });
    picker.restoreDefault();
    expect(picker.action.value).toBe("generate");
  });
});
