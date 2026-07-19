import assert from "node:assert/strict";
import { test } from "vitest";
import { sortContributorActivity, type ContributorActivityData } from "./contributorActivity";

const data: ContributorActivityData = {
  repository: "t8y2/dbx",
  generatedAt: "2026-07-19T00:00:00.000Z",
  stars: 100,
  contributors: [
    {
      login: "reviewer",
      avatarUrl: "https://example.com/reviewer.png",
      profileUrl: "https://github.com/reviewer",
      commits: 2,
      mergedPullRequests: 3,
      firstContributionAt: null,
      latestContributionAt: null,
    },
  ],
};

test("sortContributorActivity ranks eligible contributors by commits", () => {
  const sorted = sortContributorActivity([
    { ...data.contributors[0], login: "newcomer", commits: 99, mergedPullRequests: 1 },
    data.contributors[0],
  ]);

  assert.equal(sorted[0].login, "newcomer");
});
