import { describe, expect, it } from "vitest";
import { ASK_ACTIONS, AGENT_ACTIONS, defaultActionForMode, isValidActionForMode } from "@/lib/ai/ai";

describe("AI action mode mapping", () => {
  describe("defaultActionForMode", () => {
    it("defaults Ask to generate", () => {
      expect(defaultActionForMode("ask")).toBe("generate");
    });

    it("defaults Agent to query (not generate)", () => {
      // The whole point of the feature: Agent mode must not default to SQL generation.
      expect(defaultActionForMode("agent")).toBe("query");
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
    it("Ask menu keeps the SQL-producing actions", () => {
      expect(ASK_ACTIONS).toEqual(["generate", "explain", "optimize", "fix", "convert", "sampleData"]);
    });

    it("Agent menu is task-oriented, starts with query, and still offers generate", () => {
      expect(AGENT_ACTIONS[0]).toBe("query");
      // generate is shared so users can still request SQL-only output ("生成但不执行").
      expect(AGENT_ACTIONS).toContain("generate");
      expect(AGENT_ACTIONS).toEqual(["query", "exploreSchema", "executeAndExplain", "generate"]);
    });
  });
});
