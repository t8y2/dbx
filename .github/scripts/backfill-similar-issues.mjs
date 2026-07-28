#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { GitHubClient, run } from "./suggest-similar-issues.mjs";

const DEFAULT_SEARCH_DELAY_MS = 7000;

function integerValue(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function selectChunk(issues, { chunkIndex, chunkCount, maxIssues = 0 }) {
  if (!Number.isInteger(chunkCount) || chunkCount < 1) throw new Error("chunkCount must be at least 1");
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new Error("chunkIndex must be within chunkCount");
  }

  const selected = [...issues]
    .sort((left, right) => right.number - left.number)
    // Issue-number partitioning stays stable if new issues arrive while the
    // serial matrix jobs are processing the backlog.
    .filter((issue) => issue.number % chunkCount === chunkIndex);
  return maxIssues > 0 ? selected.slice(0, maxIssues) : selected;
}

export async function listOpenUnassignedIssues(client) {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const items = await client.request(
      "GET",
      `/repos/${client.repository}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    issues.push(...items.filter((issue) => !issue.pull_request && (issue.assignees || []).length === 0));
    if (items.length < 100) break;
  }
  return issues;
}

export async function backfill({
  client,
  chunkIndex,
  chunkCount,
  maxIssues = 0,
  searchDelayMs = DEFAULT_SEARCH_DELAY_MS,
}) {
  const issues = selectChunk(await listOpenUnassignedIssues(client), { chunkIndex, chunkCount, maxIssues });
  const originalSearchIssues = client.searchIssues.bind(client);
  let lastSearchStartedAt = 0;
  client.searchIssues = async (query) => {
    const remainingDelay = searchDelayMs - (Date.now() - lastSearchStartedAt);
    if (remainingDelay > 0) await sleep(remainingDelay);
    lastSearchStartedAt = Date.now();
    return originalSearchIssues(query);
  };

  let suggestedIssues = 0;
  let suggestionCount = 0;
  const failures = [];
  try {
    for (const [index, issue] of issues.entries()) {
      console.log(`[${index + 1}/${issues.length}] Processing #${issue.number}: ${issue.title}`);
      try {
        const candidates = await run({ issue, client });
        if (candidates.length > 0) {
          suggestedIssues += 1;
          suggestionCount += candidates.length;
        }
      } catch (error) {
        failures.push({ number: issue.number, message: error instanceof Error ? error.message : String(error) });
        console.error(`Failed to process #${issue.number}: ${failures.at(-1).message}`);
      }
    }
  } finally {
    client.searchIssues = originalSearchIssues;
  }

  const summary = { processed: issues.length, suggestedIssues, suggestionCount, failures };
  console.log(`Backfill summary: ${JSON.stringify(summary)}`);
  if (failures.length > 0) throw new Error(`Backfill completed with ${failures.length} failed issue(s)`);
  return summary;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const client = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiBase: process.env.GITHUB_API_URL,
  });
  await backfill({
    client,
    chunkIndex: integerValue(process.env.BACKFILL_CHUNK_INDEX, 0, "BACKFILL_CHUNK_INDEX"),
    chunkCount: integerValue(process.env.BACKFILL_CHUNK_COUNT, 1, "BACKFILL_CHUNK_COUNT"),
    maxIssues: integerValue(process.env.BACKFILL_MAX_ISSUES, 0, "BACKFILL_MAX_ISSUES"),
    searchDelayMs: integerValue(
      process.env.BACKFILL_SEARCH_DELAY_MS,
      DEFAULT_SEARCH_DELAY_MS,
      "BACKFILL_SEARCH_DELAY_MS",
    ),
  });
}
