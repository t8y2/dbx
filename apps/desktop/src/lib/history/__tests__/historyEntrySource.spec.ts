import { describe, expect, it } from "vitest";
import { historyEntrySource } from "@/lib/history/historyEntrySource";

describe("historyEntrySource", () => {
  it("identifies MCP entries from history details", () => {
    expect(historyEntrySource({ details_json: '{"source":"mcp"}' })).toBe("MCP");
  });

  it("ignores other, missing, or invalid details", () => {
    expect(historyEntrySource({ details_json: '{"source":"desktop"}' })).toBeNull();
    expect(historyEntrySource({ details_json: null })).toBeNull();
    expect(historyEntrySource({ details_json: "{" })).toBeNull();
  });
});
