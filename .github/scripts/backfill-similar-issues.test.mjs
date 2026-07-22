import assert from "node:assert/strict";
import test from "node:test";

import {
  backfill,
  listOpenUnassignedIssues,
  selectChunk,
} from "./backfill-similar-issues.mjs";

test("selectChunk partitions issue numbers deterministically", () => {
  const issues = [1, 2, 3, 4, 5, 6].map((number) => ({ number }));

  assert.deepEqual(selectChunk(issues, { chunkIndex: 0, chunkCount: 3 }).map(({ number }) => number), [6, 3]);
  assert.deepEqual(selectChunk(issues, { chunkIndex: 1, chunkCount: 3 }).map(({ number }) => number), [4, 1]);
  assert.deepEqual(
    selectChunk(issues, { chunkIndex: 2, chunkCount: 3, maxIssues: 1 }).map(({ number }) => number),
    [5],
  );
});

test("listOpenUnassignedIssues filters pull requests and assigned issues across pages", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    assignees: index === 0 ? [{ login: "owner" }] : [],
    ...(index === 1 ? { pull_request: { url: "https://example.test/pr/2" } } : {}),
  }));
  const client = {
    repository: "t8y2/dbx",
    request: async (_method, path) => {
      const page = new URL(path, "https://api.github.test").searchParams.get("page");
      return page === "1" ? firstPage : [{ number: 101, assignees: [] }];
    },
  };

  const issues = await listOpenUnassignedIssues(client);
  assert.equal(issues.length, 99);
  assert.equal(issues.some(({ number }) => number === 1), false);
  assert.equal(issues.some(({ number }) => number === 2), false);
  assert.equal(issues.at(-1).number, 101);
});

test("backfill skips existing comments and searches only its chunk", async () => {
  const searchedTitles = [];
  const client = {
    repository: "t8y2/dbx",
    request: async () => [
      { number: 6, title: "six", body: "body", labels: [], assignees: [] },
      { number: 5, title: "five", body: "body", labels: [], assignees: [] },
      { number: 3, title: "three", body: "body", labels: [], assignees: [] },
    ],
    hasExistingComment: async (number) => number === 6,
    searchIssues: async (query) => {
      searchedTitles.push(query);
      return { search_type: "hybrid", items: [] };
    },
    comment: async () => {
      throw new Error("comment should not be called");
    },
  };

  const summary = await backfill({ client, chunkIndex: 0, chunkCount: 3, searchDelayMs: 0 });
  assert.deepEqual(summary, { processed: 2, suggestedIssues: 0, suggestionCount: 0, failures: [] });
  assert.deepEqual(searchedTitles, ["three"]);
});
