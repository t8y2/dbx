import { describe, expect, it } from "vitest";
import { tableClipboardMatchesTarget, tableClipboardMenuState, tableClipboardSourceContext } from "@/lib/table/tableClipboard";

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

  it("shows paste for a transferable clipboard from another context", () => {
    const sourceTable = { ...source, tableName: "users" };
    const targetTable = { ...sourceTable, database: "archive" };

    expect(tableClipboardMenuState([sourceTable], targetTable)).toBe("copy");
    expect(tableClipboardMenuState([sourceTable], targetTable, true)).toBe("copy-and-paste");
  });
});
