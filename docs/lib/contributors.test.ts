import assert from "node:assert/strict";
import { test } from "vitest";
import { dedupeContributors, type Contributor } from "./contributors";

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
