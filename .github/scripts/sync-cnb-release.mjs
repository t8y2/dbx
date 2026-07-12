#!/usr/bin/env node

import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const DEFAULT_API_BASE = "https://api.cnb.cool";
const DEFAULT_REPOSITORY = "dbxio.com/dbx";
const DEFAULT_CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const githubRelease = JSON.parse(readFileSync(args.githubReleasePath, "utf8"));
  const tag = githubRelease.tagName || githubRelease.tag_name;
  if (!tag) throw new Error("GitHub release JSON is missing tagName.");

  const client = new CnbClient(args);
  const release = await client.ensureRelease(tag, githubRelease);
  const existingAssets = new Set((release.assets || []).map((asset) => asset.name));
  const assets = localAssets(args.assetsDir).filter((assetPath) => {
    const name = basename(assetPath);
    if (existingAssets.has(name)) {
      console.log(`Skipping existing CNB asset: ${name}`);
      return false;
    }
    return true;
  });

  console.log(`Uploading ${assets.length} CNB asset(s) with concurrency ${args.concurrency}.`);
  await mapWithConcurrency(assets, args.concurrency, (assetPath) => uploadWithRetry(client, release.id, assetPath));
}

function parseArgs(argv) {
  const args = {
    apiBase: process.env.CNB_API_BASE || DEFAULT_API_BASE,
    repository: process.env.CNB_REPOSITORY || DEFAULT_REPOSITORY,
    token: process.env.CNB_TOKEN || "",
    concurrency: Number.parseInt(process.env.CNB_UPLOAD_CONCURRENCY || `${DEFAULT_CONCURRENCY}`, 10),
    githubReleasePath: "",
    assetsDir: "",
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--github-release") args.githubReleasePath = argv[++index];
    else if (arg === "--assets-dir") args.assetsDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.token) throw new Error("CNB_TOKEN is required.");
  if (!args.githubReleasePath || !args.assetsDir) {
    throw new Error("Usage: sync-cnb-release.mjs --github-release <release.json> --assets-dir <dir>");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("CNB_UPLOAD_CONCURRENCY must be a positive integer.");
  }
  return args;
}

async function uploadWithRetry(client, releaseId, filePath) {
  const name = basename(filePath);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`Uploading ${name}, attempt ${attempt}/${MAX_ATTEMPTS}.`);
      await client.uploadAsset(releaseId, filePath);
      console.log(`Uploaded ${name}.`);
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      const delayMs = 2 ** (attempt - 1) * 5000;
      console.warn(`Upload failed for ${name}: ${error.message}; retrying in ${delayMs / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

class CnbClient {
  constructor({ apiBase, repository, token }) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.repository = repository;
    this.token = token;
  }

  async ensureRelease(tag, githubRelease) {
    const payload = {
      tag_name: tag,
      name: githubRelease.name || tag,
      body: githubRelease.body || "",
      prerelease: Boolean(githubRelease.isPrerelease || githubRelease.prerelease),
      target_commitish: githubRelease.targetCommitish || githubRelease.target_commitish || "",
    };
    const existing = await this.request("GET", `/${this.repository}/-/releases/tags/${encodeURIComponent(tag)}`, null, true);
    if (!existing) return this.request("POST", `/${this.repository}/-/releases`, payload);

    // Keep release metadata aligned while preserving the existing asset list used for resumable uploads.
    await this.request("PATCH", `/${this.repository}/-/releases/${existing.id}`, {
      name: payload.name,
      body: payload.body,
    });
    return existing;
  }

  async uploadAsset(releaseId, filePath) {
    const size = statSync(filePath).size;
    const target = await this.request("POST", `/${this.repository}/-/releases/${releaseId}/asset-upload-url`, {
      asset_name: basename(filePath),
      size,
      overwrite: false,
    });
    const uploadResponse = await fetch(target.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": `${size}` },
      body: createReadStream(filePath),
      duplex: "half",
    });
    if (!uploadResponse.ok) {
      throw new Error(`CNB object upload failed with ${uploadResponse.status}: ${await uploadResponse.text()}`);
    }
    const verifyResponse = await fetch(decodeURIComponent(target.verify_url), {
      method: "POST",
      headers: this.headers(),
    });
    if (!verifyResponse.ok) {
      throw new Error(`CNB upload confirmation failed with ${verifyResponse.status}: ${await verifyResponse.text()}`);
    }
  }

  async request(method, path, body = null, allow404 = false) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: this.headers(body !== null),
      body: body === null ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`CNB API ${method} ${path} failed with ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }

  headers(json = false) {
    return {
      Accept: "application/vnd.cnb.api+json",
      Authorization: `Bearer ${this.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
}

function localAssets(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((left, right) => statSync(right).size - statSync(left).size || basename(left).localeCompare(basename(right)));
}

async function mapWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
