import { describe, expect, it } from "vitest";
import { createForeignKeyDrafts } from "../tableStructureEditorState";
import type { ForeignKeyInfo } from "@/types/database";

const rows: ForeignKeyInfo[] = [
  { name: "FK_SOURCE", column: "B,quoted", ref_schema: "Parent Owner", ref_table: "Parent,Table", ref_column: 'V"quoted', on_delete: "CASCADE", on_update: null },
  { name: "FK_SOURCE", column: " A ", ref_schema: "Parent Owner", ref_table: "Parent,Table", ref_column: " ID ", on_delete: "CASCADE", on_update: null },
];

describe("Oracle ordered foreign key drafts", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("preserves exact metadata pairs for %s", (engine) => {
    const drafts = createForeignKeyDrafts(rows, engine);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.columns).toEqual(["B,quoted", " A "]);
    expect(drafts[0]?.refColumns).toEqual(['V"quoted', " ID "]);
  });

  it("rejects inconsistent rows of one Oracle constraint", () => {
    expect(() => createForeignKeyDrafts([rows[0]!, { ...rows[1]!, ref_table: "Other" }], "oracle")).toThrow();
  });

  it("keeps the existing string contract for other engines", () => {
    const drafts = createForeignKeyDrafts(rows);
    expect(drafts[0]?.column).toBe("B,quoted,  A ");
    expect(drafts[0]?.columns).toBeUndefined();
  });
});
