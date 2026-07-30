#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { CnbClient } from "./sync-cnb-release.mjs";

const DEFAULT_API_BASE = "https://api.cnb.cool";
const DEFAULT_REPOSITORY = "dbxio.com/dbx";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new CnbClient(args);
  await pruneOldReleases(client, args);
}

function parseArgs(argv) {
  const args = {
    apiBase: process.env.CNB_API_BASE || DEFAULT_API_BASE,
    repository: process.env.CNB_REPOSITORY || DEFAULT_REPOSITORY,
    token: process.env.CNB_TOKEN || "",
    currentTag: "",
    tagPattern: "",
    retain: 0,
    apply: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--current-tag") args.currentTag = argv[++index];
    else if (arg === "--tag-pattern") args.tagPattern = argv[++index];
    else if (arg === "--retain") args.retain = Number.parseInt(argv[++index], 10);
    else if (arg === "--apply") args.apply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.token) throw new Error("CNB_TOKEN is required.");
  if (!args.currentTag || !args.tagPattern || !Number.isInteger(args.retain) || args.retain < 1) {
    throw new Error(
      "Usage: cleanup-cnb-releases.mjs --current-tag <tag> --tag-pattern <regex> --retain <count> [--apply]",
    );
  }
  try {
    new RegExp(args.tagPattern);
  } catch (error) {
    throw new Error(`Invalid release tag pattern: ${error.message}`);
  }
  return args;
}

export function planReleaseRetention(releases, { currentTag, tagPattern, retain }) {
  const pattern = new RegExp(tagPattern);
  const family = releases
    .map(normalizeRelease)
    .filter((release) => pattern.test(release.tag))
    .sort(compareReleasesNewestFirst);

  if (!pattern.test(currentTag)) {
    return { keep: [], remove: [], skipped: `Current tag ${currentTag} is outside the retention family.` };
  }
  if (family.length < retain) {
    return {
      keep: family,
      remove: [],
      skipped: `Found only ${family.length} matching release(s); at least ${retain} are required before cleanup.`,
    };
  }

  const keep = family.slice(0, retain);
  if (!keep.some((release) => release.tag === currentTag)) {
    return {
      keep,
      remove: [],
      skipped: `Current tag ${currentTag} is not among the latest ${retain} releases.`,
    };
  }
  return { keep, remove: family.slice(retain), skipped: "" };
}

export async function pruneOldReleases(client, { currentTag, tagPattern, retain, apply }) {
  const plan = planReleaseRetention(await client.listReleases(), { currentTag, tagPattern, retain });
  console.log(`Keeping CNB releases: ${plan.keep.map((release) => release.tag).join(", ") || "none"}`);
  if (plan.skipped) {
    console.warn(`Skipping CNB release cleanup: ${plan.skipped}`);
    return plan;
  }
  if (!plan.remove.length) {
    console.log("No old CNB releases to remove.");
    return plan;
  }

  for (const release of plan.remove) {
    if (!apply) {
      console.log(`Would delete old CNB release: ${release.tag} (${release.id})`);
      continue;
    }
    await client.deleteRelease(release.id);
    console.log(`Deleted old CNB release: ${release.tag} (${release.id})`);
  }
  return plan;
}

function normalizeRelease(release) {
  const id = release.id;
  const tag = release.tag_name || release.tagName;
  const publishedAt = release.published_at || release.publishedAt || release.created_at || release.createdAt;
  if (!id || !tag || !publishedAt) throw new Error("CNB release metadata is missing id, tag, or publish time.");
  const publishedTime = Date.parse(publishedAt);
  if (!Number.isFinite(publishedTime)) throw new Error(`CNB release ${tag} has an invalid publish time: ${publishedAt}`);
  return { id, tag, publishedAt, publishedTime };
}

function compareReleasesNewestFirst(left, right) {
  return right.publishedTime - left.publishedTime || right.tag.localeCompare(left.tag, undefined, { numeric: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
