import { describe, expect, it } from "vitest";
import { buildObjectBrowserRows } from "@/lib/table/objectBrowserRows";

describe("buildObjectBrowserRows", () => {
  it("preserves a resolved SQLite attached-database alias on every row", () => {
    const rows = buildObjectBrowserRows({
      objects: [{ name: "events", object_type: "TABLE" }],
      database: "analytics",
      fallbackSchema: "analytics",
      rowSchema: "analytics",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.schema).toBe("analytics");
  });

  it("keeps non-schema database rows unqualified when no row namespace is resolved", () => {
    const rows = buildObjectBrowserRows({
      objects: [{ name: "events", object_type: "TABLE" }],
      database: "app",
      fallbackSchema: "app",
    });

    expect(rows[0]?.schema).toBeUndefined();
  });
});
