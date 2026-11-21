import { describe, expect, it } from "vitest";
import { normalizeAiSqlApplyTargetMode, resolveAiSqlTargetTabId, type AiSqlTargetTabCandidate } from "../aiSqlTargetTab";

describe("aiSqlTargetTab (#12438)", () => {
  describe("normalizeAiSqlApplyTargetMode", () => {
    it("accepts valid modes", () => {
      expect(normalizeAiSqlApplyTargetMode("current")).toBe("current");
      expect(normalizeAiSqlApplyTargetMode("first")).toBe("first");
      expect(normalizeAiSqlApplyTargetMode("new")).toBe("new");
    });

    it("falls back to current on invalid or missing inputs", () => {
      expect(normalizeAiSqlApplyTargetMode(undefined)).toBe("current");
      expect(normalizeAiSqlApplyTargetMode(null)).toBe("current");
      expect(normalizeAiSqlApplyTargetMode("invalid")).toBe("current");
      expect(normalizeAiSqlApplyTargetMode("invalid", "first")).toBe("first");
    });
  });

  describe("resolveAiSqlTargetTabId", () => {
    const tabs: AiSqlTargetTabCandidate[] = [
      { id: "tab-1", mode: "query", connectionId: "conn-1", database: "app", schema: "public" },
      { id: "tab-2", mode: "query", connectionId: "conn-1", database: "app", schema: "public" },
      { id: "tab-other-db", mode: "query", connectionId: "conn-1", database: "analytics", schema: "public" },
      { id: "tab-other-conn", mode: "query", connectionId: "conn-2", database: "app", schema: "public" },
      { id: "tab-data", mode: "data", connectionId: "conn-1", database: "app", schema: "public" },
      { id: "tab-readonly", mode: "query", connectionId: "conn-1", database: "app", schema: "public", readOnly: true },
      { id: "tab-object-source", mode: "query", connectionId: "conn-1", database: "app", schema: "public", objectSource: {} },
    ];

    it("returns empty string when target has no connectionId", () => {
      expect(resolveAiSqlTargetTabId(tabs, "tab-2", { connectionId: "" })).toBe("");
      expect(resolveAiSqlTargetTabId(tabs, "tab-2", {})).toBe("");
    });

    it("returns null in 'new' mode even if matching tabs exist", () => {
      expect(resolveAiSqlTargetTabId(tabs, "tab-2", { connectionId: "conn-1", database: "app", schema: "public" }, "new")).toBeNull();
    });

    it("in 'current' mode, prefers active tab if it matches target connection and database", () => {
      const result = resolveAiSqlTargetTabId(tabs, "tab-2", { connectionId: "conn-1", database: "app", schema: "public" }, "current");
      expect(result).toBe("tab-2");
    });

    it("in 'current' mode, falls back to first matching tab if active tab does not match", () => {
      // active tab is on different db
      expect(resolveAiSqlTargetTabId(tabs, "tab-other-db", { connectionId: "conn-1", database: "app", schema: "public" }, "current")).toBe("tab-1");

      // active tab is data mode
      expect(resolveAiSqlTargetTabId(tabs, "tab-data", { connectionId: "conn-1", database: "app", schema: "public" }, "current")).toBe("tab-1");

      // active tab is readOnly
      expect(resolveAiSqlTargetTabId(tabs, "tab-readonly", { connectionId: "conn-1", database: "app", schema: "public" }, "current")).toBe("tab-1");

      // active tab is object source
      expect(resolveAiSqlTargetTabId(tabs, "tab-object-source", { connectionId: "conn-1", database: "app", schema: "public" }, "current")).toBe("tab-1");

      // activeTabId is null/undefined
      expect(resolveAiSqlTargetTabId(tabs, null, { connectionId: "conn-1", database: "app", schema: "public" }, "current")).toBe("tab-1");
    });

    it("in 'first' mode, returns first matching tab even if active tab also matches", () => {
      const result = resolveAiSqlTargetTabId(tabs, "tab-2", { connectionId: "conn-1", database: "app", schema: "public" }, "first");
      expect(result).toBe("tab-1");
    });

    it("returns null when no matching tab exists", () => {
      expect(resolveAiSqlTargetTabId(tabs, "tab-1", { connectionId: "conn-1", database: "nonexistent" }, "current")).toBeNull();
      expect(resolveAiSqlTargetTabId(tabs, "tab-1", { connectionId: "conn-nonexistent", database: "app" }, "current")).toBeNull();
    });

    it("treats undefined and empty string databases as matching", () => {
      const emptyDbTabs: AiSqlTargetTabCandidate[] = [
        { id: "tab-empty-1", mode: "query", connectionId: "sqlite-1", database: "" },
        { id: "tab-empty-2", mode: "query", connectionId: "sqlite-1", database: "" },
      ];
      expect(resolveAiSqlTargetTabId(emptyDbTabs, "tab-empty-2", { connectionId: "sqlite-1" }, "current")).toBe("tab-empty-2");
      expect(resolveAiSqlTargetTabId(emptyDbTabs, "tab-empty-2", { connectionId: "sqlite-1" }, "first")).toBe("tab-empty-1");
    });
  });
});
