#!/usr/bin/env node

import { basename, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE = "https://api.atomgit.com/api/v5";
const DEFAULT_REPOSITORY = "t8y2/dbx";
const DEFAULT_CONCURRENCY = 3;

function parseArgs(argv) {
  const args = {
    apiBase: process.env.ATOMGIT_API_BASE || DEFAULT_API_BASE,
    repository: process.env.ATOMGIT_REPOSITORY || DEFAULT_REPOSITORY,
    token: process.env.ATOMGIT_TOKEN || "",
    githubReleasePath: "",
    assetsDir: "",
    skipExistingAssets: true,
    concurrency: Number.parseInt(process.env.ATOMGIT_UPLOAD_CONCURRENCY || `${DEFAULT_CONCURRENCY}`, 10),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--github-release") {
      args.githubReleasePath = argv[++i];
    } else if (arg === "--assets-dir") {
      args.assetsDir = argv[++i];
    } else if (arg === "--repository") {
      args.repository = argv[++i];
    } else if (arg === "--api-base") {
      args.apiBase = argv[++i];
    } else if (arg === "--replace-assets") {
      args.skipExistingAssets = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.token) {
    throw new Error("ATOMGIT_TOKEN is required.");
  }
  if (!args.githubReleasePath || !args.assetsDir) {
    throw new Error("Usage: sync-atomgit-release.mjs --github-release <release.json> --assets-dir <dir>");
  }
  if (!args.repository.includes("/")) {
    throw new Error(`Invalid AtomGit repository: ${args.repository}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("ATOMGIT_UPLOAD_CONCURRENCY must be a positive integer.");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [owner, repo] = args.repository.split("/", 2);
  const release = JSON.parse(readFileSync(args.githubReleasePath, "utf8"));
  const tag = release.tagName || release.tag_name;
  if (!tag) {
    throw new Error("GitHub release JSON is missing tagName.");
  }

  const client = new AtomGitClient({ apiBase: args.apiBase, token: args.token, owner, repo });
  const atomRelease = await ensureRelease(client, release);
  // PATCH responses may omit attachments, so re-read before deciding what must be replaced.
  const existingAssets = atomGitAssets((await client.getRelease(tag)) || atomRelease);
  const assets = localAssets(args.assetsDir);
  if (assets.length === 0) {
    console.log("No release assets found to sync.");
    return;
  }

  const pendingAssets = assets.filter((assetPath) => {
    const name = basename(assetPath);
    if (args.skipExistingAssets && existingAssets.has(name)) {
      console.log(`Skipping existing AtomGit asset: ${name}`);
      return false;
    }
    return true;
  });

  if (!args.skipExistingAssets) {
    for (const assetPath of pendingAssets) {
      const name = basename(assetPath);
      const existingAsset = existingAssets.get(name);
      if (!existingAsset) continue;
      if (existingAsset.id === null) {
        throw new Error(`Cannot replace AtomGit asset without an attachment id: ${name}`);
      }
      console.log(`Deleting existing AtomGit asset: ${name}`);
      await client.deleteAsset(tag, existingAsset.id);
    }
  }

  console.log(`Uploading ${pendingAssets.length} asset(s) with concurrency ${args.concurrency}.`);
  await mapWithConcurrency(pendingAssets, args.concurrency, (assetPath) => uploadAsset(client, tag, assetPath));

  const refreshedRelease = await client.getRelease(tag);
  const uploadedAssets = atomGitAssets(refreshedRelease);
  const missingAssets = pendingAssets.map(basename).filter((name) => !uploadedAssets.has(name));
  if (missingAssets.length > 0) {
    throw new Error(`AtomGit did not register uploaded assets: ${missingAssets.join(", ")}`);
  }
}

async function ensureRelease(client, githubRelease) {
  const tag = githubRelease.tagName || githubRelease.tag_name;
  const payload = {
    tag_name: tag,
    name: githubRelease.name || tag,
    body: githubRelease.body || "",
    target_commitish: githubRelease.targetCommitish || githubRelease.target_commitish || "",
    prerelease: Boolean(githubRelease.isPrerelease || githubRelease.prerelease),
  };

  const existing = await client.getRelease(tag);
  if (existing) {
    console.log(`Updating existing AtomGit release: ${tag}`);
    return client.updateRelease(tag, payload);
  }

  console.log(`Creating AtomGit release: ${tag}`);
  return client.createRelease(payload);
}

async function uploadAsset(client, tag, filePath) {
  const name = basename(filePath);
  const size = statSync(filePath).size;
  console.log(`Uploading ${name} (${size} bytes)`);
  const uploadTarget = await client.getUploadTarget(tag, name);
  const contentType = contentTypeFor(name);
  const uploadHeaders = uploadTarget.headers.length > 0
    ? uploadTarget.headers
    : [
        ["Authorization", `Bearer ${client.token}`],
        ["X-Api-Version", "2023-02-21"],
      ];
  const contentTypeHeader = headerValue(uploadHeaders, "Content-Type") || contentType;
  const curlHeaders = uploadHeaders
    .filter(([key]) => key.toLowerCase() !== "content-type")
    .flatMap(([key, value]) => ["--header", `${key}: ${value}`]);

  // AtomGit returns a per-file upload URL plus required upload headers.
  // Try raw PUT first and fall back to multipart POST for API-compatible deployments.
  const putResult = await runCurl([
    "--fail-with-body",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "3",
    "--retry-delay",
    "5",
    "--request",
    "PUT",
    ...curlHeaders,
    "--header",
    `Content-Type: ${contentTypeHeader}`,
    "--upload-file",
    filePath,
    uploadTarget.url,
  ]);
  if (uploadResultSucceeded(putResult)) {
    return;
  }

  console.warn(`PUT upload failed for ${name}: ${uploadFailureMessage(putResult)}; retrying as multipart POST.`);
  const postResult = await runCurl([
    "--fail-with-body",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "3",
    "--retry-delay",
    "5",
    "--request",
    "POST",
    ...curlHeaders,
    "--form",
    `file=@${filePath};filename=${name};type=${contentTypeHeader}`,
    uploadTarget.url,
  ]);
  if (!uploadResultSucceeded(postResult)) {
    throw new Error(`Failed to upload ${name} to AtomGit: ${uploadFailureMessage(postResult)}`);
  }
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

export function uploadResultSucceeded(result) {
  if (result.status !== 0) return false;
  const responseBody = result.stdout.trim();
  if (!responseBody || responseBody.toLowerCase() === "success") return true;
  try {
    const response = JSON.parse(responseBody);
    return response.success === true || response.status === "success";
  } catch {
    return true;
  }
}

function uploadFailureMessage(result) {
  return result.stderr.trim() || result.stdout.trim() || `curl exited with status ${result.status}`;
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

function localAssets(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(a).size - statSync(b).size || basename(a).localeCompare(basename(b)));
}

export function atomGitAssets(release) {
  const assets = new Map();
  const groups = [
    release?.assets,
    release?.attach_files,
    release?.attachFiles,
    release?.files,
    release?.attachments,
  ];
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const item of group) {
      const name = item?.name || item?.file_name || item?.filename || item?.title;
      if (name) {
        assets.set(name, {
          id: Number.isInteger(item?.id) ? item.id : null,
          name,
        });
      }
    }
  }
  return assets;
}

function contentTypeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".gz") || name.endsWith(".tgz")) return "application/gzip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".exe") || name.endsWith(".msi")) return "application/octet-stream";
  if (name.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (name.endsWith(".rpm")) return "application/x-rpm";
  if (name.endsWith(".AppImage")) return "application/octet-stream";
  return "application/octet-stream";
}

function headerValue(headers, name) {
  const normalizedName = name.toLowerCase();
  const entry = headers.find(([key]) => key.toLowerCase() === normalizedName);
  return entry ? entry[1] : "";
}

export class AtomGitClient {
  constructor({ apiBase, token, owner, repo }) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async getRelease(tag) {
    const res = await this.request("GET", `/repos/${this.owner}/${this.repo}/releases/${encodeURIComponent(tag)}`, null, {
      allow404: true,
    });
    if (res.status === 404) {
      return null;
    }
    return parseJsonResponse(res);
  }

  async createRelease(payload) {
    const res = await this.request("POST", `/repos/${this.owner}/${this.repo}/releases`, payload, {
      acceptStatuses: [409, 422],
    });
    if (res.status === 409 || res.status === 422) {
      return this.updateRelease(payload.tag_name, payload);
    }
    return parseJsonResponse(res);
  }

  async updateRelease(tag, payload) {
    const res = await this.request("PATCH", `/repos/${this.owner}/${this.repo}/releases/${encodeURIComponent(tag)}`, payload);
    return parseJsonResponse(res);
  }

  async getUploadTarget(tag, fileName) {
    const params = new URLSearchParams({ file_name: fileName });
    const res = await this.request("GET", `/repos/${this.owner}/${this.repo}/releases/${encodeURIComponent(tag)}/upload_url?${params}`);
    const body = await parseJsonResponse(res);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      console.log(`AtomGit upload_url response keys: ${Object.keys(body).sort().join(", ")}`);
      if (body.headers && typeof body.headers === "object") {
        console.log(`AtomGit upload header keys: ${Object.keys(body.headers).sort().join(", ")}`);
      }
    }
    const uploadUrl = typeof body === "string" ? body : body.url || body.upload_url || body.uploadUrl;
    if (!uploadUrl) {
      throw new Error(`AtomGit upload_url response did not include an upload URL: ${JSON.stringify(body)}`);
    }
    console.log(`AtomGit upload target: ${sanitizeUrlForLog(uploadUrl)}`);
    return {
      url: uploadUrl,
      headers: normalizeUploadHeaders(typeof body === "string" ? null : body.headers),
    };
  }

  async deleteAsset(tag, assetId) {
    await this.request(
      "DELETE",
      `/repos/${this.owner}/${this.repo}/releases/${encodeURIComponent(tag)}/attach_files/${assetId}`,
    );
  }

  async request(method, path, body = null, requestOptions = {}) {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "X-Api-Version": "2023-02-21",
    };
    const fetchOptions = { method, headers };
    if (body) {
      const cleanBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== ""));
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(cleanBody);
    }

    const res = await fetch(`${this.apiBase}${path}`, fetchOptions);
    const acceptedStatus = requestOptions.acceptStatuses?.includes(res.status);
    if (!res.ok && !(requestOptions.allow404 && res.status === 404) && !acceptedStatus) {
      const text = await res.text();
      throw new Error(`AtomGit API ${method} ${path} failed with ${res.status}: ${text}`);
    }
    return res;
  }
}

async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeUploadHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return [];
  }
  return Object.entries(headers)
    .filter(([key, value]) => key && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [key, String(value)]);
}

function sanitizeUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid upload URL>";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
