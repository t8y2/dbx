import { describe, expect, it } from "vitest";
import { externalSqlFileDisplayTitles, normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

describe("external SQL file paths", () => {
  it("normalizes Windows separators for identity checks", () => {
    expect(normalizeExternalSqlPath(" C:\\work\\demo.sql ")).toBe("C:/work/demo.sql");
  });

  it("uses the shortest unique parent path for duplicate filenames", () => {
    expect(externalSqlFileDisplayTitles(["/work/demo/create.sql", "/work/learn/create.sql", "/work/query.sql"])).toEqual(["demo/create.sql", "learn/create.sql", "query.sql"]);
  });

  it("adds more parent segments when immediate parents also collide", () => {
    expect(externalSqlFileDisplayTitles(["/one/sql/create.sql", "/two/sql/create.sql"])).toEqual(["one/sql/create.sql", "two/sql/create.sql"]);
  });
});
