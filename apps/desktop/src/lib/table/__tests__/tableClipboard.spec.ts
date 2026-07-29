import { describe, expect, it } from "vitest";
import { tableClipboardMatchesTarget, tableClipboardSourceContext } from "@/lib/table/tableClipboard";

describe("table clipboard contexts", () => {
  const source = { connectionId: "source", database: "app", schema: "public" };

  it("returns the shared source context for tables copied together", () => {
    expect(tableClipboardSourceContext([source, { ...source }])).toEqual(source);
  });

  it("rejects a clipboard that combines different source contexts", () => {
    expect(tableClipboardSourceContext([source, { ...source, schema: "audit" }])).toBeNull();
  });

  it("distinguishes a cross-schema target from the source", () => {
    expect(tableClipboardMatchesTarget([source], { ...source, schema: "archive" })).toBe(false);
  });
});
