import { describe, expect, it } from "vitest";
import { buildObjectBrowserRows, countObjectBrowserRowsByFilter, normalizeObjectBrowserType } from "./objectBrowserRows";

describe("object browser Event rows", () => {
  it("normalizes and counts MySQL events", () => {
    expect(normalizeObjectBrowserType("EVENT")).toBe("EVENT");
    const rows = buildObjectBrowserRows({ database: "shop", fallbackSchema: "shop", objects: [{ name: "daily_sync", object_type: "EVENT", schema: "shop", comment: null, created_at: null, updated_at: null, parent_schema: null, parent_name: null }] });
    expect(rows[0]?.type).toBe("EVENT");
    expect(countObjectBrowserRowsByFilter(rows).events).toBe(1);
  });
});
