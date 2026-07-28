import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repository = process.env.DBX_GITHUB_REPOSITORY || "t8y2/dbx";
const token = process.env.GITHUB_TOKEN;
const apiBase = "https://api.github.com";
const outputPath = resolve(import.meta.dirname, "../data/contributors.json");

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "dbx-contributor-sync",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [url, rel] = part.split(";").map((value) => value.trim());
    if (rel === 'rel="next"') return url.slice(1, -1);
  }
  return null;
}

async function request(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 240)}`);
  }
  return response;
}

async function fetchAll(path) {
  const records = [];
  let url = `${apiBase}${path}${path.includes("?") ? "&" : "?"}per_page=100`;

  while (url) {
    const response = await request(url);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Expected an array from ${url}`);
    records.push(...page);
    url = nextLink(response.headers.get("Link"));
  }

  return records;
}

function isBot(user) {
  return !user?.login || user.type === "Bot" || user.login.endsWith("[bot]");
}

function updateDate(record, date) {
  if (!date) return;
  if (!record.firstContributionAt || date < record.firstContributionAt) record.firstContributionAt = date;
  if (!record.latestContributionAt || date > record.latestContributionAt) record.latestContributionAt = date;
}

function ensureContributor(contributors, user) {
  const key = user.login.toLowerCase();
  let contributor = contributors.get(key);
  if (!contributor) {
    contributor = {
      login: user.login,
      avatarUrl: user.avatar_url || `https://github.com/${user.login}.png`,
      profileUrl: user.html_url || `https://github.com/${user.login}`,
      commits: 0,
      mergedPullRequests: 0,
      firstContributionAt: null,
      latestContributionAt: null,
    };
    contributors.set(key, contributor);
  }
  return contributor;
}

const [repositoryInfo, commitContributors, pullRequests] = await Promise.all([
  request(`${apiBase}/repos/${repository}`).then((response) => response.json()),
  fetchAll(`/repos/${repository}/contributors?anon=0`),
  fetchAll(`/repos/${repository}/pulls?state=closed&sort=created&direction=desc`),
]);

const contributors = new Map();

for (const pullRequest of pullRequests) {
  if (!pullRequest.merged_at || isBot(pullRequest.user)) continue;
  const contributor = ensureContributor(contributors, pullRequest.user);
  contributor.mergedPullRequests += 1;
  updateDate(contributor, pullRequest.created_at);
  updateDate(contributor, pullRequest.merged_at);
}

for (const entry of commitContributors) {
  if (isBot(entry)) continue;
  // Commit counts enrich merged-PR contributors but never grant eligibility alone.
  const contributor = contributors.get(entry.login.toLowerCase());
  if (contributor) contributor.commits = entry.contributions || 0;
}

const rankedContributors = [...contributors.values()].filter((contributor) => contributor.mergedPullRequests > 0).sort((left, right) => {
  return right.commits - left.commits || right.mergedPullRequests - left.mergedPullRequests || left.login.localeCompare(right.login);
});

const output = {
  repository,
  generatedAt: new Date().toISOString(),
  stars: repositoryInfo.stargazers_count || 0,
  contributors: rankedContributors,
};

await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${rankedContributors.length} contributors to ${outputPath}`);
