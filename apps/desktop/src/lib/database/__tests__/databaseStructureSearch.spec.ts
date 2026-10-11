import { describe, expect, it } from "vitest";
import { effectiveDatabaseSearchScope, mapStructureSearchRows, structureHitPreview, supportsDatabaseStructureSearchFromManifest } from "@/lib/database/databaseStructureSearch";

describe("databaseStructureSearch", () => {
  it("maps catalog rows into structure hits", () => {
    const hits = mapStructureSearchRows(
      ["object_schema", "object_name", "column_name", "column_comment"],
      [
        ["public", "users", "email", "User email"],
        ["public", "users", "id", null],
      ],
      "mail",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.columnName).toBe("email");
    expect(hits[0]?.matchedIn).toEqual(["name", "comment"]);
  });

  it("builds previews from structure hits", () => {
    const preview = structureHitPreview({
      tableName: "users",
      columnName: "email",
      columnComment: "Primary contact email",
      matchedIn: ["name", "comment"],
    });
    expect(preview).toContain("email");
    expect(preview).toContain("Primary contact email");
  });

  it("falls back to data scope for unsupported engines", () => {
    expect(effectiveDatabaseSearchScope("structure", "redis")).toBe("data");
    expect(supportsDatabaseStructureSearchFromManifest("redis")).toBe(false);
    expect(supportsDatabaseStructureSearchFromManifest("mysql")).toBe(true);
    expect(supportsDatabaseStructureSearchFromManifest("dameng")).toBe(true);
  });
});
