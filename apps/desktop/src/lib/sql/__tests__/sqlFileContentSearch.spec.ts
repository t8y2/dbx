import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlFileContentSearchResult } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  search: vi.fn(async (_roots: string[], _query: string, _filter: string): Promise<SqlFileContentSearchResult> => ({ files: [], skippedFiles: [], truncated: false })),
}));
vi.mock("@/lib/backend/api", () => ({ searchSqlFileContents: mocks.search }));

import { contentMatchPathSet, searchSqlFileContents } from "../sqlFileContentSearch";

beforeEach(() => {
  mocks.search.mockReset();
  mocks.search.mockResolvedValue({ files: [], skippedFiles: [], truncated: false });
});

describe("searchSqlFileContents", () => {
  it("forwards the exact tree filter, including extensionless names", async () => {
    await searchSqlFileContents({ roots: ["/sql", "/more"], query: " users ", fileFilter: "(?i)(\\.sql$|^README$)" });
    expect(mocks.search).toHaveBeenCalledWith(["/sql", "/more"], "users", "(?i)(\\.sql$|^README$)");
  });

  it("skips empty queries and empty roots", async () => {
    expect((await searchSqlFileContents({ roots: ["/sql"], query: "   ", fileFilter: "*.sql" })).matchesByPath.size).toBe(0);
    expect((await searchSqlFileContents({ roots: [" "], query: "users", fileFilter: "*.sql" })).matchesByPath.size).toBe(0);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("normalizes paths and preserves hits after the preview budget is exhausted", async () => {
    const response: SqlFileContentSearchResult = {
      files: [{ path: "C:\\sql\\a.sql", matches: [], totalMatches: 1200 }],
      skippedFiles: [{ path: "C:/sql/large.sql", reason: "tooLarge" }],
      truncated: true,
    };
    mocks.search.mockResolvedValue(response);
    const result = await searchSqlFileContents({ roots: ["C:/sql"], query: "users", fileFilter: "*.sql" });
    expect(result.matchesByPath.get("C:/sql/a.sql")?.totalMatches).toBe(1200);
    expect(result.skippedFiles).toEqual(response.skippedFiles);
    expect(result.truncated).toBe(true);
    expect(contentMatchPathSet(result)).toEqual(new Set(["C:/sql/a.sql"]));
    expect(contentMatchPathSet(null).size).toBe(0);
  });

  it("surfaces failures instead of silently changing the search scope", async () => {
    mocks.search.mockRejectedValue(new Error("unavailable"));
    await expect(searchSqlFileContents({ roots: ["/sql"], query: "users", fileFilter: "*.sql" })).rejects.toThrow("unavailable");
  });
});
