import { describe, expect, it } from "vitest";
import { applyCapabilities, isPickerSelectionValidForMode, resolveConversationPicker, resolveDefaultPickerAction, resolveDefaultPickerSelection, type AiPickerAmbient } from "@/lib/ai/aiConversationPicker";

/**
 * #12075 / #12076 — a conversation owns its Ask/Agent mode and action selection.
 *
 * These are the R9 decision table and the R10 read priority as pure rules. The
 * component wiring is pinned separately in
 * `components/editor/__tests__/AiAssistant.conversationPicker.spec.ts`, but the
 * fallback / write-back semantics live here because a text assertion cannot show
 * whether a capability limit leaked into the recorded value.
 */

function ambient(overrides: Partial<AiPickerAmbient> = {}): AiPickerAmbient {
  return { defaultMode: "ask", defaultAutoRouting: false, ...overrides };
}

describe("resolveConversationPicker", () => {
  it("restores a conversation's own recorded selection in both layers", () => {
    const resolution = resolveConversationPicker({ assistantMode: "agent", assistantAction: "query" }, ambient());
    expect(resolution.raw).toEqual({ mode: "agent", action: "query" });
    expect(resolution.effective).toEqual({ mode: "agent", action: "query" });
  });

  it("keeps `auto` as a first-class recorded value, not a routed concrete action", () => {
    // R8: the picker restores the entry the user chose; routing happens at send.
    for (const mode of ["ask", "agent"] as const) {
      const resolution = resolveConversationPicker({ assistantMode: mode, assistantAction: "auto" }, ambient({ defaultAutoRouting: false }));
      expect(resolution.raw.action).toBe("auto");
      expect(resolution.effective.action).toBe("auto");
    }
  });

  it("falls back on an unknown mode without writing it back", () => {
    for (const stored of [undefined, "", "AGENT", "expert"]) {
      const resolution = resolveConversationPicker({ assistantMode: stored, assistantAction: "optimize" }, ambient({ defaultMode: "agent" }));
      // `optimize` is an Ask action, so the Agent default mode makes it
      // incompatible — the mode's own default is used instead (next case).
      expect(resolution.raw.mode).toBeUndefined();
      expect(resolution.effective.mode).toBe("agent");
      expect(resolution.effective.action).toBe("general");
      expect(resolution.raw.action).toBe("optimize");
    }
  });

  it("falls back on an unknown mode to a compatible default action", () => {
    const resolution = resolveConversationPicker({ assistantMode: undefined, assistantAction: "optimize" }, ambient({ defaultMode: "ask" }));
    expect(resolution.effective).toEqual({ mode: "ask", action: "optimize" });
    // The action was known and valid, so it is still the recorded value.
    expect(resolution.raw.action).toBe("optimize");
  });

  it("falls back on an unknown action through the default-selection chain", () => {
    const off = resolveConversationPicker({ assistantMode: "agent", assistantAction: "summarize" }, ambient({ defaultAutoRouting: false }));
    expect(off.effective).toEqual({ mode: "agent", action: "general" });
    expect(off.raw).toEqual({ mode: "agent", action: undefined });

    // R9 blurbs "the fallback is re-validated by the same chain": the Auto
    // toggle makes the fallback the Auto entry, exactly like a new chat.
    const on = resolveConversationPicker({ assistantMode: "agent" }, ambient({ defaultAutoRouting: true }));
    expect(on.effective).toEqual({ mode: "agent", action: "auto" });
  });

  it("lands a known-but-incompatible action on the mode's own default, never migrating the mode", () => {
    const resolution = resolveConversationPicker({ assistantMode: "ask", assistantAction: "executeAndExplain" }, ambient({ defaultMode: "agent" }));
    expect(resolution.effective).toEqual({ mode: "ask", action: "general" });
    expect(resolution.raw).toEqual({ mode: "ask", action: "executeAndExplain" });
  });

  it("treats `auto` as legal in every mode while a concrete action is mode-bound", () => {
    expect(isPickerSelectionValidForMode("auto", "ask")).toBe(true);
    expect(isPickerSelectionValidForMode("auto", "agent")).toBe(true);
    expect(isPickerSelectionValidForMode("query", "agent")).toBe(true);
    expect(isPickerSelectionValidForMode("query", "ask")).toBe(false);
  });

  it("reads assistant_mode before pluginContext.mode and the settings default (R10)", () => {
    // Both present: the column wins.
    expect(resolveConversationPicker({ assistantMode: "agent", assistantAction: "query", pluginContextMode: "ask" }, ambient()).effective).toEqual({ mode: "agent", action: "query" });
    // Only the legacy plugin field: it is still honoured.
    expect(resolveConversationPicker({ pluginContextMode: "agent", assistantAction: "query" }, ambient()).effective).toEqual({ mode: "agent", action: "query" });
    // Neither: the settings default.
    expect(resolveConversationPicker({}, ambient({ defaultMode: "agent" })).effective.mode).toBe("agent");
    // An unknown pluginContext value falls through to the default too.
    expect(resolveConversationPicker({ pluginContextMode: "hybrid" }, ambient({ defaultMode: "agent" })).effective.mode).toBe("agent");
  });

  it("does not write the plugin fallback back into raw", () => {
    const resolution = resolveConversationPicker({ pluginContextMode: "agent" }, ambient({ defaultMode: "ask" }));
    expect(resolution.effective.mode).toBe("agent");
    // `pluginContext.mode` stays the single fallback source; nothing is promoted
    // into the new column (R10 "no double write").
    expect(resolution.raw.mode).toBeUndefined();
  });

  it("limits a vector-DB conversation to `generate` without overwriting the record", () => {
    const resolution = resolveConversationPicker({ assistantMode: "agent", assistantAction: "query" }, ambient({ vectorDb: true }));
    expect(resolution.effective).toEqual({ mode: "agent", action: "generate" });
    expect(resolution.raw).toEqual({ mode: "agent", action: "query" });

    // Same conversation on a relational connection restores the original pick.
    expect(resolveConversationPicker({ assistantMode: "agent", assistantAction: "query" }, ambient()).effective).toEqual({ mode: "agent", action: "query" });
  });

  it("degrades a plugin conversation without a connection but keeps the recorded Agent", () => {
    const record = { assistantMode: "agent", assistantAction: "query" };
    const degraded = resolveConversationPicker(record, ambient({ pluginSession: true, pluginWithoutConnection: true }));
    expect(degraded.effective).toEqual({ mode: "ask", action: "general" });
    expect(degraded.raw).toEqual({ mode: "agent", action: "query" });

    // Once a connection exists the original Agent + action come back.
    const connected = resolveConversationPicker(record, ambient({ pluginSession: true }));
    expect(connected.effective).toEqual({ mode: "agent", action: "general" });
    expect(connected.raw).toEqual({ mode: "agent", action: "query" });
  });

  it("keeps a plugin conversation on `general` because the plugin lane always sends it", () => {
    const resolution = resolveConversationPicker({ assistantMode: "agent", assistantAction: "auto" }, ambient({ pluginSession: true }));
    expect(resolution.effective.action).toBe("general");
    expect(resolution.raw.action).toBe("auto");
  });
});

