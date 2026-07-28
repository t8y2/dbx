import assert from "node:assert/strict";
import { test } from "vitest";
import { contributorsFromActivity, dedupeContributors, type Contributor } from "./contributors";

const contributor = (login: string): Contributor => ({
  login,
  avatar_url: `https://avatars.githubusercontent.com/${login}`,
  html_url: `https://github.com/${login}`,
  contributions: 1,
});

test("dedupeContributors removes duplicate GitHub logins case-insensitively", () => {
  const first = contributor("BlueSkyXN");

  assert.deepEqual(dedupeContributors([first, contributor("blueskyxn"), contributor("other")]), [first, contributor("other")]);
});

test("dedupeContributors preserves the original contributor order", () => {
  const contributors = [contributor("first"), contributor("second"), contributor("third")];

  assert.deepEqual(dedupeContributors(contributors), contributors);
});

test("contributorsFromActivity strips snapshot-only fields from landing data", () => {
  assert.deepEqual(
    contributorsFromActivity([
      {
        login: "builder",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        profileUrl: "https://github.com/builder",
        commits: 42,
        mergedPullRequests: 7,
        firstContributionAt: "2026-01-01T00:00:00Z",
        latestContributionAt: "2026-07-01T00:00:00Z",
      },
    ]),
    [
      {
        login: "builder",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/builder",
        contributions: 42,
      },
    ],
  );
});
