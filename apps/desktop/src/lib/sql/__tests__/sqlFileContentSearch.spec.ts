import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSearchMatch } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  globalSearch: vi.fn(async (_request: { roots: string[]; query: string; extensions?: string[]; limit?: number; respectIgnoreRules?: boolean; maxDepth?: number }): Promise<GlobalSearchMatch[]> => []),
}));

vi.mock("@/lib/backend/api", () => ({
  globalSearch: mocks.globalSearch,
}));

import { contentMatchPathSet, searchSqlFileContents, SQL_FILE_CONTENT_SEARCH_RESULT_LIMIT, SQL_FILE_SNIPPET_MAX_MATCHES } from "../sqlFileContentSearch";

function hit(overrides: Partial<GlobalSearchMatch> & { path: string; line: number; column: number }): GlobalSearchMatch {
  const fileName = overrides.path.split("/").pop() ?? overrides.path;
  return {
    fileName,
    matchText: "users",
    lineText: "SELECT * FROM users",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.globalSearch.mockReset();
  mocks.globalSearch.mockResolvedValue([]);
});

describe("searchSqlFileContents", () => {
  it("asks the backend for the panel's file set (ignore rules disabled) and forwards extensions/limit", async () => {
    await searchSqlFileContents({ roots: ["/sql", "/more"], query: " users ", extensions: ["sql", "ddl"] });

    expect(mocks.globalSearch).toHaveBeenCalledWith({
      roots: ["/sql", "/more"],
      query: "users",
      extensions: ["sql", "ddl"],
      limit: SQL_FILE_CONTENT_SEARCH_RESULT_LIMIT,
      respectIgnoreRules: false,
      maxDepth: undefined,
    });
  });

  it("forwards maxDepth so the walk cannot go deeper than the caller's tree", async () => {
    await searchSqlFileContents({ roots: ["/sql"], query: "users", extensions: ["sql"], maxDepth: 3 });

    expect(mocks.globalSearch).toHaveBeenCalledWith(expect.objectContaining({ maxDepth: 3 }));
  });

  it("skips the request for an empty query or when no roots are configured", async () => {
    expect((await searchSqlFileContents({ roots: ["/sql"], query: "   " })).matchesByPath.size).toBe(0);
    expect((await searchSqlFileContents({ roots: [], query: "users" })).matchesByPath.size).toBe(0);
    expect(mocks.globalSearch).not.toHaveBeenCalled();
  });

  it("groups hits per file, normalizes paths and ignores filename-match sentinels", async () => {
    mocks.globalSearch.mockResolvedValue([
      hit({ path: "C:\\sql\\a.sql", line: 3, column: 15 }),
      hit({ path: "C:/sql/a.sql", line: 1, column: 10 }),
      // line 0 is the backend's filename-match sentinel, not a content hit.
      hit({ path: "C:/sql/b.sql", line: 0, column: 1 }),
      hit({ path: "C:/sql/b.sql", line: 7, column: 2 }),
    ]);

    const result = await searchSqlFileContents({ roots: ["/sql"], query: "users" });

    expect([...result.matchesByPath.keys()]).toEqual(["C:/sql/a.sql", "C:/sql/b.sql"]);
    const a = result.matchesByPath.get("C:/sql/a.sql")!;
    expect(a.matches.map((match) => match.lineNumber)).toEqual([1, 3]);
    expect(a.totalMatches).toBe(2);
    const b = result.matchesByPath.get("C:/sql/b.sql")!;
    expect(b.matches.map((match) => match.lineNumber)).toEqual([7]);
    expect(b.totalMatches).toBe(1);
  });

  it("collapses multiple hits on the same line into one snippet at the first column", async () => {
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/a.sql", line: 2, column: 18 }), hit({ path: "/sql/a.sql", line: 2, column: 4 })]);

    const result = await searchSqlFileContents({ roots: ["/sql"], query: "users" });
    const group = result.matchesByPath.get("/sql/a.sql")!;

    expect(group.matches).toHaveLength(1);
    expect(group.matches[0].column).toBe(4);
    // A same-line repeat is not an extra snippet the user could expand to.
    expect(group.totalMatches).toBe(1);
  });

  it("truncates long lines and highlights the match segments", async () => {
    const longPrefix = "x".repeat(200);
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/a.sql", line: 1, column: longPrefix.length + 1, lineText: `${longPrefix} users trailing` })]);

    const result = await searchSqlFileContents({ roots: ["/sql"], query: "users" });
    const match = result.matchesByPath.get("/sql/a.sql")!.matches[0];

    expect(match.lineText.startsWith("...")).toBe(true);
    expect(match.lineText.length).toBeLessThan(210);
    expect(match.segments.filter((segment) => segment.matched).map((segment) => segment.text)).toEqual(["users"]);
  });

  it("caps snippets per file but keeps counting the total hits", async () => {
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/a.sql", line: 1, column: 1 }), hit({ path: "/sql/a.sql", line: 2, column: 1 }), hit({ path: "/sql/a.sql", line: 3, column: 1 })]);

    const result = await searchSqlFileContents({ roots: ["/sql"], query: "users", limit: 2 });
    const group = result.matchesByPath.get("/sql/a.sql")!;

    expect(group.matches).toHaveLength(2);
    expect(group.totalMatches).toBe(3);
  });

  it("caps snippets at SQL_FILE_SNIPPET_MAX_MATCHES per file while counting every hit line", async () => {
    mocks.globalSearch.mockResolvedValue(Array.from({ length: 150 }, (_, index) => hit({ path: "/sql/a.sql", line: index + 1, column: 1 })));

    const result = await searchSqlFileContents({ roots: ["/sql"], query: "users" });
    const group = result.matchesByPath.get("/sql/a.sql")!;

    expect(group.matches).toHaveLength(SQL_FILE_SNIPPET_MAX_MATCHES);
    expect(group.totalMatches).toBe(150);
    expect(mocks.globalSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: SQL_FILE_CONTENT_SEARCH_RESULT_LIMIT }));
  });

  it("exposes the matched path set for the tree filter", async () => {
    mocks.globalSearch.mockResolvedValue([hit({ path: "C:\\sql\\a.sql", line: 1, column: 1 })]);
    const result = await searchSqlFileContents({ roots: ["C:\\sql"], query: "users" });

    expect(contentMatchPathSet(result)).toEqual(new Set(["C:/sql/a.sql"]));
    expect(contentMatchPathSet(null).size).toBe(0);
  });
});
