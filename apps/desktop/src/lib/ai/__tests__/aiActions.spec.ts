import { describe, expect, it } from "vitest";
import { ASK_ACTIONS, AGENT_ACTIONS, defaultActionForMode, isValidActionForMode } from "@/lib/ai/ai";

describe("AI action mode mapping", () => {
  describe("defaultActionForMode", () => {
    it("defaults Ask to general", () => {
      expect(defaultActionForMode("ask")).toBe("general");
    });

    it("defaults Agent to general", () => {
      expect(defaultActionForMode("agent")).toBe("general");
    });
  });

  describe("isValidActionForMode", () => {
    it("accepts generate in both modes (shared SQL-only action)", () => {
      expect(isValidActionForMode("generate", "ask")).toBe(true);
      expect(isValidActionForMode("generate", "agent")).toBe(true);
    });

    it("accepts every Ask action in Ask mode", () => {
      for (const action of ASK_ACTIONS) {
        expect(isValidActionForMode(action, "ask")).toBe(true);
      }
    });

    it("accepts every Agent action in Agent mode", () => {
      for (const action of AGENT_ACTIONS) {
        expect(isValidActionForMode(action, "agent")).toBe(true);
      }
    });

    it("rejects Ask-only actions in Agent mode", () => {
      // explain/optimize/fix/convert/sampleData are SQL-text operations and must not
      // appear in the Agent (task-oriented) menu.
      for (const action of ["explain", "optimize", "fix", "convert", "sampleData"] as const) {
        expect(isValidActionForMode(action, "agent")).toBe(false);
      }
    });

    it("rejects Agent-only actions in Ask mode", () => {
      for (const action of ["query", "exploreSchema", "executeAndExplain"] as const) {
        expect(isValidActionForMode(action, "ask")).toBe(false);
      }
    });
  });

  describe("action sets", () => {
    it("Ask menu starts with general, then SQL-producing actions", () => {
      expect(ASK_ACTIONS).toEqual(["general", "generate", "explain", "optimize", "fix", "convert", "sampleData"]);
    });

    it("Agent menu starts with general, then task-oriented actions", () => {
      expect(AGENT_ACTIONS[0]).toBe("general");
      // generate is shared so users can still request SQL-only output.
      expect(AGENT_ACTIONS).toContain("generate");
      expect(AGENT_ACTIONS).toEqual(["general", "query", "exploreSchema", "executeAndExplain", "generate"]);
    });
  });
});