describe("default selection helpers", () => {
  it("returns the Auto entry only when the Settings toggle says so (#9118)", () => {
    expect(resolveDefaultPickerSelection("ask", ambient({ defaultAutoRouting: false }))).toBe("general");
    expect(resolveDefaultPickerSelection("agent", ambient({ defaultAutoRouting: false }))).toBe("general");
    expect(resolveDefaultPickerSelection("agent", ambient({ defaultAutoRouting: true }))).toBe("auto");
  });

  it("never returns the Auto sentinel from the concrete default", () => {
    expect(resolveDefaultPickerAction("agent", ambient({ defaultAutoRouting: true }))).toBe("general");
    expect(resolveDefaultPickerAction("ask", ambient())).toBe("general");
  });

  it("forces `generate` for vector DBs and `general` for plugin lanes", () => {
    expect(resolveDefaultPickerSelection("ask", ambient({ vectorDb: true, defaultAutoRouting: true }))).toBe("generate");
    expect(resolveDefaultPickerAction("agent", ambient({ vectorDb: true }))).toBe("generate");
    expect(resolveDefaultPickerSelection("agent", ambient({ pluginSession: true }))).toBe("general");
    expect(resolveDefaultPickerAction("agent", ambient({ pluginSession: true }))).toBe("general");
  });
});

describe("applyCapabilities", () => {
  it("is the only place a limit is applied, leaving raw untouched upstream", () => {
    expect(applyCapabilities({ mode: "agent", action: "query" }, ambient())).toEqual({ mode: "agent", action: "query" });
    expect(applyCapabilities({ mode: "agent", action: "query" }, ambient({ vectorDb: true }))).toEqual({ mode: "agent", action: "generate" });
    expect(applyCapabilities({ mode: "agent", action: "exploreSchema" }, ambient({ pluginSession: true, pluginWithoutConnection: true }))).toEqual({ mode: "ask", action: "general" });
  });
});
